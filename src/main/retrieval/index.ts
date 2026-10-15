import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Attachment, Citation, Message } from "../../shared/contracts";
import { fullThreadMessages, isMailPreview, mailEvidenceLocation, mailThreadKey } from "../../shared/mail-evidence";
import { Vault, type IndexChunk, type VectorChunk } from "../storage/vault";
import { mailOriginAllowed } from "../../shared/mail-transport";

const CHUNK_SIZE = 1800;
const CHUNK_BATCH_SIZE = 64;
const INDEX_VERSION = "chunks-v1-lsh8-v1";
type Extractor = ((text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>) & { dispose?: () => Promise<void> };

export function keywordQuery(query: string): string {
  return (query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 24).map(word => `"${word.slice(0, 80)}"`).join(" OR ");
}
function vectorBucket(vector: ArrayLike<number>): number {
  const sums = Array<number>(8).fill(0);
  for (let i = 0; i < vector.length; i++) sums[i % 8] += vector[i] * (((Math.imul(i + 1, 2654435761) >>> 16) & 1) ? 1 : -1);
  return sums.reduce((bits, value, index) => bits | (value >= 0 ? 1 << index : 0), 0);
}
function vectorData(bytes: Buffer): Float32Array {
  const values = new Float32Array(bytes.length / 4);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
  return values;
}
function vectorBytes(values: ArrayLike<number>): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4);
  return bytes;
}

export class Retrieval {
  private extractor?: Extractor;
  private model = "";
  private generation = 0;
  private e5 = false;
  private reindexing = false;
  private indexing = new Map<string, { token: symbol; accountId: string }>();
  constructor(private readonly vault: Vault, private readonly modelDirectory: string) {}

  private chunkAllowed(chunk: IndexChunk): boolean {
    const message = this.vault.get<Message>("messages", chunk.messageId);
    if (!message || message.deleted || message.accountId !== chunk.accountId || message.sourceId !== chunk.sourceId
      || !this.vault.permitted(chunk.accountId, chunk.sourceId) || !mailOriginAllowed(this.vault, message)) return false;
    if (!chunk.attachmentId) return true;
    const attachment = this.vault.get<Attachment>("attachments", chunk.attachmentId);
    return !!attachment && attachment.messageId === message.id && attachment.accountId === message.accountId
      && mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi });
  }
  private *chunks(base: Omit<IndexChunk, "id" | "text" | "location">, segments: { text: string; location: string }[]): Generator<IndexChunk> {
    let ordinal = 0;
    for (const segment of segments) {
      const text = segment.text.replace(/\u0000/g, "").trim();
      for (let offset = 0; offset < text.length; offset += CHUNK_SIZE - 200) {
        const part = text.slice(offset, offset + CHUNK_SIZE);
        yield { ...base, id: createHash("sha256").update(`${base.documentId}:${ordinal++}:${part}`).digest("hex"), text: part, location: `${segment.location}${offset ? ` · character ${offset + 1}` : ""}` };
        if (offset + CHUNK_SIZE >= text.length) break;
      }
    }
  }
  private async indexChunks(documentId: string, chunks: Iterable<IndexChunk>, message: Message, attachmentId?: string): Promise<void> {
    const run = Symbol(documentId);
    const attachmentOrigin = attachmentId ? this.vault.get<Attachment>("attachments", attachmentId)?.gmailApi : undefined;
    this.indexing.set(documentId, { token: run, accountId: message.accountId });
    const current = () => {
      const latest = this.vault.get<Message>("messages", message.id);
      return this.indexing.get(documentId)?.token === run && latest && !latest.deleted
        && latest.revision === message.revision && latest.accountId === message.accountId && latest.sourceId === message.sourceId
        && JSON.stringify(latest.gmailApi) === JSON.stringify(message.gmailApi)
        && this.vault.permitted(message.accountId, message.sourceId)
        && mailOriginAllowed(this.vault, latest)
        && mailOriginAllowed(this.vault, message)
        && (!attachmentId || (JSON.stringify(this.vault.get<Attachment>("attachments", attachmentId)?.gmailApi) === JSON.stringify(attachmentOrigin)
          && this.chunkAllowed({ accountId: message.accountId, sourceId: message.sourceId,
            messageId: message.id, attachmentId } as IndexChunk)));
    };
    const flush = async (batch: IndexChunk[]) => {
      if (!current()) throw new Error("Indexing interrupted because the document or source eligibility changed.");
      this.vault.appendDocumentChunks(documentId, batch);
      for (const chunk of batch) await this.embed(chunk);
      await setImmediate();
    };
    try {
      this.vault.removeDocument(documentId);
      let batch: IndexChunk[] = [];
      for (const chunk of chunks) {
        batch.push(chunk);
        if (batch.length === CHUNK_BATCH_SIZE) { await flush(batch); batch = []; }
      }
      if (batch.length) await flush(batch);
      if (!current()) throw new Error("Indexing interrupted because the document or source eligibility changed.");
    } catch (error) {
      // Never leave a failed rebuild looking like a complete index. The caller's
      // durable job/attachment status reports the error and can retry the source.
      if (this.indexing.get(documentId)?.token === run) this.vault.removeDocument(documentId);
      throw error;
    } finally {
      if (this.indexing.get(documentId)?.token === run) this.indexing.delete(documentId);
    }
  }
  async indexMessage(message: Message): Promise<void> {
    const documentId = `message:${message.id}`;
    if (message.deleted || !this.vault.permitted(message.accountId, message.sourceId) || !mailOriginAllowed(this.vault, message)) { this.vault.removeDocument(documentId); return; }
    if (isMailPreview(message) && this.indexedFullMessages(message).length) {
      this.vault.removeDocument(documentId);
      return;
    }
    const chunks = this.chunks({ documentId, accountId: message.accountId, sourceId: message.sourceId, messageId: message.id, title: message.subject },
      [{ text: `${message.subject}\n${message.sender}\n${message.body}`, location: mailEvidenceLocation(message) }]);
    await this.indexChunks(documentId, chunks, message);
    if (message.browser?.completeness === "full" && !isMailPreview(message) &&
      this.vault.localDocumentChunks(documentId, 0, 1).length) {
      // Browser Inbox rows use stable thread IDs. Remove only their search document;
      // retained message records continue to guard existing drafts/tasks by revision.
      const prefix = `${message.accountId}:thread:`;
      if (message.threadId.startsWith(prefix)) {
        const preview = this.vault.get<Message>("messages", `${message.accountId}:message:thread%3A${message.threadId.slice(prefix.length)}`);
        if (preview && isMailPreview(preview) && mailThreadKey(preview) === mailThreadKey(message)) {
          this.indexing.delete(`message:${preview.id}`);
          this.vault.removeDocument(`message:${preview.id}`);
        }
      }
    }
  }
  private indexedFullMessages(preview: Message, messages = this.vault.all<Message>("messages")): Message[] {
    return fullThreadMessages(preview, messages).filter(message =>
      !this.indexing.has(`message:${message.id}`) &&
      this.vault.permitted(message.accountId, message.sourceId) &&
      mailOriginAllowed(this.vault, message) &&
      this.vault.localDocumentChunks(`message:${message.id}`, 0, 1).length > 0);
  }
  async indexAttachment(attachment: Attachment, segments: { text: string; location: string }[]): Promise<void> {
    const message = this.vault.get<Message>("messages", attachment.messageId);
    const documentId = `attachment:${attachment.id}`;
    if (!message || message.deleted || attachment.accountId !== message.accountId || !this.vault.permitted(message.accountId, message.sourceId)
      || !mailOriginAllowed(this.vault, message) || !mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi })) { this.vault.removeDocument(documentId); return; }
    const chunks = this.chunks({ documentId, accountId: message.accountId, sourceId: message.sourceId, messageId: message.id, attachmentId: attachment.id, title: attachment.name }, segments);
    await this.indexChunks(documentId, chunks, message, attachment.id);
  }
  private async embed(chunk: IndexChunk): Promise<void> {
    const extractor = this.extractor, model = this.model, generation = this.generation;
    if (!extractor || !this.chunkAllowed(chunk)) return;
    const output = await extractor(`${this.e5 ? "passage: " : ""}${chunk.text}`, { pooling: "mean", normalize: true });
    if (generation !== this.generation || !this.chunkAllowed(chunk)) return;
    const values = Float32Array.from(output.data);
    if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("The local model produced invalid embeddings.");
    this.vault.saveVector(chunk.id, model, vectorBucket(values), vectorBytes(values));
  }
  async configure(enabled: boolean, model: string): Promise<void> {
    const generation = ++this.generation;
    const old = this.extractor;
    this.extractor = undefined;
    await old?.dispose?.();
    if (!enabled || generation !== this.generation) return;
    if (!/^[\w.-]+\/[\w.-]+$/.test(model)) throw new Error("Choose a Hugging Face model identifier (owner/model), not a URL or path.");
    const previous = this.vault.get<{ model: string; repository?: string; revision?: string }>("settings", "retrieval-index");
    let revision = previous?.repository === model ? previous.revision : undefined;
    if (!revision || !/^[a-f0-9]{40}$/i.test(revision)) {
      // Resolve the public model revision before download; no archive data leaves
      // this process. Persist it so later launches cannot silently change vectors.
      const response = await fetch(`https://huggingface.co/api/models/${model}/revision/main`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Cannot resolve local embedding model version (${response.status}).`);
      const metadata = await response.json() as { sha?: string };
      if (!metadata.sha || !/^[a-f0-9]{40}$/i.test(metadata.sha)) throw new Error("The model registry did not return an immutable model revision.");
      revision = metadata.sha;
    }
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = this.modelDirectory;
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    const extractor = await pipeline("feature-extraction", model, { dtype: "q8", device: "cpu", revision, cache_dir: this.modelDirectory });
    if (generation !== this.generation) { await extractor.dispose(); return; }
    this.extractor = extractor as unknown as Extractor;
    this.e5 = /(?:^|[/-])(?:multilingual-)?e5(?:-|$)/i.test(model);
    this.model = `${model}@${revision}:q8:${INDEX_VERSION}`;
    if (previous?.model !== this.model) {
      this.vault.clearVectors();
      this.vault.put("settings", "retrieval-index", { model: this.model, repository: model, revision, configuredAt: new Date().toISOString() });
    }
  }
  async search(query: string, accountId?: string): Promise<Citation[]> {
    const fts = keywordQuery(query);
    if (!fts) return [];
    const keywords = this.vault.keywordCandidates(fts, accountId);
    const ranked = new Map<string, { chunk: IndexChunk; score: number }>();
    const add = (chunk: IndexChunk, score: number) => {
      const current = ranked.get(chunk.id);
      ranked.set(chunk.id, { chunk, score: score + (current?.score ?? 0) });
    };
    keywords.forEach((chunk, index) => add(chunk, 1 / (60 + index + 1)));
    const extractor = this.extractor, generation = this.generation, model = this.model;
    if (extractor) {
      const result = await extractor(`${this.e5 ? "query: " : ""}${query.slice(0, 2048)}`, { pooling: "mean", normalize: true });
      if (generation === this.generation) {
        const vector = Float32Array.from(result.data), bucket = vectorBucket(vector);
        // Approximate semantic candidates: indexed 8-bit projection plus one-bit neighbours,
        // capped at 2048; lexical candidates are always included. No full-corpus vector scan.
        const candidates = new Map<string, VectorChunk>();
        for (const chunk of this.vault.semanticCandidates(model, [bucket, ...Array.from({ length: 8 }, (_, i) => bucket ^ (1 << i))], accountId)) candidates.set(chunk.id, chunk);
        for (const chunk of keywords) candidates.set(chunk.id, { ...chunk, vector: this.vault.vector(chunk.id, model) });
        const semantic = [...candidates.values()].filter(chunk => chunk.vector?.length === vector.length * 4).map(chunk => {
          const values = vectorData(chunk.vector!);
          return { chunk, similarity: values.reduce((sum, value, index) => sum + value * vector[index], 0) };
        }).sort((a, b) => b.similarity - a.similarity).slice(0, 200);
        semantic.forEach(({ chunk }, index) => add(chunk, 1 / (60 + index + 1)));
      }
    }
    const perDocument = new Map<string, number>();
    let messages: Message[] | undefined;
    return [...ranked.values()].sort((a, b) => b.score - a.score).filter(({ chunk }) => {
      // Recheck after asynchronous inference: permissions may have changed while it ran.
      const message = this.vault.get<Message>("messages", chunk.messageId);
      if (!message || !this.chunkAllowed(chunk) || (accountId !== undefined && chunk.accountId !== accountId)) return false;
      if (!chunk.attachmentId && isMailPreview(message) &&
        this.indexedFullMessages(message, messages ??= this.vault.all<Message>("messages")).length) return false;
      if (chunk.attachmentId && !this.vault.get<Attachment>("attachments", chunk.attachmentId)) return false;
      const count = perDocument.get(chunk.documentId) ?? 0;
      perDocument.set(chunk.documentId, count + 1);
      return count < 2;
    }).slice(0, 12).map(({ chunk, score }) => {
      const message = this.vault.get<Message>("messages", chunk.messageId)!;
      const offset = chunk.location.indexOf(" · character");
      const location = chunk.attachmentId ? chunk.location : `${mailEvidenceLocation(message)}${offset >= 0 ? chunk.location.slice(offset) : ""}` +
        (message.browser?.capturedAt ? ` · captured ${message.browser.capturedAt}` : "");
      return { id: chunk.id, messageId: chunk.messageId, attachmentId: chunk.attachmentId ?? undefined,
        title: chunk.title, excerpt: chunk.text.slice(0, 1200), location, score };
    });
  }
  async reindex(): Promise<void> {
    if (this.reindexing) throw new Error("Reindexing is already running.");
    this.reindexing = true;
    try {
      let cursor = 0;
      while (true) {
        const page = this.vault.messagePage(cursor);
        if (!page.length) break;
        for (const row of page) { await this.indexMessage(row.message); cursor = row.rowNumber; }
        await setImmediate();
      }
      cursor = 0;
      while (true) {
        const page = this.vault.chunkPage(cursor);
        if (!page.length) break;
        for (const chunk of page) { cursor = chunk.rowNumber; if (chunk.attachmentId) await this.embed(chunk); }
        await setImmediate();
      }
    } finally { this.reindexing = false; }
  }
  stats(): { indexed: number; mode: "hybrid" | "keyword" } { return { indexed: this.vault.chunkCount(), mode: this.extractor ? "hybrid" : "keyword" }; }
  forgetAccount(accountId: string): void {
    for (const [documentId, run] of this.indexing) if (run.accountId === accountId) this.indexing.delete(documentId);
    this.vault.forgetIndex(accountId);
  }
}
