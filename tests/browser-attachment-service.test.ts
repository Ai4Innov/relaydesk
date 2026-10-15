import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Job, Message, Source } from "../src/shared/contracts";
import type { Vault } from "../src/main/storage/vault";
import { defaultSettings } from "../src/shared/defaults";
import { browserAccountId, browserAttachmentId } from "../src/main/browser/archive";
import { BrowserAttachmentDownloads } from "../src/main/browser/attachment-download";

vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({
  ConnectorHub: class {
    downloadAttachment = vi.fn();
    sync = vi.fn();
  }
}));
vi.mock("../src/main/copilot", () => ({
  CopilotAdapter: class {
    status = { status: "ready", message: "Synthetic" };
    models = [];
    stop = vi.fn(async () => {});
  }
}));
vi.mock("../src/main/retrieval", () => ({
  Retrieval: class {
    configure = vi.fn(async () => {});
    stats = () => ({ indexed: 0, mode: "keyword" });
  }
}));
vi.mock("../src/main/attachments", () => ({
  AttachmentProcessor: class { process = vi.fn(async () => {}); }
}));
import { RelayService } from "../src/main/service";

class MemoryVault {
  data = new Map<string, unknown>();
  readBlob = vi.fn(async () => Buffer.from("Local document"));
  localDocumentChunks = vi.fn(() => []);
  get<T>(collection: Collection, id: string): T | undefined { return structuredClone(this.data.get(`${collection}/${id}`)) as T | undefined; }
  put(collection: Collection, id: string, value: unknown) { this.data.set(`${collection}/${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  delete(collection: Collection, id: string) { this.data.delete(`${collection}/${id}`); }
  transaction<T>(work: () => T): T { return work(); }
  count(collection: Collection) { return this.all(collection).length; }
  listMessages() { return this.all<Message>("messages"); }
  bytes() { return 0; }
}
const services: RelayService[] = [], directories: string[] = [];
function fixture() {
  const vault = new MemoryVault(), accountId = browserAccountId("synthetic@example.org"), sourceId = `${accountId}:mail`;
  const account: Account = { id: accountId, provider: "gmail", connection: "browser", email: "synthetic@example.org",
    name: "Synthetic", consent: true, aiEnabled: false, status: "connected" };
  const message: Message = { id: `${accountId}:message:synthetic`, accountId, sourceId, providerId: "synthetic",
    threadId: "synthetic", subject: "Synthetic", sender: "sender@example.org", recipients: [], body: "Synthetic",
    receivedAt: "", url: "https://mail.google.com/mail/#inbox", unread: false, revision: "synthetic", historical: true,
    browser: { completeness: "full", capturedAt: "2026-09-22T00:00:00Z", dateText: "" } };
  const metadata = { id: "notes.txt", name: "notes.txt", mimeType: "application/octet-stream" };
  const attachment: Attachment = { ...metadata, id: browserAttachmentId(accountId, message.id, metadata), accountId,
    messageId: message.id, providerId: metadata.id, status: "pending", browser: { source: "browser_gmail", metadataId: metadata.id } };
  vault.put("accounts", accountId, account);
  vault.put("sources", sourceId, { id: sourceId, accountId, providerId: "mail", kind: "mail", selected: true, name: "Gmail" } satisfies Source);
  vault.put("messages", message.id, message);
  vault.put("attachments", attachment.id, attachment);
  vault.put("settings", "preferences", { ...defaultSettings, semanticEnabled: false, refreshIntervalSeconds: 30 });
  const picker = vi.fn<() => Promise<string | undefined>>(async () => undefined);
  const savePicker = vi.fn<(name: string) => Promise<string | undefined>>(async () => undefined);
  const service = new RelayService(vault as unknown as Vault, "synthetic", {
    changed: vi.fn(), openExternal: vi.fn(async () => {}), copy: vi.fn(), loginCopilot: vi.fn(async () => {}),
    backupPath: vi.fn(async () => undefined), restorePath: vi.fn(async () => undefined),
    importAttachmentPath: picker, saveAttachmentPath: savePicker, settingsChanged: vi.fn(), notify: vi.fn()
  });
  services.push(service);
  return { service, vault, picker, savePicker, attachment, account, sourceId };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("browser attachment service routing", () => {
  it("defers pending API attachment processing while a browser attachment owns the worker", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.vault.put("accounts", h.account.id, { ...h.account, connection: "api" });
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, browser: undefined });
    h.vault.put("settings", "preferences", { ...defaultSettings, semanticEnabled: false, refreshIntervalSeconds: 0 });
    const busy = vi.spyOn(BrowserAttachmentDownloads.prototype, "running", "get").mockReturnValue(true);
    try {
      await h.service.initialize();
      const commands = vi.spyOn(h.service, "command");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commands).not.toHaveBeenCalledWith(expect.objectContaining({ type: "attachment.process" }));
      expect(h.service.attachments.process).not.toHaveBeenCalled();
    } finally { busy.mockRestore(); }
  });

  it("publishes trusted access metadata for older cited parents outside the bounded inbox snapshot", async () => {
    const h = fixture();
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, hash: "retained", size: 14,
      parentAvailable: false, sourceId: "forged-stored-source" });
    const inbox = Array.from({ length: 500 }, (_, index) => ({
      ...h.vault.get<Message>("messages", h.attachment.messageId)!, id: `recent-${index}`
    }));
    vi.spyOn(h.vault, "listMessages").mockReturnValue(inbox);
    const snapshot = h.service.snapshot();
    expect(snapshot.messages).toHaveLength(500);
    expect(snapshot.messages.some(message => message.id === h.attachment.messageId)).toBe(false);
    expect(snapshot.attachments.find(attachment => attachment.id === h.attachment.id))
      .toMatchObject({ parentAvailable: true, sourceId: h.sourceId, accountId: h.account.id });
    expect(snapshot.accounts.find(account => account.id === h.account.id)?.aiEnabled).toBe(false);
    expect((await h.service.command({ type: "attachment.view", attachmentId: h.attachment.id })).attachmentView)
      .toMatchObject({ kind: "text", text: "Local document" });
    h.vault.put("messages", h.attachment.messageId, {
      ...h.vault.get<Message>("messages", h.attachment.messageId), deleted: true
    });
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, parentAvailable: true, sourceId: h.sourceId });
    const revoked = h.service.snapshot().attachments.find(attachment => attachment.id === h.attachment.id)!;
    expect(revoked.parentAvailable).toBe(false);
    expect(revoked.sourceId).toBeUndefined();
    await expect(h.service.command({ type: "attachment.view", attachmentId: h.attachment.id }))
      .rejects.toThrow("Document access");
  });
  it("separates explicit account ingestion consent from AI and source selection", async () => {
    const h = fixture();
    h.vault.put("accounts", h.account.id, { ...h.account, provider: "whatsapp", consent: false });
    h.vault.put("sources", h.sourceId, { ...h.vault.get<Source>("sources", h.sourceId), selected: false });
    await h.service.command({ type: "account.consent", accountId: h.account.id, enabled: true });
    expect(h.vault.get<Account>("accounts", h.account.id)).toMatchObject({ consent: true, aiEnabled: false });
    expect(h.vault.get<Source>("sources", h.sourceId)?.selected).toBe(false);
    h.vault.put("accounts", h.account.id, { ...h.vault.get<Account>("accounts", h.account.id), aiEnabled: true });
    await h.service.command({ type: "account.consent", accountId: h.account.id, enabled: false });
    expect(h.vault.get<Account>("accounts", h.account.id)).toMatchObject({ consent: false, aiEnabled: false });
    await h.service.command({ type: "account.consent", accountId: h.account.id, enabled: true });
    expect(h.vault.get<Account>("accounts", h.account.id)?.aiEnabled).toBe(false);
    h.vault.put("accounts", h.account.id, { ...h.account, status: "disconnected" });
    await expect(h.service.command({ type: "account.consent", accountId: h.account.id, enabled: true }))
      .rejects.toThrow("Connect this account");
  });
  it("invalidates an open document operation when account consent is revoked and reenabled", async () => {
    const h = fixture();
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, hash: "retained", size: 14 });
    h.vault.readBlob.mockImplementation(async () => {
      await h.service.command({ type: "account.consent", accountId: h.account.id, enabled: false });
      await h.service.command({ type: "account.consent", accountId: h.account.id, enabled: true });
      return Buffer.from("Local document");
    });
    await expect(h.service.command({ type: "attachment.view", attachmentId: h.attachment.id })).rejects.toThrow("revoked");
  });
  it("views a retained original and cancels saving without AI or automatic downloads", async () => {
    const h = fixture();
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, hash: "retained", size: 14 });
    h.vault.put("settings", "preferences", { ...defaultSettings, syncPaused: true });
    expect((await h.service.command({ type: "attachment.view", attachmentId: h.attachment.id })).attachmentView)
      .toMatchObject({ kind: "text", text: "Local document", canSave: true });
    expect((await h.service.command({ type: "attachment.save", attachmentId: h.attachment.id })).attachmentSave)
      .toMatchObject({ status: "cancelled" });
    expect(h.savePicker).toHaveBeenCalledWith("notes.txt");
    expect(h.service.attachments.process).not.toHaveBeenCalled();
    expect(h.service.connectors.downloadAttachment).not.toHaveBeenCalled();
    expect(h.vault.get<Account>("accounts", h.account.id)?.aiEnabled).toBe(false);
  });
  it("invalidates in-flight document access even if a source is immediately reselected", async () => {
    const h = fixture();
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, hash: "retained", size: 14 });
    h.vault.readBlob.mockImplementation(async () => {
      await h.service.command({ type: "source.select", sourceId: h.sourceId, selected: false });
      await h.service.command({ type: "source.select", sourceId: h.sourceId, selected: true });
      return Buffer.from("Local document");
    });
    await expect(h.service.command({ type: "attachment.view", attachmentId: h.attachment.id })).rejects.toThrow("revoked");
  });
  it("never automatically processes browser metadata when background sync ticks", async () => {
    vi.useFakeTimers();
    const h = fixture();
    await h.service.initialize();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.service.attachments.process).not.toHaveBeenCalled();
    expect(h.service.connectors.downloadAttachment).not.toHaveBeenCalled();
    expect(h.picker).not.toHaveBeenCalled();
    expect(h.vault.all("jobs")).toHaveLength(0);
  });
  it("rejects the API processing command for metadata-only browser attachments", async () => {
    const h = fixture();
    await expect(h.service.command({ type: "attachment.process", attachmentId: h.attachment.id, approved: true }))
      .rejects.toThrow("Import downloaded file");
    expect(h.service.attachments.process).not.toHaveBeenCalled();
    expect(h.service.connectors.downloadAttachment).not.toHaveBeenCalled();
  });
  it("requires explicit native file selection and carries no path in persisted job commands", async () => {
    const h = fixture(), directory = await mkdtemp(join(tmpdir(), "relay-attachment-service-"));
    directories.push(directory);
    const path = join(directory, "notes.txt");
    await writeFile(path, "Synthetic");
    h.picker.mockResolvedValue(path);
    const command = { type: "attachment.import" as const, attachmentId: h.attachment.id, approved: false };
    await h.service.command(command);
    expect(h.picker).toHaveBeenCalledOnce();
    expect(h.service.attachments.process).toHaveBeenCalledWith(h.attachment.id, false, expect.any(AbortSignal),
      expect.objectContaining({ size: 9, open: expect.any(Function), validate: expect.any(Function) }));
    expect(h.vault.all<Job>("jobs").map(job => h.vault.get("checkpoints", `job:${job.id}`))).toEqual([command]);
    expect(h.service.connectors.downloadAttachment).not.toHaveBeenCalled();
    expect(h.vault.get<Account>("accounts", h.account.id)?.aiEnabled).toBe(false);
  });
  it("does not read or process after cancellation or source exclusion in the picker", async () => {
    const h = fixture();
    expect((await h.service.command({ type: "attachment.import", attachmentId: h.attachment.id, approved: false })).message)
      .toContain("cancelled");
    h.picker.mockImplementation(async () => {
      h.vault.put("sources", h.sourceId, { ...h.vault.get<Source>("sources", h.sourceId), selected: false });
      return "C:\\not-read\\notes.txt";
    });
    await expect(h.service.command({ type: "attachment.import", attachmentId: h.attachment.id, approved: false }))
      .rejects.toThrow("requires");
    expect(h.service.attachments.process).not.toHaveBeenCalled();
  });
  it("retries only the retained encrypted original without another file picker or API download", async () => {
    const h = fixture();
    h.vault.put("attachments", h.attachment.id, { ...h.attachment, hash: "retained", status: "blocked", size: 9 });
    await h.service.command({ type: "attachment.process", attachmentId: h.attachment.id, approved: true });
    expect(h.service.attachments.process).toHaveBeenCalledWith(h.attachment.id, true, expect.any(AbortSignal),
      expect.objectContaining({ validate: expect.any(Function) }));
    expect(h.picker).not.toHaveBeenCalled();
    expect(h.service.connectors.downloadAttachment).not.toHaveBeenCalled();
  });
});
