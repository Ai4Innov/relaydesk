import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Draft, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { Vault } from "../src/main/storage/vault";
import { BrowserArchive, browserAccountId, browserAttachmentId } from "../src/main/browser/archive";
import { browserAttachmentsSchema } from "../src/main/browser/attachment-schema";
import { BrowserBridge } from "../src/main/browser/bridge";
import { browserAttachmentGuard, importBrowserAttachment, pickBrowserAttachment } from "../src/main/attachments/browser-import";
import { AttachmentProcessor } from "../src/main/attachments";
import { commandSchema } from "../src/main/ipc/schema";

class MemoryVault {
  records = new Map<string, unknown>();
  blobs = new Map<string, Buffer>();
  get<T>(collection: Collection, id: string): T | undefined {
    return structuredClone(this.records.get(`${collection}/${id}`)) as T | undefined;
  }
  put(collection: Collection, id: string, value: unknown) { this.records.set(`${collection}/${id}`, structuredClone(value)); }
  delete(collection: Collection, id: string) { this.records.delete(`${collection}/${id}`); }
  all<T>(collection: Collection): T[] {
    return [...this.records].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T);
  }
  transaction<T>(work: () => T): T { return work(); }
  async writeBlob(id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const reader = stream.getReader(), chunks: Buffer[] = [];
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    this.blobs.set(id, bytes);
    return { hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  readBlob(id: string) { return this.blobs.get(id)!; }
}
const metadata = { id: "file-0", name: "notes.txt", mimeType: "text/plain", size: 18 };
function payload(email = "synthetic@example.org"): BrowserCapture {
  return { accountEmail: email, accountName: "Synthetic", pageUrl: "https://mail.google.com/mail/u/0/#inbox", kind: "mail",
    messages: [{ id: "message", threadId: "thread", subject: "Synthetic", sender: "sender@example.org", recipients: [],
      body: "Synthetic message", dateText: "Today", url: "https://mail.google.com/mail/u/0/#inbox/thread", unread: true,
      completeness: "full", attachments: [{ ...metadata }] }], meetings: [] };
}
async function fixture(whatsapp = false) {
  const vault = new MemoryVault();
  const archive = new BrowserArchive(vault as unknown as Vault, vi.fn(async () => {}), vi.fn(), () => false);
  const input = payload(whatsapp ? "+15551234567" : undefined);
  if (whatsapp) {
    input.kind = "whatsapp";
    input.pageUrl = "https://web.whatsapp.com/";
    input.chat = { id: "15559876543@c.us", name: "Synthetic chat" };
    input.messages[0] = { ...input.messages[0], id: `false_${input.chat.id}_ABC`,
      threadId: input.chat.id, url: input.pageUrl };
  }
  const accountId = browserAccountId(input.accountEmail, input.kind);
  archive.discover(input);
  if (whatsapp) vault.put("accounts", accountId, { ...vault.get<Account>("accounts", accountId), consent: true });
  const sourceId = whatsapp ? `${accountId}:chat:${encodeURIComponent(input.chat!.id)}` : `${accountId}:mail`;
  vault.put("sources", sourceId, { ...vault.get<Source>("sources", sourceId), selected: true });
  await archive.capture(input);
  const attachment = vault.all<Attachment>("attachments")[0];
  const validate = browserAttachmentGuard(vault, attachment.id, () => false);
  return { vault, archive, input, attachment, validate, sourceId, accountId };
}
const directories: string[] = [];
async function localFile(name = "notes.txt", content: string | Buffer = "Synthetic evidence") {
  const directory = await mkdtemp(join(tmpdir(), "relay-browser-attachment-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("browser attachment metadata ingestion", () => {
  it("enforces full-message, metadata-only attachment capture at the authenticated bridge", async () => {
    const extensionId = "abcdefghijklmnopabcdefghijklmnop", captured = vi.fn(async () => {});
    const bridge = new BrowserBridge(new MemoryVault(), {
      extensionId, port: 0, changed: vi.fn(), onDiscover: async () => ({ accountId: "synthetic", enabled: true }),
      onCapture: captured
    });
    try {
      const pairing = await bridge.pair();
      const post = (route: string, input: unknown, token?: string) => fetch(`http://127.0.0.1:${bridge.status().port}${route}`, {
        method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input)
      });
      const response = await post("/pair", { code: pairing.code });
      const { token } = await response.json() as { token: string };
      const input = payload();
      expect((await post("/capture", input, token)).status).toBe(200);
      expect(captured).toHaveBeenCalledOnce();
      input.messages[0].completeness = "preview";
      expect((await post("/capture", input, token)).status).toBe(400);
      input.messages[0].completeness = "full";
      const withUrl = { ...input, messages: [{ ...input.messages[0], attachments: [{ ...metadata, url: "https://mail.google.com/private" }] }] };
      expect((await post("/capture", withUrl, token)).status).toBe(400);
      const unverifiedManifest = { ...input, messages: [{ ...input.messages[0], attachments: undefined, attachmentManifestVersion: 1 }] };
      expect((await post("/capture", unverifiedManifest, token)).status).toBe(400);
      expect(captured).toHaveBeenCalledOnce();
    } finally { await bridge.stop(); }
  });
  it("accepts only bounded metadata with unique IDs, never URL/path fields", () => {
    expect(browserAttachmentsSchema.safeParse([metadata]).success).toBe(true);
    for (const items of [
      [{ ...metadata, url: "https://mail.google.com/private" }], [{ ...metadata, path: "C:\\private.txt" }],
      [{ ...metadata, size: -1 }], [{ ...metadata, size: 0.5 }], [{ ...metadata, size: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...metadata, name: "../notes.txt" }], [{ ...metadata, name: "folder\\notes.txt" }],
      [metadata, metadata], Array.from({ length: 101 }, (_, i) => ({ ...metadata, id: `${i}` }))
    ]) expect(browserAttachmentsSchema.safeParse(items).success).toBe(false);
  });
  it("creates account/message-scoped safe IDs and never downgrades retained/indexed files", async () => {
    const { vault, archive, input, attachment } = await fixture();
    expect(attachment.id).toMatch(/^browser-attachment:[a-f0-9]{64}$/);
    expect(attachment.browser).toEqual({ source: "browser_gmail", metadataId: metadata.id });
    expect(attachment.reason).toContain("automatic Gmail attachment download");
    vault.put("attachments", attachment.id, { ...attachment, hash: "retained", status: "indexed", size: 21, approved: true });
    const original = vault.all<Message>("messages")[0];
    for (const change of [input, { ...input, messages: [{ ...input.messages[0], attachments: undefined }] },
      { ...input, messages: [{ ...input.messages[0], completeness: "preview" as const, attachments: undefined, body: "Preview" }] }])
      await archive.capture(change);
    expect(vault.get<Attachment>("attachments", attachment.id)).toMatchObject({ hash: "retained", status: "indexed", size: 21, approved: true });
    expect(vault.all<Message>("messages")[0].revision).toBe(original.revision);
    expect(browserAttachmentId("other-account", original.id, metadata)).not.toBe(attachment.id);
    expect(browserAttachmentId(attachment.accountId, "other-message", metadata)).not.toBe(attachment.id);
  });
  it("revises semantically changed attachment metadata once while preserving old artifacts", async () => {
    const { vault, archive, input, attachment } = await fixture();
    const original = vault.all<Message>("messages")[0];
    vault.put("drafts", "draft", { id: "draft", messageId: original.id, status: "local" });
    vault.put("attachments", attachment.id, { ...attachment, status: "indexed", hash: "old-encrypted-original" });
    input.messages[0].attachments = [{ ...metadata, name: "renamed.txt" }];
    expect(await archive.capture(input)).toHaveLength(1);
    const revised = vault.all<Message>("messages")[0].revision;
    expect(revised).not.toBe(original.revision);
    expect(vault.get<Draft>("drafts", "draft")?.status).toBe("stale");
    expect(await archive.capture(input)).toHaveLength(0);
    expect(vault.get<Attachment>("attachments", attachment.id)?.hash).toBe("old-encrypted-original");
    expect(vault.all<Attachment>("attachments")).toHaveLength(2);
    input.messages[0].attachments = [];
    expect(await archive.capture(input)).toHaveLength(1);
    expect(await archive.capture(input)).toHaveLength(0);
    expect(vault.all<Attachment>("attachments")).toHaveLength(2);
  });
  it("rejects metadata on previews without inserting attachment rows", async () => {
    const { archive, input, vault } = await fixture();
    const preview = { ...input, messages: [{ ...input.messages[0], id: "preview", completeness: "preview" as const }] };
    await expect(archive.capture(preview)).rejects.toThrow("full message");
    expect(vault.all<Attachment>("attachments")).toHaveLength(1);
  });
});

describe("explicit local import provenance and policy", () => {
  it("accepts an ID and approval only at IPC, never a renderer-selected path", () => {
    const command = { type: "attachment.import", attachmentId: "synthetic", approved: false };
    expect(commandSchema.safeParse(command).success).toBe(true);
    expect(commandSchema.safeParse({ ...command, path: "C:\\private.txt" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, url: "https://mail.google.com/private" }).success).toBe(false);
  });
  it("matches the exact downloaded filename and treats picker cancellation as no import", async () => {
    const { validate } = await fixture();
    await expect(pickBrowserAttachment(validate, async () => undefined, new AbortController().signal)).resolves.toBeUndefined();
    await expect(pickBrowserAttachment(validate, async () => localFile("other.txt"), new AbortController().signal))
      .rejects.toThrow("filename does not match");
  });
  it.each(["account", "source", "message", "attachment", "paused"])("checks %s provenance before opening the picker", async boundary => {
    const h = await fixture(), picker = vi.fn(async () => undefined);
    if (boundary === "account") h.vault.put("accounts", h.accountId, { ...h.vault.get<Account>("accounts", h.accountId), consent: false });
    if (boundary === "source") h.vault.put("sources", h.sourceId, { ...h.vault.get<Source>("sources", h.sourceId), selected: false });
    if (boundary === "message") h.vault.put("messages", h.attachment.messageId, { ...h.vault.get<Message>("messages", h.attachment.messageId), accountId: "other" });
    if (boundary === "attachment") h.vault.put("attachments", h.attachment.id, { ...h.attachment, browser: undefined });
    const guard = browserAttachmentGuard(h.vault, h.attachment.id, () => boundary === "paused");
    await expect(pickBrowserAttachment(guard, picker, new AbortController().signal)).rejects.toThrow("requires");
    expect(picker).not.toHaveBeenCalled();
  });
  it.each([false, true])("rejects changed selection during picker/read (WhatsApp: %s)", async whatsapp => {
    const h = await fixture(whatsapp), path = await localFile();
    const exclude = () => h.vault.put("sources", h.sourceId, { ...h.vault.get<Source>("sources", h.sourceId), selected: false });
    await expect(pickBrowserAttachment(h.validate, async () => { exclude(); return path; }, new AbortController().signal))
      .rejects.toThrow("requires");
    h.vault.put("sources", h.sourceId, { ...h.vault.get<Source>("sources", h.sourceId), selected: true });
    const source = await pickBrowserAttachment(h.validate, async () => path, new AbortController().signal);
    try {
      const reader = (await source!.open(new AbortController().signal)).getReader();
      exclude();
      await expect(reader.read()).rejects.toThrow("requires");
    } finally { await source?.close(); }
  });
  it("rejects unsafe type labels and forged metadata provenance before file selection", async () => {
    const h = await fixture(), picker = vi.fn(async () => undefined);
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, name: "other.txt" });
    await expect(pickBrowserAttachment(h.validate, picker, new AbortController().signal)).rejects.toThrow("provenance");
    const dangerous = { ...metadata, name: "script.ps1" };
    h.input.messages[0].attachments = [dangerous];
    await h.archive.capture(h.input);
    const id = browserAttachmentId(h.accountId, h.attachment.messageId, dangerous);
    await expect(pickBrowserAttachment(browserAttachmentGuard(h.vault, id, () => false), picker, new AbortController().signal))
      .rejects.toThrow("not supported");
    expect(picker).not.toHaveBeenCalled();
  });
  it("rejects directory junctions and changed downloaded files", async () => {
    const h = await fixture(), path = await localFile();
    const directory = join(directories[directories.length - 1], "linked");
    const target = join(directories[directories.length - 1], "target");
    await mkdir(target); await writeFile(join(target, "notes.txt"), "Synthetic");
    await vi.waitFor(() => symlink(target, directory, "junction"), { timeout: 2000, interval: 50 });
    await expect(pickBrowserAttachment(h.validate, async () => join(directory, "notes.txt"), new AbortController().signal))
      .rejects.toThrow("Symbolic links");
    const source = await pickBrowserAttachment(h.validate, async () => path, new AbortController().signal);
    try {
      await writeFile(path, "Changed synthetic contents");
      await expect(source!.open(new AbortController().signal)).rejects.toThrow("changed");
    } finally { await source?.close(); }
  });
  it.each([false, true])("uses encrypted persistence/extraction, never API (WhatsApp: %s)", async whatsapp => {
    const h = await fixture(whatsapp), path = await localFile(), download = vi.fn();
    const retrieval = { indexAttachment: vi.fn(async () => {}) };
    const processor = new AttachmentProcessor(h.vault, retrieval, download, {
      modelDirectory: resolve("tests", "uninstalled-attachment-models"), thresholdMb: () => 25,
      workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs")
    });
    await expect(processor.process(h.attachment.id, false)).rejects.toThrow("Import downloaded file");
    const source = await pickBrowserAttachment(h.validate, async () => path, new AbortController().signal);
    try { await processor.process(h.attachment.id, false, undefined, source); }
    finally { await source?.close(); }
    expect(h.vault.get<Attachment>("attachments", h.attachment.id)).toMatchObject({ status: "indexed", size: 18 });
    expect(h.vault.get<Attachment>("attachments", h.attachment.id)?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(retrieval.indexAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: h.attachment.id }),
      [expect.objectContaining({ text: "Synthetic evidence" })]);
    expect(download).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses actual size and never reads unapproved costly files (WhatsApp: %s)", async whatsapp => {
    const h = await fixture(whatsapp), path = await localFile("notes.txt", Buffer.alloc(2048, 65)), download = vi.fn();
    const retrieval = { indexAttachment: vi.fn(async () => {}) };
    const processor = new AttachmentProcessor(h.vault, retrieval, download, {
      modelDirectory: resolve("tests", "uninstalled-attachment-models"), thresholdMb: () => 0.001,
      workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs")
    });
    const source = await pickBrowserAttachment(h.validate, async () => path, new AbortController().signal);
    const open = vi.spyOn(source!, "open");
    try { await processor.process(h.attachment.id, false, undefined, source); }
    finally { await source?.close(); }
    expect(h.vault.get<Attachment>("attachments", h.attachment.id)?.status).toBe("awaiting-approval");
    expect(h.vault.blobs.size).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it.each(["provider", "chat", "phone", "consent"])("rejects mismatched WhatsApp %s provenance before selecting a file", async boundary => {
    const h = await fixture(true), picker = vi.fn(async () => undefined);
    const account = h.vault.get<Account>("accounts", h.accountId)!;
    const source = h.vault.get<Source>("sources", h.sourceId)!;
    if (boundary === "provider") h.vault.put("attachments", h.attachment.id, { ...h.attachment,
      browser: { ...h.attachment.browser, source: "browser_gmail" } });
    if (boundary === "chat") h.vault.put("sources", source.id, { ...source, providerId: "15550000000@c.us" });
    if (boundary === "phone") h.vault.put("accounts", account.id, { ...account, email: "Unverified display name" });
    if (boundary === "consent") h.vault.put("accounts", account.id, { ...account, consent: false });
    await expect(pickBrowserAttachment(h.validate, picker, new AbortController().signal)).rejects.toThrow();
    expect(picker).not.toHaveBeenCalled();
  });
  it("extracts unknown-size octet-stream metadata emitted by Gmail using the selected file extension", async () => {
    const h = await fixture(), path = await localFile(), download = vi.fn();
    h.input.messages[0].attachments = [{ id: "notes.txt", name: "notes.txt", mimeType: "application/octet-stream" }];
    await h.archive.capture(h.input);
    const attachmentId = browserAttachmentId(h.accountId, h.attachment.messageId, h.input.messages[0].attachments[0]);
    expect(h.vault.get<Attachment>("attachments", attachmentId)?.size).toBeUndefined();
    const retrieval = { indexAttachment: vi.fn(async () => {}) };
    const processor = new AttachmentProcessor(h.vault, retrieval, download, {
      modelDirectory: resolve("tests", "uninstalled-attachment-models"), thresholdMb: () => 25,
      workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs")
    });
    const picker = vi.fn(async () => path);
    await importBrowserAttachment(h.vault, processor, attachmentId, false, picker, new AbortController().signal, () => false);
    expect(h.vault.get<Attachment>("attachments", attachmentId)).toMatchObject({ status: "indexed", size: 18 });
    expect(picker).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });
});
