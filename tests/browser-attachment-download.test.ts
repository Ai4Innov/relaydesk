import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { BrowserMailRequest } from "../src/shared/browser-mail";
import { BrowserArchive, browserAccountId, browserAttachmentId } from "../src/main/browser/archive";
import { BrowserMailReader } from "../src/main/browser/mail-reader";
import { BrowserAttachmentDownloads } from "../src/main/browser/attachment-download";
import { AttachmentProcessor } from "../src/main/attachments";
import type { Vault } from "../src/main/storage/vault";
import { commandSchema } from "../src/main/ipc/schema";

class MemoryVault {
  records = new Map<string, unknown>();
  encrypted = new Map<string, Buffer>();
  key = randomBytes(32);
  afterBytes?: () => void;
  get<T>(collection: Collection, id: string): T | undefined { return structuredClone(this.records.get(`${collection}/${id}`)) as T | undefined; }
  put(collection: Collection, id: string, value: unknown) { this.records.set(`${collection}/${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.records].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  transaction<T>(work: () => T) { return work(); }
  async writeBlob(id: string, stream: ReadableStream<Uint8Array>) {
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encoded = Buffer.concat([cipher.update(bytes), cipher.final()]);
    this.encrypted.set(id, Buffer.concat([iv, cipher.getAuthTag(), encoded]));
    this.afterBytes?.();
    return { hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  readBlob(id: string) {
    const bytes = this.encrypted.get(id)!, decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(patch: Partial<Attachment> = {}) {
  const directory = resolve("tests", `.download-fixture-${randomUUID()}`);
  await mkdir(directory);
  directories.push(directory);
  const vault = new MemoryVault(), accountId = browserAccountId("fixture@example.org");
  const sourceId = `${accountId}:mail`, messageId = `${accountId}:message:message1`;
  const bytes = Buffer.from("Synthetic attachment evidence for the local archive.");
  const account: Account = { id: accountId, email: "fixture@example.org", name: "Fixture", provider: "gmail",
    connection: "browser", status: "connected", consent: true, aiEnabled: false };
  const message: Message = { id: messageId, accountId, sourceId, threadId: `${accountId}:thread:thread1`, providerId: "message1",
    subject: "Fixture", sender: "sender@example.org", recipients: [], body: "Message", html: "<p>Message</p>",
    receivedAt: "", url: "https://mail.google.com/mail/u/0/#inbox/thread1", unread: false, revision: "1", historical: true,
    browser: { completeness: "full", capturedAt: "2026-09-23T00:00:00Z", dateText: "", attachmentRevision: "verified-native-metadata", attachmentManifestVersion: 1 } };
  const metadata = { id: "native-file", name: patch.name ?? "notes.txt", mimeType: patch.mimeType ?? "text/plain" };
  const attachment: Attachment = { ...metadata, id: browserAttachmentId(accountId, messageId, metadata),
    accountId, messageId, providerId: metadata.id, size: bytes.length, status: "pending",
    browser: { source: "browser_gmail", metadataId: metadata.id }, ...patch };
  vault.put("accounts", accountId, account);
  vault.put("sources", sourceId, { id: sourceId, accountId, kind: "mail", providerId: "mail", name: "Mail", selected: true } satisfies Source);
  vault.put("messages", messageId, message);
  vault.put("attachments", attachment.id, attachment);
  let allowed = true, enabled = true, epoch = 0, now = 1000;
  const retrieval = { indexAttachment: vi.fn(async (_attachment: Attachment, _segments: { text: string; location: string }[]) => {}) };
  const apiDownload = vi.fn(async (): Promise<ReadableStream<Uint8Array>> => { throw new Error("API download is forbidden"); });
  const processor = new AttachmentProcessor(vault, retrieval, apiDownload, {
    modelDirectory: directory, thresholdMb: () => 25, workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs")
  });
  const capture = (request: BrowserMailRequest): BrowserCapture => ({
    accountName: account.name, accountEmail: account.email, kind: "mail", pageUrl: message.url, meetings: [],
    messages: [{ id: message.providerId, threadId: "thread1", subject: message.subject, sender: message.sender, recipients: [],
      body: message.body, html: message.html, url: message.url, unread: false, dateText: "", completeness: "full",
      attachments: [{ ...metadata, size: attachment.size }], attachmentManifestVersion: 1 }],
    attachmentDownload: { metadataId: metadata.id, name: metadata.name,
      relativePath: request.attachment!.relativePath, bytes: bytes.length }
  });
  const bridge = { readMailThread: vi.fn(async (request: BrowserMailRequest, guard: () => void) => {
    guard();
    await writeFile(join(directory, ...request.attachment!.relativePath.split("/")), bytes);
    guard();
    return capture(request);
  }) };
  const reader = new BrowserMailReader(vault, bridge, async () => {}, () => false, () => false, () => epoch);
  const hooks = { downloadsDirectory: directory, enabled: () => enabled, unavailable: () => !allowed,
    revision: () => epoch, thresholdMb: () => 25, changed: vi.fn(), now: () => now };
  const downloads = new BrowserAttachmentDownloads(vault, bridge, reader, processor, hooks);
  return { vault, directory, attachment, account, message, bytes, retrieval, apiDownload, processor, bridge, reader, downloads, capture, hooks,
    setAllowed: (value: boolean) => { allowed = value; }, setEnabled: (value: boolean) => { enabled = value; },
    revokeEpoch: () => { epoch++; }, advance: () => { now += 31 * 60_000; },
    retained: () => vault.get<Attachment>("attachments", attachment.id)! };
}

describe("automatic browser attachment ingestion", () => {
  it("automatically encrypts, extracts and indexes text with AI off, deleting only its owned plaintext", async () => {
    const h = await fixture();
    await writeFile(join(h.directory, "unrelated.txt"), "keep me");
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained()).toMatchObject({ status: "indexed", size: h.bytes.length });
    expect(h.retained().hash).toBeTruthy();
    expect(h.vault.encrypted.get(h.attachment.id)!.includes(h.bytes)).toBe(false);
    expect(h.vault.readBlob(h.attachment.id)).toEqual(h.bytes);
    expect(h.retrieval.indexAttachment.mock.calls[0][1][0].text).toContain("Synthetic attachment evidence");
    expect(h.apiDownload).not.toHaveBeenCalled();
    expect(h.vault.get<Account>("accounts", h.account.id)?.aiEnabled).toBe(false);
    expect(await readFile(join(h.directory, "unrelated.txt"), "utf8")).toBe("keep me");
    expect(await readdir(join(h.directory, "RelayDesk"))).toEqual([]);
    h.downloads.tick(); await h.downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
  });
  it.each([{ size: undefined }, { size: 26 * 1048576 }, { name: "scan.png", mimeType: "image/png" }])(
    "holds unknown, large and special-processing metadata for approval: %j", async patch => {
      const h = await fixture(patch);
      h.downloads.tick(); await h.downloads.settled();
      expect(h.retained().status).toBe("awaiting-approval");
      expect(h.bridge.readMailThread).not.toHaveBeenCalled();
    });
  it("downloads an explicitly approved unknown-size attachment without an AI grant", async () => {
    const h = await fixture({ size: undefined });
    await h.downloads.download(h.attachment.id, true);
    expect(h.retained().status).toBe("indexed");
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment?.maxBytes).toBe(512 * 1048576);
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment?.approved).toBe(true);
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment?.allowUnknownSize).toBe(true);
  });
  it.each([32, 1024])("uses actual attested bytes rather than equality with rounded native size %s", async size => {
    const h = await fixture({ size });
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained()).toMatchObject({ status: "indexed", size: h.bytes.length });
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment?.maxBytes).toBe(25 * 1048576);
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment?.allowUnknownSize).toBeUndefined();
  });
  it.each(["notes.txt:secret", "launch.exe", "macro.docm", "CON.txt"])("blocks unsafe filenames/types before download: %s", async name => {
    const h = await fixture({ name });
    await h.downloads.download(h.attachment.id, true);
    expect(h.retained().status).toBe("unsupported");
    expect(h.bridge.readMailThread).not.toHaveBeenCalled();
  });
  it.each(["consent", "source", "paused", "epoch", "thread", "metadata"])("rechecks %s before accepting downloaded bytes", async boundary => {
    const h = await fixture();
    const implementation = h.bridge.readMailThread.getMockImplementation()!;
    h.bridge.readMailThread.mockImplementation(async (request, guard) => {
      const capture = await implementation(request, guard);
      if (boundary === "consent") h.vault.put("accounts", h.account.id, { ...h.account, consent: false });
      if (boundary === "source") h.vault.put("sources", h.message.sourceId, { ...h.vault.get<Source>("sources", h.message.sourceId), selected: false });
      if (boundary === "paused") h.setAllowed(false);
      if (boundary === "epoch") h.revokeEpoch();
      if (boundary === "thread") h.vault.put("messages", h.message.id, { ...h.message, threadId: "other" });
      if (boundary === "metadata") h.vault.put("attachments", h.attachment.id, { ...h.attachment, name: "other.txt" });
      return capture;
    });
    await expect(h.downloads.download(h.attachment.id, false)).rejects.toThrow();
    expect(h.vault.encrypted.size).toBe(0);
    expect(h.retrieval.indexAttachment).not.toHaveBeenCalled();
    expect(await readdir(join(h.directory, "RelayDesk"))).toEqual([]);
  });
  it("checks permission again after encrypted persistence and before extraction/indexing", async () => {
    const h = await fixture();
    h.vault.afterBytes = () => h.revokeEpoch();
    await expect(h.downloads.download(h.attachment.id, false)).rejects.toThrow();
    expect(h.retrieval.indexAttachment).not.toHaveBeenCalled();
    expect(await readdir(join(h.directory, "RelayDesk"))).toEqual([]);
  });
  it.each(["path", "name", "bytes", "metadata", "message", "account", "mime"])("rejects forged %s completion without importing another path", async field => {
    const h = await fixture(), implementation = h.bridge.readMailThread.getMockImplementation()!;
    h.bridge.readMailThread.mockImplementation(async (request, guard) => {
      const capture = await implementation(request, guard);
      if (field === "path") capture.attachmentDownload!.relativePath = "../unrelated.txt";
      if (field === "name") capture.attachmentDownload!.name = "other.txt";
      if (field === "bytes") capture.attachmentDownload!.bytes++;
      if (field === "metadata") capture.attachmentDownload!.metadataId = "other";
      if (field === "message") capture.messages[0].id = "other";
      if (field === "account") capture.accountEmail = "other@example.org";
      if (field === "mime") capture.messages[0].attachments![0].mimeType = "application/pdf";
      return capture;
    });
    await expect(h.downloads.download(h.attachment.id, false)).rejects.toThrow();
    expect(h.vault.encrypted.size).toBe(0);
    expect(h.retrieval.indexAttachment).not.toHaveBeenCalled();
  });
  it("backs off failures and recovers interrupted download records after restart", async () => {
    const h = await fixture(), implementation = h.bridge.readMailThread.getMockImplementation()!;
    h.bridge.readMailThread.mockRejectedValueOnce(new Error("Native browser download interrupted"));
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained().status).toBe("failed");
    h.downloads.tick(); await h.downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
    h.bridge.readMailThread.mockImplementation(implementation);
    h.advance();
    const restarted = new BrowserAttachmentDownloads(h.vault, h.bridge, h.reader, h.processor, h.hooks);
    restarted.tick(); await restarted.settled();
    expect(h.retained().status).toBe("indexed");
    expect(h.bridge.readMailThread).toHaveBeenCalledTimes(2);
  });
  it("recovers verified completed staging without another browser download", async () => {
    const h = await fixture(), jobId = randomUUID(), relativePath = `RelayDesk/${jobId}/${h.attachment.name}`;
    await mkdir(join(h.directory, "RelayDesk", jobId), { recursive: true });
    await writeFile(join(h.directory, ...relativePath.split("/")), h.bytes);
    h.vault.put("checkpoints", `browser-attachment-download:${h.attachment.id}`, {
      kind: "browser-attachment-download", attachmentId: h.attachment.id, state: "running", attempts: 1, relativePath, bytes: h.bytes.length
    });
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained().status).toBe("indexed");
    expect(h.bridge.readMailThread).not.toHaveBeenCalled();
  });
  it("retries extraction from encrypted bytes rather than redownloading after an indexing failure", async () => {
    const h = await fixture();
    h.retrieval.indexAttachment.mockRejectedValueOnce(new Error("Index temporarily unavailable"));
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained()).toMatchObject({ status: "failed" });
    expect(h.retained().hash).toBeTruthy();
    h.advance();
    const restarted = new BrowserAttachmentDownloads(h.vault, h.bridge, h.reader, h.processor, h.hooks);
    restarted.tick(); await restarted.settled();
    expect(h.retained().status).toBe("indexed");
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
  });
  it("cleans a verified leftover staged file after a crash following successful encrypted indexing", async () => {
    const h = await fixture();
    await h.downloads.download(h.attachment.id, false);
    const jobId = randomUUID(), relativePath = `RelayDesk/${jobId}/${h.attachment.name}`;
    await mkdir(join(h.directory, "RelayDesk", jobId));
    await writeFile(join(h.directory, ...relativePath.split("/")), h.bytes);
    h.vault.put("checkpoints", `browser-attachment-download:${h.attachment.id}`, {
      kind: "browser-attachment-download", attachmentId: h.attachment.id, state: "complete", attempts: 1, relativePath, bytes: h.bytes.length
    });
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained().status).toBe("indexed");
    expect(await readdir(join(h.directory, "RelayDesk"))).toEqual([]);
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
    expect(h.retrieval.indexAttachment).toHaveBeenCalledOnce();
  });
  it("removes only owned crash leftovers without importing bytes when consent was revoked", async () => {
    const h = await fixture(), jobId = randomUUID(), relativePath = `RelayDesk/${jobId}/${h.attachment.name}`;
    await mkdir(join(h.directory, "RelayDesk", jobId), { recursive: true });
    await writeFile(join(h.directory, ...relativePath.split("/")), h.bytes);
    h.vault.put("checkpoints", `browser-attachment-download:${h.attachment.id}`, {
      kind: "browser-attachment-download", attachmentId: h.attachment.id, state: "running", attempts: 1, relativePath, bytes: h.bytes.length
    });
    h.vault.put("accounts", h.account.id, { ...h.account, consent: false });
    await h.downloads.recoverStaging();
    expect(await readdir(join(h.directory, "RelayDesk"))).toEqual([]);
    expect(h.vault.encrypted.size).toBe(0);
    expect(h.bridge.readMailThread).not.toHaveBeenCalled();
    expect(h.retrieval.indexAttachment).not.toHaveBeenCalled();
  });
  it("does not treat an empty original as indexed without searchable extracted text", async () => {
    const h = await fixture({ size: 0 });
    h.bridge.readMailThread.mockImplementation(async request => {
      await writeFile(join(h.directory, ...request.attachment!.relativePath.split("/")), "");
      return { ...h.capture(request), attachmentDownload: { ...h.capture(request).attachmentDownload!, bytes: 0 } };
    });
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained().status).toBe("partial");
    expect(h.retained().hash).toBeTruthy();
    expect(h.retrieval.indexAttachment.mock.calls[0][1]).toEqual([]);
  });
  it("refuses staged hard links and never deletes their unrelated originals", async () => {
    const h = await fixture(), external = join(h.directory, "unrelated.txt");
    await writeFile(external, h.bytes);
    h.bridge.readMailThread.mockImplementation(async request => {
      await link(external, join(h.directory, ...request.attachment!.relativePath.split("/")));
      return h.capture(request);
    });
    await expect(h.downloads.download(h.attachment.id, false)).rejects.toThrow("hard link");
    expect(h.vault.encrypted.size).toBe(0);
    expect(await readFile(external)).toEqual(h.bytes);
  });
  it("waits for the shared reader and honors disablement even after being queued", async () => {
    const h = await fixture();
    let release!: () => void;
    const foreground = h.reader.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    h.downloads.tick();
    expect(h.bridge.readMailThread).not.toHaveBeenCalled();
    release(); await foreground;
    h.setEnabled(false);
    h.downloads.tick();
    expect(h.bridge.readMailThread).not.toHaveBeenCalled();
  });
  it("upgrades legacy unknown-size metadata from a fresh native capture without downgrading retained files", async () => {
    const h = await fixture({ size: undefined, status: "awaiting-approval", reason: "The download size is unknown; approval is required before downloading." });
    const archive = new BrowserArchive(h.vault as unknown as Vault, async () => {}, () => {}, () => false);
    const input = h.capture({ accountId: h.account.id, accountEmail: h.account.email, threadId: "thread1",
      attachment: { metadataId: "native-file", name: "notes.txt", maxBytes: 1000, relativePath: "" } });
    delete input.attachmentDownload;
    input.messages[0].attachments![0].size = h.bytes.length;
    await archive.capture(input);
    expect(h.retained()).toMatchObject({ size: h.bytes.length, status: "pending" });
    h.downloads.tick(); await h.downloads.settled();
    expect(h.retained().status).toBe("indexed");
  });
  it("exposes only the attachment ID and explicit approval through IPC", () => {
    expect(commandSchema.safeParse({ type: "attachment.download", attachmentId: "id", approved: false }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "attachment.download", attachmentId: "id", approved: false, path: "C:\\secret.txt" }).success).toBe(false);
  });
  it.each([true, false])("refreshes missing legacy metadata without inventing files (verified empty list: %s)", async verified => {
    const h = await fixture();
    h.vault.records.delete(`attachments/${h.attachment.id}`);
    h.vault.put("messages", h.message.id, { ...h.message, browser: { ...h.message.browser, attachmentRevision: undefined, attachmentManifestVersion: undefined } });
    const archive = new BrowserArchive(h.vault as unknown as Vault, async () => {}, () => {}, () => false);
    h.bridge.readMailThread.mockImplementation(async request => {
      const capture = h.capture({ ...request, attachment: { metadataId: "native-file", name: "notes.txt", maxBytes: 1000, relativePath: "" } });
      delete capture.attachmentDownload;
      capture.messages[0].attachments = verified ? [] : undefined;
      capture.messages[0].attachmentManifestVersion = verified ? 1 : undefined;
      return capture;
    });
    const reader = new BrowserMailReader(h.vault, h.bridge, input => archive.capture(input), () => false, () => false, () => 0);
    const downloads = new BrowserAttachmentDownloads(h.vault, h.bridge, reader, h.processor, h.hooks);
    downloads.tick(); await downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
    expect(h.bridge.readMailThread.mock.calls[0][0].attachment).toBeUndefined();
    expect(h.vault.all("attachments")).toEqual([]);
    expect(h.vault.get<Message>("messages", h.message.id)?.browser?.attachmentManifestVersion === 1).toBe(verified);
    expect(h.vault.get("checkpoints", `browser-attachment-metadata:${h.message.threadId}`))
      .toMatchObject({ state: verified ? "complete" : "failed" });
    downloads.tick(); await downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledOnce();
  });
  it("refreshes an already-complete cached thread with old empty metadata once, preserving edited drafts and body revisions", async () => {
    const h = await fixture();
    h.vault.records.delete(`attachments/${h.attachment.id}`);
    const archive = new BrowserArchive(h.vault as unknown as Vault, async () => {}, () => {}, () => false);
    const legacy = h.capture({ accountId: h.account.id, accountEmail: h.account.email, threadId: "thread1",
      attachment: { metadataId: "native-file", name: "notes.txt", maxBytes: 1000, relativePath: "" } });
    delete legacy.attachmentDownload;
    legacy.messages[0].attachments = [];
    delete legacy.messages[0].attachmentManifestVersion;
    h.bridge.readMailThread.mockResolvedValue(legacy);
    const reader = new BrowserMailReader(h.vault, h.bridge, input => archive.capture(input), () => false, () => false, () => 0);
    await reader.load(h.message.id, true);
    const old = h.vault.get<Message>("messages", h.message.id)!;
    expect(reader.hasCachedThread(old)).toBe(true);
    expect(old.browser?.attachmentRevision).toBeTruthy();
    expect(old.browser?.attachmentManifestVersion).toBeUndefined();
    h.vault.put("drafts", "edited", { id: "edited", messageId: old.id, status: "local", body: "User edited this reply.", sourceRevision: old.revision });
    h.bridge.readMailThread.mockResolvedValue({
      ...legacy, messages: legacy.messages.map(message => ({ ...message, attachmentManifestVersion: 1 }))
    });
    const downloads = new BrowserAttachmentDownloads(h.vault, h.bridge, reader, h.processor, h.hooks);
    downloads.tick(); await downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(h.vault.get<Message>("messages", old.id)).toMatchObject({
      revision: old.revision, browser: { attachmentManifestVersion: 1 }
    });
    expect(h.vault.get("drafts", "edited")).toMatchObject({ status: "local", body: "User edited this reply.", sourceRevision: old.revision });
    expect(h.vault.all("attachments")).toEqual([]);
    downloads.tick(); await downloads.settled();
    expect(h.bridge.readMailThread).toHaveBeenCalledTimes(2);
  });
});
