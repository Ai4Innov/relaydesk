import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { Collection, KnowledgeSource } from "../../shared/contracts";
import { classifyLink, listRemote, safeName, type RemoteFile } from "./remote";

export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  key: string;
  path: string;
  name: string;
  url?: string;
  size?: number;
  revision?: string;
  hash?: string;
  status: "indexed" | "skipped" | "failed";
  reason?: string;
  text: string;
  updatedAt: string;
}
export interface KnowledgeVault {
  get<T>(collection: Collection, id: string): T | undefined;
  put<T>(collection: Collection, id: string, value: T): void;
  all<T>(collection: Collection): T[];
  delete(collection: Collection, id: string): void;
}
export interface Extracted { segments: { text: string; location: string }[]; status?: string; reason?: string }
export interface KnowledgeHooks {
  extract(bytes: Buffer, file: { name: string; mimeType: string }, signal: AbortSignal): Promise<Extracted>;
  changed(): void;
  paused?(): boolean;
  fetcher?: typeof fetch;
  now?(): number;
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "ini", "html", "htm", "rst", "tex", "eml"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx", "zip"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "__pycache__", "$recycle.bin", "system volume information"]);
export const KNOWLEDGE_LIMITS = { files: 2000, walk: 20000, depth: 12, fileBytes: 50 * 1024 * 1024, textBytes: 5 * 1024 * 1024, characters: 300_000 };
const FOLDER_RESYNC_MS = 10 * 60_000;
const LINK_RESYNC_MS = 6 * 60 * 60_000;
const now = () => new Date().toISOString();
const extension = (name: string) => name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
const MIME: Record<string, string> = {
  pdf: "application/pdf", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

export function knowledgeFormat(name: string): "text" | "document" | undefined {
  const ext = extension(name);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return undefined;
}
function plainText(bytes: Buffer, name: string): string {
  let text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (/^html?$/.test(extension(name)))
    text = text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n");
  return text;
}
const terms = (query: string) => [...new Set(query.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))].slice(0, 12);
const fold = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** Local folders and public shared links indexed as read-only reference documents for the assistant. */
export class KnowledgeLibrary {
  private running = new Map<string, AbortController>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly vault: KnowledgeVault, private readonly hooks: KnowledgeHooks) {}

  sources(): KnowledgeSource[] {
    return this.vault.all<KnowledgeSource>("knowledge").map((source): KnowledgeSource => this.running.has(source.id) ? source : source.status === "syncing"
      ? { ...source, status: "error", error: "Sync was interrupted. Sync again to resume." } : source)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  addFolder(path: string, name?: string): KnowledgeSource {
    if (this.sources().some(source => source.kind === "folder" && source.location.toLowerCase() === path.toLowerCase()))
      throw new Error("This folder is already added.");
    return this.add({ kind: "folder", provider: "local", location: path, name: (name?.trim() || basename(path) || path).slice(0, 120) });
  }

  addLink(url: string, name?: string): KnowledgeSource {
    // Validates the link shape before anything is stored or fetched.
    const { provider } = classifyLink(url);
    if (this.sources().some(source => source.kind === "link" && source.location === url.trim())) throw new Error("This link is already added.");
    return this.add({ kind: "link", provider, location: url.trim(), name: (name?.trim() || "Shared link").slice(0, 120) });
  }

  private add(input: Pick<KnowledgeSource, "kind" | "provider" | "location" | "name">): KnowledgeSource {
    if (this.vault.all<KnowledgeSource>("knowledge").length >= 50) throw new Error("Remove a folder or link before adding more (50 maximum).");
    const source: KnowledgeSource = { id: randomUUID(), ...input, aiEnabled: true, addedAt: now(), status: "idle", files: 0, indexed: 0, skipped: 0, failed: 0 };
    this.vault.put("knowledge", source.id, source);
    this.hooks.changed();
    return source;
  }

  update(id: string, patch: { aiEnabled?: boolean; name?: string }): void {
    const source = this.require(id);
    this.vault.put("knowledge", id, { ...source, ...(patch.aiEnabled !== undefined ? { aiEnabled: patch.aiEnabled } : {}),
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 120) } : {}) });
    this.hooks.changed();
  }

  remove(id: string): void {
    this.require(id);
    this.running.get(id)?.abort(new Error("Source removed."));
    for (const document of this.documents(id)) this.vault.delete("documents", document.id);
    this.vault.delete("knowledge", id);
    this.hooks.changed();
  }

  private require(id: string): KnowledgeSource {
    const source = this.vault.get<KnowledgeSource>("knowledge", id);
    if (!source) throw new Error("This folder or link was removed.");
    return source;
  }

  private documents(sourceId: string): KnowledgeDocument[] {
    return this.vault.all<KnowledgeDocument>("documents").filter(document => document.sourceId === sourceId);
  }

  /** Queues a sync; sources sync one at a time so large folders never compete for the parser. */
  sync(id: string): Promise<void> {
    this.require(id);
    if (this.running.has(id)) return Promise.resolve();
    const controller = new AbortController();
    this.running.set(id, controller);
    this.patch(id, { status: "syncing", progress: "Waiting to sync…", error: undefined });
    const work = this.queue.then(() => this.run(id, controller.signal)).finally(() => { this.running.delete(id); this.hooks.changed(); });
    this.queue = work.catch(() => {});
    return work;
  }

  /** Called periodically: re-scan folders every 10 minutes and links every 6 hours. */
  syncDue(): void {
    if (this.hooks.paused?.()) return;
    const time = this.hooks.now?.() ?? Date.now();
    for (const source of this.sources()) {
      if (this.running.has(source.id)) continue;
      const last = Date.parse(source.lastSyncAt ?? "") || 0;
      if (time - last >= (source.kind === "folder" ? FOLDER_RESYNC_MS : LINK_RESYNC_MS)) void this.sync(source.id).catch(() => {});
    }
  }

  cancelAll(): void { for (const controller of this.running.values()) controller.abort(new Error("Relay Desk is closing.")); }

  private patch(id: string, patch: Partial<KnowledgeSource>): void {
    const source = this.vault.get<KnowledgeSource>("knowledge", id);
    if (!source) return;
    this.vault.put("knowledge", id, { ...source, ...patch });
    this.hooks.changed();
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const source = this.vault.get<KnowledgeSource>("knowledge", id);
    if (!source) return;
    try {
      signal.throwIfAborted();
      this.patch(id, { progress: source.kind === "folder" ? "Scanning folder…" : "Reading shared link…" });
      const existing = new Map(this.documents(id).map(document => [document.key, document]));
      const seen = new Set<string>();
      let truncated = false, processed = 0, reported = Date.now();
      // Progress writes refresh the whole UI, so they are throttled to one per second.
      const progress = (total: number) => {
        processed++;
        if (Date.now() - reported < 1000) return;
        reported = Date.now();
        this.patch(id, { progress: `Indexed ${processed} of ${total} files…` });
      };
      if (source.kind === "folder") {
        const walked = await this.walk(source.location, signal);
        truncated = walked.truncated;
        for (const file of walked.files) {
          signal.throwIfAborted();
          seen.add(file.key);
          const revision = `${file.size}:${Math.round(file.mtimeMs)}`;
          const previous = existing.get(file.key);
          if (previous?.revision === revision && previous.status !== "failed") { progress(walked.files.length); continue; }
          const document = await this.index({ id: previous?.id ?? documentId(id, file.key), sourceId: id, key: file.key, path: file.key, name: basename(file.full), size: file.size, revision },
            async () => { if (file.size > KNOWLEDGE_LIMITS.fileBytes) throw new Error("File is larger than 50 MB."); return readFile(file.full); }, signal, previous);
          if (this.vault.get("knowledge", id)) this.vault.put("documents", document.id, document);
          progress(walked.files.length);
        }
      } else {
        const listing = await listRemote(source.location, signal, this.hooks.fetcher);
        truncated = listing.truncated;
        if (source.name === "Shared link" || !source.name) this.patch(id, { name: listing.name.slice(0, 120) });
        for (const file of listing.files.slice(0, KNOWLEDGE_LIMITS.files)) {
          signal.throwIfAborted();
          seen.add(file.key);
          const previous = existing.get(file.key);
          if (file.revision && previous?.revision === file.revision && previous.status !== "failed") { progress(listing.files.length); continue; }
          const document = await this.indexRemote(id, file, signal, previous);
          if (this.vault.get("knowledge", id)) this.vault.put("documents", document.id, document);
          progress(listing.files.length);
        }
      }
      signal.throwIfAborted();
      for (const [key, document] of existing) if (!seen.has(key)) this.vault.delete("documents", document.id);
      const documents = this.documents(id);
      this.patch(id, { status: "ready", progress: undefined, error: undefined, lastSyncAt: now(), truncated: truncated || undefined,
        files: documents.length, indexed: documents.filter(d => d.status === "indexed").length,
        skipped: documents.filter(d => d.status === "skipped").length, failed: documents.filter(d => d.status === "failed").length });
    } catch (error) {
      if (!this.vault.get("knowledge", id)) return;
      const documents = this.documents(id);
      this.patch(id, { status: "error", progress: undefined, lastSyncAt: now(), error: error instanceof Error ? error.message.slice(0, 300) : "Sync failed.",
        files: documents.length, indexed: documents.filter(d => d.status === "indexed").length,
        skipped: documents.filter(d => d.status === "skipped").length, failed: documents.filter(d => d.status === "failed").length });
    }
  }

  private async walk(root: string, signal: AbortSignal): Promise<{ files: { key: string; full: string; size: number; mtimeMs: number }[]; truncated: boolean }> {
    let info;
    try { info = await stat(root); } catch { throw new Error("The folder is no longer available. Reconnect the drive or remove this folder."); }
    if (!info.isDirectory()) throw new Error("This path is not a folder.");
    const realRoot = await realpath(root);
    const files: { key: string; full: string; size: number; mtimeMs: number }[] = [];
    let visited = 0, truncated = false;
    const visit = async (folder: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        signal.throwIfAborted();
        if (++visited > KNOWLEDGE_LIMITS.walk || files.length >= KNOWLEDGE_LIMITS.files) { truncated = true; return; }
        // Hidden entries and symlinks are skipped so the scan cannot escape the chosen folder.
        if (entry.name.startsWith(".") || entry.name.startsWith("~$") || entry.isSymbolicLink()) continue;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (depth < KNOWLEDGE_LIMITS.depth) await visit(full, depth + 1); else truncated = true;
        } else if (entry.isFile() && knowledgeFormat(entry.name)) {
          try {
            const meta = await stat(full);
            files.push({ key: relative(realRoot, full).split(sep).join("/"), full, size: meta.size, mtimeMs: meta.mtimeMs });
          } catch { /* removed during the scan */ }
        }
      }
    };
    await visit(realRoot, 0);
    return { files, truncated };
  }

  private async indexRemote(sourceId: string, file: RemoteFile, signal: AbortSignal, previous?: KnowledgeDocument): Promise<KnowledgeDocument> {
    let name = file.name;
    return this.index({ id: previous?.id ?? documentId(sourceId, file.key), sourceId, key: file.key, path: file.path, name, url: file.url, revision: file.revision },
      async () => {
        const downloaded = await file.download(signal);
        if (downloaded.name && knowledgeFormat(safeName(downloaded.name))) name = safeName(downloaded.name);
        return downloaded.bytes;
      }, signal, previous, () => name);
  }

  private async index(base: Omit<KnowledgeDocument, "status" | "text" | "updatedAt" | "hash">, load: () => Promise<Buffer>, signal: AbortSignal,
    previous?: KnowledgeDocument, resolvedName?: () => string): Promise<KnowledgeDocument> {
    const updatedAt = now();
    try {
      const bytes = await load();
      signal.throwIfAborted();
      const name = resolvedName?.() ?? base.name;
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (previous?.hash === hash && previous.status !== "failed") return { ...previous, ...base, name, size: bytes.length, updatedAt };
      const format = knowledgeFormat(name);
      const result: KnowledgeDocument = { ...base, name, path: base.path.endsWith(base.name) && name !== base.name ? base.path.slice(0, -base.name.length) + name : base.path,
        size: bytes.length, hash, status: "indexed", text: "", updatedAt };
      if (!format) return { ...result, status: "skipped", reason: "This file type is not indexed. Supported: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, HTML and zip." };
      let text: string;
      if (format === "text") {
        if (bytes.length > KNOWLEDGE_LIMITS.textBytes) return { ...result, status: "skipped", reason: "Text file is larger than 5 MB." };
        if (bytes.subarray(0, 4096).includes(0)) return { ...result, status: "skipped", reason: "Binary content." };
        text = plainText(bytes, name);
      } else {
        const extracted = await this.hooks.extract(bytes, { name, mimeType: MIME[extension(name)] ?? "application/octet-stream" }, signal);
        const segments = extracted.segments.filter(segment => segment.text.trim());
        text = segments.map(segment => segments.length > 1 && segment.location ? `[${segment.location}]\n${segment.text}` : segment.text).join("\n\n");
        if (!text.trim()) return { ...result, status: "skipped", reason: extracted.reason ?? "No readable text was found (scanned or image-only document)." };
      }
      text = text.trim();
      return { ...result, text: text.slice(0, KNOWLEDGE_LIMITS.characters),
        ...(text.length > KNOWLEDGE_LIMITS.characters ? { reason: `Only the first ${KNOWLEDGE_LIMITS.characters.toLocaleString("en-US")} characters are searchable.` } : {}) };
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Sync cancelled.");
      return { ...base, status: "failed", text: "", updatedAt, reason: error instanceof Error ? error.message.slice(0, 300) : "The file could not be read." };
    }
  }

  private permittedSources(sourceId?: string): Map<string, KnowledgeSource> {
    return new Map(this.vault.all<KnowledgeSource>("knowledge").filter(source => source.aiEnabled && (!sourceId || source.id === sourceId))
      .map(source => [source.id, source]));
  }

  /** Document inventory for the assistant (AI-enabled sources only). */
  list(sourceId?: string, limit = 200) {
    const sources = this.permittedSources(sourceId);
    const documents = this.vault.all<KnowledgeDocument>("documents").filter(document => sources.has(document.sourceId));
    return {
      sources: [...sources.values()].map(source => ({ id: source.id, name: source.name, kind: source.kind, provider: source.provider,
        location: source.location, files: source.files, indexed: source.indexed, lastSyncAt: source.lastSyncAt, status: source.status })),
      documents: documents.slice(0, limit).map(document => ({ documentId: document.id, sourceId: document.sourceId, path: document.path,
        status: document.status, characters: document.text.length, ...(document.reason ? { note: document.reason } : {}) })),
      truncated: documents.length > limit
    };
  }

  /** Keyword search over extracted text. Returns ranked excerpts with their document IDs. */
  search(query: string, options: { sourceId?: string; limit?: number } = {}) {
    const words = terms(query);
    if (!words.length) throw new Error("Search for at least one word of two or more characters.");
    const sources = this.permittedSources(options.sourceId);
    const phrase = fold(query.trim());
    const results: { document: KnowledgeDocument; score: number; at: number }[] = [];
    for (const document of this.vault.all<KnowledgeDocument>("documents")) {
      if (!sources.has(document.sourceId) || document.status !== "indexed") continue;
      const body = fold(document.text), title = fold(document.path);
      let score = 0, at = -1;
      for (const word of words) {
        if (title.includes(word)) score += 5;
        let index = body.indexOf(word), count = 0;
        if (index >= 0 && (at < 0 || index < at)) at = index;
        while (index >= 0 && count < 25) { count++; index = body.indexOf(word, index + word.length); }
        score += count;
      }
      if (words.length > 1 && phrase.length > 3) {
        const exact = body.indexOf(phrase);
        if (exact >= 0) { score += 15; at = exact; }
      }
      if (score > 0) results.push({ document, score, at });
    }
    results.sort((a, b) => b.score - a.score);
    const limit = Math.min(options.limit ?? 8, 20);
    return {
      results: results.slice(0, limit).map(({ document, at }) => {
        const start = Math.max(0, at - 300);
        return { documentId: document.id, source: sources.get(document.sourceId)?.name, path: document.path, url: document.url,
          offset: start, excerpt: document.text.slice(start, start + 900) };
      }),
      matchedDocuments: results.length,
      limitation: "Keyword matches over locally extracted text from added folders and shared links. Use read_document for more context."
    };
  }

  read(documentId: string, offset = 0, length = 12_000) {
    const document = this.vault.get<KnowledgeDocument>("documents", documentId);
    if (!document || !this.permittedSources(document.sourceId).has(document.sourceId)) throw new Error("This document is unavailable or its source is not shared with AI.");
    if (document.status !== "indexed") throw new Error(document.reason ?? "This document has no extracted text.");
    const start = Math.max(0, Math.min(offset, document.text.length));
    const size = Math.max(500, Math.min(length, 20_000));
    return { documentId, path: document.path, url: document.url, totalCharacters: document.text.length, offset: start,
      text: document.text.slice(start, start + size), more: start + size < document.text.length };
  }
}

const documentId = (sourceId: string, key: string) => `${sourceId}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
