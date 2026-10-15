import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Collection, Message, Settings, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { BrowserBridge } from "../src/main/browser/bridge";
import type { Vault } from "../src/main/storage/vault";
import { defaultSettings } from "../src/shared/defaults";
import { browserAccountId } from "../src/main/browser/archive";
import { commandSchema } from "../src/main/ipc/schema";

const bridge = vi.hoisted(() => ({
  paired: true,
  readMailThread: vi.fn<BrowserBridge["readMailThread"]>(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}));
vi.mock("../src/main/browser/bridge", () => ({
  BrowserBridge: class {
    readMailThread = bridge.readMailThread;
    start = bridge.start;
    stop = bridge.stop;
    status = () => ({ paired: bridge.paired, running: true, port: 0 });
  },
}));
vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({
  ConnectorHub: class { resolveBrowserThread = vi.fn(); sync = vi.fn(); downloadAttachment = vi.fn(); hasGmailReadConfiguration = vi.fn(() => false); },
}));
vi.mock("../src/main/copilot", () => ({
  CopilotAdapter: class {
    status = { status: "disconnected", message: "AI is disconnected." };
    models = [];
    generate = vi.fn();
    chat = vi.fn();
    stop = vi.fn(async () => undefined);
  },
}));
vi.mock("../src/main/retrieval", () => ({
  Retrieval: class {
    indexMessage = vi.fn(async () => undefined);
    configure = vi.fn(async () => undefined);
    stats = () => ({ indexed: 0, mode: "keyword" });
  },
}));
vi.mock("../src/main/attachments", () => ({ AttachmentProcessor: class { process = vi.fn(); } }));
import { RelayService } from "../src/main/service";

class MemoryVault {
  private data = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined { return structuredClone(this.data.get(`${collection}/${id}`)) as T | undefined; }
  put(collection: Collection, id: string, value: unknown) { this.data.set(`${collection}/${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  delete(collection: Collection, id: string) { this.data.delete(`${collection}/${id}`); }
  transaction<T>(work: () => T): T { return work(); }
  count(collection: Collection) { return this.all(collection).length; }
  listMessages(limit = 500) { return this.all<Message>("messages").slice(0, limit); }
  bytes() { return 0; }
}
function capture(email: string, threadId: string): BrowserCapture {
  return {
    accountEmail: email, accountName: email, kind: "mail",
    pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
    messages: [1, 2].map(index => ({
      id: `${threadId}-actual-${index}`, threadId, subject: "Historical conversation", sender: "sender@example.org",
      recipients: [email], body: `Entire body ${index}: historical details for local retrieval.`,
      html: `<p>Entire <b>body ${index}</b></p>`, receivedAt: "2025-01-01T00:00:00Z", dateText: "Last year",
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`, unread: true, completeness: "full",
    })),
  };
}
function addThread(vault: MemoryVault, thread = "thread-A", email = "a@example.org"): Message {
  const accountId = browserAccountId(email), sourceId = `${accountId}:mail`;
  if (!vault.get("accounts", accountId)) vault.put("accounts", accountId, {
    id: accountId, provider: "gmail", connection: "browser", email, name: email,
    consent: true, aiEnabled: false, status: "connected",
  } satisfies Account);
  if (!vault.get("sources", sourceId)) vault.put("sources", sourceId, {
    id: sourceId, accountId, providerId: "mail", name: "Gmail", kind: "mail", selected: true,
  } satisfies Source);
  const preview: Message = {
    id: `${accountId}:message:thread%3A${thread}`, accountId, sourceId, providerId: `thread:${thread}`,
    threadId: `${accountId}:thread:${thread}`, subject: "Historical conversation", sender: "sender@example.org",
    recipients: [], body: "Only a snippet", receivedAt: "", unread: true, revision: "preview", historical: true,
    url: `https://mail.google.com/mail/#inbox/${thread}`,
    browser: { completeness: "preview", capturedAt: "2025-01-01T00:00:00Z", dateText: "Last year" },
  };
  vault.put("messages", preview.id, preview);
  return preview;
}
const services: RelayService[] = [];
function fixture(vault = new MemoryVault()) {
  const host = {
    changed: vi.fn(), openExternal: vi.fn(async () => undefined), copy: vi.fn(), loginCopilot: vi.fn(async () => undefined),
    backupPath: vi.fn(async () => undefined), restorePath: vi.fn(async () => undefined),
    settingsChanged: vi.fn(), notify: vi.fn(), browserExtensionId: "a".repeat(32),
  };
  const service = new RelayService(vault as unknown as Vault, "tests\\fixtures\\synthetic-full-mail", host);
  services.push(service);
  return { service, vault, host };
}
const tick = () => vi.advanceTimersByTimeAsync(1000);
function settings(vault: MemoryVault, patch: Partial<Settings>) {
  vault.put("settings", "preferences", { ...defaultSettings, ...vault.get<Settings>("settings", "preferences"), ...patch });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  vi.clearAllMocks();
  bridge.paired = true;
  bridge.readMailThread.mockReset();
  bridge.readMailThread.mockImplementation(async (input, guard) => { guard(); return capture(input.accountEmail, input.threadId); });
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  vi.useRealTimers();
});

describe("default automatic full Gmail archive and local RAG", () => {
  it("migrates missing settings to ON and hydrates old previews without AI, startup blocking, or a click", async () => {
    const vault = new MemoryVault(), preview = addThread(vault);
    const { browserFullMailDownload: _missing, ...oldSettings } = defaultSettings;
    vault.put("settings", "preferences", { ...oldSettings, backgroundAi: false, aiRunsToday: 20,
      aiUsageDate: new Date().toISOString().slice(0, 10) });
    const f = fixture(vault);
    expect(defaultSettings.browserFullMailDownload).toBe(true);
    expect(f.service.settings().browserFullMailDownload).toBe(true);
    await f.service.initialize();
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ enabled: true, running: false, complete: 1, queued: 0, failed: 0, total: 1 });
    const full = vault.all<Message>("messages").filter(item => item.browser?.completeness === "full");
    expect(full).toHaveLength(2);
    full.forEach((message, index) => {
      expect(message.providerId).toBe(`thread-A-actual-${index + 1}`);
      expect(message.body).toContain("historical details");
      expect(message.html).toBe(capture("a@example.org", "thread-A").messages[index].html);
      expect(f.service.retrieval.indexMessage).toHaveBeenCalledWith(message);
    });
    expect(vault.get("messages", preview.id)).toEqual(preview);
    expect(vault.get("checkpoints", `browser-mail:${preview.threadId}`)).toMatchObject({ messageIds: full.map(item => item.id) });
    expect(f.service.copilot.generate).not.toHaveBeenCalled();
    expect(f.service.copilot.chat).not.toHaveBeenCalled();
    expect(f.service.connectors.sync).not.toHaveBeenCalled();
    expect(vault.all("drafts")).toEqual([]);
    expect(vault.all("actions")).toEqual([]);
    expect(f.service.settings().aiRunsToday).toBe(20);
    f.host.changed.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    expect(f.host.changed).not.toHaveBeenCalled();
    expect(vault.get("checkpoints", "browser-full-mail:coverage")).toMatchObject({ complete: 1 });
  });

  it("honors explicit opt-out across restart; retry does not enable downloads or permissions", async () => {
    const f = fixture(), preview = addThread(f.vault);
    settings(f.vault, { browserFullMailDownload: false });
    await f.service.initialize();
    await tick();
    await f.service.command({ type: "message.downloadAll" });
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ enabled: false, queued: 1 });
    await f.service.stop();
    const restarted = fixture(f.vault);
    await restarted.service.initialize(); await tick();
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(restarted.service.settings().backgroundAi).toBe(false);
    expect(f.vault.get<Account>("accounts", preview.accountId)?.aiEnabled).toBe(false);
    await restarted.service.command({ type: "settings.update", patch: { browserFullMailDownload: true } });
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
  });

  it.each(["pause", "unpaired", "unselected", "no-consent", "disconnected", "demo", "api", "non-gmail"] as const)(
    "honors %s without consuming browser reads", async condition => {
      const f = fixture(), preview = addThread(f.vault);
      const account = f.vault.get<Account>("accounts", preview.accountId)!;
      if (condition === "pause") settings(f.vault, { syncPaused: true });
      if (condition === "unpaired") bridge.paired = false;
      if (condition === "unselected") f.vault.put("sources", preview.sourceId, { ...f.vault.get<Source>("sources", preview.sourceId), selected: false });
      if (condition === "no-consent") f.vault.put("accounts", account.id, { ...account, consent: false });
      if (condition === "disconnected") f.vault.put("accounts", account.id, { ...account, status: "disconnected" });
      if (condition === "demo") f.vault.put("accounts", account.id, { ...account, demo: true });
      if (condition === "api") f.vault.put("accounts", account.id, { ...account, connection: "api" });
      if (condition === "non-gmail") f.vault.put("accounts", account.id, { ...account, provider: "microsoft" });
      await f.service.initialize(); await tick();
      await f.service.command({ type: "message.downloadAll" });
      expect(bridge.readMailThread).not.toHaveBeenCalled();
      expect(f.service.snapshot().fullMailArchive?.queued).toBe(["pause", "unpaired"].includes(condition) ? 1 : 0);
    });

  it("resumes after pause and runs independently of the global AI busy flag and budget", async () => {
    const f = fixture(); addThread(f.vault);
    settings(f.vault, { syncPaused: true, dailyAiLimit: 1, aiRunsToday: 1 });
    Object.assign(f.service, { aiBusy: true });
    await f.service.initialize(); await tick();
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    await f.service.command({ type: "settings.update", patch: { syncPaused: false } });
    await tick();
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(1);
    expect(f.service.copilot.generate).not.toHaveBeenCalled();
  });

  it("does not launch during archive maintenance and resumes after it finishes", async () => {
    const f = fixture(); addThread(f.vault);
    Object.assign(f.service, { restoring: true });
    await f.service.initialize(); await tick();
    await expect(f.service.command({ type: "message.downloadAll" })).rejects.toThrow("restore is in progress");
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(f.service.snapshot().fullMailArchive?.queued).toBe(1);
    Object.assign(f.service, { restoring: false });
    await tick();
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(1);
  });

  it("persists failures, continues other threads, and resumes backoff across restart with explicit retry", async () => {
    const f = fixture(), preview = addThread(f.vault);
    addThread(f.vault, "thread-B");
    bridge.readMailThread.mockRejectedValueOnce(new Error("The captured Gmail row is no longer loaded."));
    await f.service.initialize(); await tick();
    const failed = f.service.snapshot().fullMailArchive!;
    expect(failed).toMatchObject({ failed: 1, queued: 1, complete: 0, lastError: expect.stringContaining("no longer loaded") });
    expect(Date.parse(failed.nextRetryAt!) - Date.now()).toBe(300_000);
    await tick();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ failed: 1, complete: 1, queued: 0 });
    await f.service.stop();
    const restarted = fixture(f.vault);
    await restarted.service.initialize(); await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(restarted.service.snapshot().fullMailArchive?.failed).toBe(1);
    await restarted.service.command({ type: "message.downloadAll" });
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(3);
    expect(restarted.service.snapshot().fullMailArchive).toMatchObject({ complete: 2, failed: 0 });
    expect(f.vault.get<Account>("accounts", preview.accountId)?.aiEnabled).toBe(false);
  });

  it("uses bounded 5–30 minute retry delays rather than hammering unavailable rows each second", async () => {
    const f = fixture(); addThread(f.vault);
    bridge.readMailThread.mockRejectedValue(new Error("Missing row; recapture the loaded Gmail inbox."));
    await f.service.initialize(); await tick();
    for (const minutes of [5, 10, 20, 30, 30]) {
      const status = f.service.snapshot().fullMailArchive!;
      expect(Date.parse(status.nextRetryAt!) - Date.now()).toBe(minutes * 60_000);
      const calls = bridge.readMailThread.mock.calls.length;
      await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1000);
      expect(bridge.readMailThread).toHaveBeenCalledTimes(calls);
      await tick();
      expect(bridge.readMailThread).toHaveBeenCalledTimes(calls + 1);
    }
  });

  it("recovers an interrupted running checkpoint without treating it as complete or immediately retrying", async () => {
    const f = fixture(), preview = addThread(f.vault);
    f.vault.put("checkpoints", `browser-full-mail:${preview.threadId}`, {
      kind: "browser-full-mail", accountId: preview.accountId, threadId: preview.threadId,
      state: "running", attempts: 1, nextRetryAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await f.service.initialize(); await tick();
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({
      running: false, complete: 0, failed: 1, lastError: expect.stringContaining("interrupted"),
    });
    await f.service.command({ type: "message.downloadAll" }); await tick();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ complete: 1, failed: 0 });
  });

  it("persists indexing errors without claiming completeness and retries the full body index", async () => {
    const f = fixture(), preview = addThread(f.vault);
    vi.mocked(f.service.retrieval.indexMessage).mockRejectedValueOnce(new Error("Local index is unavailable"));
    await f.service.initialize(); await tick();
    expect(f.service.snapshot().fullMailArchive).toMatchObject({
      complete: 0, failed: 1, lastError: "Local index is unavailable",
    });
    expect(f.vault.get("checkpoints", `browser-mail:${preview.threadId}`)).toBeUndefined();
    await f.service.command({ type: "message.downloadAll" }); await tick();
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledTimes(3);
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(1);
  });

  it("deduplicates account/thread, rotates fairly among three accounts, and retains selected sources", async () => {
    const f = fixture();
    for (const email of ["a@example.org", "b@example.org", "c@example.org"])
      for (const thread of ["one", "two"]) addThread(f.vault, thread, email);
    const original = f.vault.all<Message>("messages")[0];
    f.vault.put("messages", "duplicate-preview", { ...original, id: "duplicate-preview" });
    await f.service.initialize();
    for (let i = 0; i < 6; i++) await tick();
    expect(bridge.readMailThread.mock.calls.map(([input]) => input.accountEmail)).toEqual([
      "a@example.org", "b@example.org", "c@example.org", "a@example.org", "b@example.org", "c@example.org",
    ]);
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ complete: 6, total: 6 });
    expect(f.vault.all<Source>("sources").every(source => source.selected)).toBe(true);
  });

  it("does not count a lone full record or a damaged whole-thread cache as complete", async () => {
    const f = fixture(), preview = addThread(f.vault);
    f.vault.put("messages", "lone-full", { ...preview, id: "lone-full", providerId: "actual-id",
      browser: { ...preview.browser, completeness: "full" } });
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ complete: 0, queued: 1 });
    await f.service.initialize(); await tick();
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(1);
    const id = f.vault.all<Message>("messages").find(item => item.providerId === "thread-A-actual-1")!.id;
    f.vault.delete("messages", id);
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(0);
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(1);
  });

  it("reloads changed previews, but never redownloads unchanged completed threads on restart", async () => {
    const f = fixture(), preview = addThread(f.vault);
    await f.service.initialize(); await tick();
    await f.service.stop();
    const restarted = fixture(f.vault);
    await restarted.service.initialize(); await tick();
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    f.vault.put("messages", preview.id, { ...preview, revision: "new-reply-preview", body: "New reply snippet" });
    expect(restarted.service.snapshot().fullMailArchive?.queued).toBe(1);
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
  });

  it("waits for foreground reads and queues manual loads behind the single active browser path", async () => {
    const f = fixture(), first = addThread(f.vault), second = addThread(f.vault, "thread-B");
    const third = addThread(f.vault, "thread-C"), fourth = addThread(f.vault, "thread-D");
    const pending = deferred<BrowserCapture>();
    bridge.readMailThread.mockReturnValueOnce(pending.promise);
    const manual = f.service.command({ type: "message.load", messageId: first.id });
    await f.service.initialize(); await tick(); await tick();
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    pending.resolve(capture("a@example.org", "thread-A")); await manual;
    const automatic = deferred<BrowserCapture>();
    bridge.readMailThread.mockReturnValueOnce(automatic.promise);
    await tick(); await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(f.service.snapshot().fullMailArchive).toMatchObject({ running: true, currentAccountId: second.accountId });
    const heldForeground = deferred<BrowserCapture>();
    bridge.readMailThread.mockReturnValueOnce(heldForeground.promise);
    const manualAgain = f.service.command({ type: "message.load", messageId: third.id });
    const foreground = f.service.command({ type: "message.load", messageId: fourth.id });
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    automatic.resolve(capture("a@example.org", "thread-B")); await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(3);
    heldForeground.resolve(capture("a@example.org", "thread-C")); await manualAgain;
    expect((await foreground).messageThread?.messages).toHaveLength(2);
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(4);
    expect(f.service.snapshot().fullMailArchive?.complete).toBe(4);
  });

  it.each(["pause", "opt-out", "source", "pairing"] as const)("discards a pending automatic capture after %s changes", async condition => {
    const f = fixture(), preview = addThread(f.vault), pending = deferred<BrowserCapture>();
    bridge.readMailThread.mockReturnValueOnce(pending.promise);
    await f.service.initialize(); await tick();
    if (condition === "pause") {
      await f.service.command({ type: "settings.update", patch: { syncPaused: true } });
      await f.service.command({ type: "settings.update", patch: { syncPaused: false } });
    }
    if (condition === "opt-out") {
      await f.service.command({ type: "settings.update", patch: { browserFullMailDownload: false } });
      await f.service.command({ type: "settings.update", patch: { browserFullMailDownload: true } });
    }
    if (condition === "source") {
      await f.service.command({ type: "source.select", sourceId: preview.sourceId, selected: false });
      await f.service.command({ type: "source.select", sourceId: preview.sourceId, selected: true });
    }
    if (condition === "pairing") bridge.paired = false;
    pending.resolve(capture("a@example.org", "thread-A")); await tick();
    expect(f.service.retrieval.indexMessage).not.toHaveBeenCalled();
    expect(f.vault.all<Message>("messages")).toEqual([preview]);
    expect(f.service.snapshot().fullMailArchive?.failed).toBe(1);
  });

  it("does not claim a preview changed during an in-flight load is covered by that older read", async () => {
    const f = fixture(), preview = addThread(f.vault), pending = deferred<BrowserCapture>();
    bridge.readMailThread.mockReturnValueOnce(pending.promise);
    await f.service.initialize(); await tick();
    f.vault.put("messages", preview.id, { ...preview, revision: "changed-during-read" });
    pending.resolve(capture("a@example.org", "thread-A"));
    await Promise.resolve(); await Promise.resolve();
    await tick();
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
  });

  it("accepts only the ID-less retry command and normal boolean settings update", () => {
    expect(commandSchema.parse({ type: "message.downloadAll" })).toEqual({ type: "message.downloadAll" });
    for (const extra of [{ accountId: "other" }, { sourceId: "other" }, { aiEnabled: true }, { url: "https://example.org" }])
      expect(commandSchema.safeParse({ type: "message.downloadAll", ...extra }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "settings.update", patch: { browserFullMailDownload: true } }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "settings.update", patch: { browserFullMailDownload: "yes" } }).success).toBe(false);
  });
});
