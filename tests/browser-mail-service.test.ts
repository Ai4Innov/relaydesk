import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { BrowserBridge } from "../src/main/browser/bridge";
import type { Vault } from "../src/main/storage/vault";
import { defaultSettings } from "../src/shared/defaults";
import { browserAccountId } from "../src/main/browser/archive";

const bridge = vi.hoisted(() => ({
  readMailThread: vi.fn<BrowserBridge["readMailThread"]>(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  requestRefresh: vi.fn(),
}));
const gmail = vi.hoisted(() => ({
  read: vi.fn(), page: vi.fn(), configured: vi.fn(() => true), download: vi.fn(),
}));
const processAttachment = vi.hoisted(() => vi.fn());
vi.mock("../src/main/browser/bridge", () => ({
  BrowserBridge: class {
    readMailThread = bridge.readMailThread;
    start = bridge.start;
    stop = bridge.stop;
    requestRefresh = bridge.requestRefresh;
    status = () => ({ paired: true, running: false, port: 0 });
  },
}));
vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({
  ConnectorHub: class {
    hasGmailReadConfiguration = gmail.configured;
    readGmailMail = gmail.read;
    readGmailThreadPage = gmail.page;
    downloadLinkedGmailAttachment = gmail.download;
    resolveBrowserThread = vi.fn();
    sync = vi.fn();
    downloadAttachment = vi.fn();
  },
}));
vi.mock("../src/main/copilot", () => ({
  CopilotAdapter: class {
    status = { status: "disconnected", message: "No AI connection in this test." };
    models = [];
    generate = vi.fn();
    chat = vi.fn();
    stop = vi.fn(async () => undefined);
  },
}));
vi.mock("../src/main/retrieval", () => ({
  Retrieval: class {
    indexMessage = vi.fn(async () => undefined);
    stats = () => ({ indexed: 0, mode: "keyword" });
  },
}));
vi.mock("../src/main/attachments", () => ({
  AttachmentProcessor: class { process = processAttachment; },
}));
import { RelayService } from "../src/main/service";
import { PlaywrightMailBrowser, PlaywrightMailError } from "../src/main/browser/playwright-mail";

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
const accountId = browserAccountId("service-reader@example.org");
const sourceId = `${accountId}:mail`;
const threadId = "exact-thread";
function capture(): BrowserCapture {
  return {
    accountEmail: "service-reader@example.org", accountName: "Service reader", kind: "mail",
    pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
    messages: [1, 2].map(index => ({
      id: `complete-${index}`, threadId, subject: "A complete conversation", sender: "sender@example.org",
      recipients: ["service-reader@example.org"], body: `Complete body ${index}`, html: `<p>Complete <b>body ${index}</b></p>`,
      receivedAt: `2026-09-23T0${index}:00:00Z`, dateText: "Today",
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`, unread: true, completeness: "full",
      attachments: index === 2 ? [{ id: "notes", name: "Notes.txt", mimeType: "text/plain" }] : [],
    })),
  };
}
const services: RelayService[] = [];
function fixture(managed = false) {
  const vault = new MemoryVault();
  vault.put("accounts", accountId, {
    id: accountId, provider: "gmail", connection: "browser", email: "service-reader@example.org",
    name: "Service reader", consent: true, aiEnabled: false, status: "connected",
  } satisfies Account);
  vault.put("sources", sourceId, { id: sourceId, accountId, providerId: "mail", name: "Gmail", kind: "mail", selected: true } satisfies Source);
  const preview: Message = {
    id: `${accountId}:message:thread%3A${threadId}`, accountId, sourceId, providerId: `thread:${threadId}`,
    threadId: `${accountId}:thread:${threadId}`, subject: "A complete conversation", sender: "sender@example.org",
    recipients: [], body: "Inbox snippet", receivedAt: "", unread: true, revision: "preview", historical: true,
    url: `https://mail.google.com/mail/#inbox/${threadId}`,
    browser: { completeness: "preview", capturedAt: "2026-09-23T00:00:00Z", dateText: "Today" },
  };
  vault.put("messages", preview.id, preview);
  vault.put("settings", "preferences", { ...defaultSettings, model: "", semanticEnabled: false, backgroundAi: true });
  const host = {
    changed: vi.fn(), openExternal: vi.fn(async () => undefined), copy: vi.fn(), loginCopilot: vi.fn(async () => undefined),
    backupPath: vi.fn(async () => undefined), restorePath: vi.fn(async () => undefined),
    settingsChanged: vi.fn(), notify: vi.fn(), browserExtensionId: "a".repeat(32),
    ...(managed ? { browserExtensionDirectory: "C:\\relay-synthetic\\extension", playwrightProfileDirectory: "C:\\relay-synthetic\\profile" } : {}),
  };
  const service = new RelayService(vault as unknown as Vault, "tests\\fixtures\\synthetic-mail-service", host);
  services.push(service);
  return { service, vault, preview, host };
}
beforeEach(() => {
  vi.clearAllMocks();
  bridge.readMailThread.mockReset();
  bridge.readMailThread.mockImplementation(async (_input, beforeRead) => { beforeRead(); return capture(); });
});
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });

describe("Gmail API routing through the existing unified inbox", () => {
  it("switches browser inboxes to the companion without changing source or AI consent", async () => {
    const f = fixture(true);
    const accounts = f.vault.all<Account>("accounts"), sources = f.vault.all<Source>("sources");
    f.vault.put("settings", "preferences", { ...defaultSettings, playwrightMailEnabled: true });
    await f.service.command({ type: "settings.update", patch: { browserMailTransport: "companion" } });
    expect(f.service.settings()).toMatchObject({ browserMailTransport: "companion", playwrightMailEnabled: false });
    const result = await f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true });
    expect(result.messageThread?.messages).toHaveLength(2);
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    expect(gmail.read).not.toHaveBeenCalled();
    expect(f.service.snapshot().mailTransports?.find(route => route.accountId === accountId)?.transport).toBe("companion");
    expect(f.vault.all<Account>("accounts").map(account => ({ ...account, lastSync: undefined, error: undefined })))
      .toEqual(accounts.map(account => ({ ...account, lastSync: undefined, error: undefined })));
    expect(f.vault.all<Source>("sources").map(source => ({ ...source, lastSync: undefined })))
      .toEqual(sources.map(source => ({ ...source, lastSync: undefined })));
  });
  it("rejects a pending read if the chosen transport is changed away and back", async () => {
    const f = fixture();
    let finish!: (capture: BrowserCapture) => void;
    bridge.readMailThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.service.command({ type: "settings.update", patch: { browserMailTransport: "companion" } });
    await f.service.command({ type: "settings.update", patch: { browserMailTransport: "auto" } });
    finish(capture());
    await expect(pending).rejects.toThrow(/revoked|changed/);
    expect(f.vault.all<Message>("messages")).toHaveLength(1);
  });
  function apiFixture() {
    const f = fixture();
    const apiAccount: Account = { ...f.vault.get<Account>("accounts", accountId)!,
      id: "gmail:service-reader@example.org", connection: undefined };
    const source: Source = { id: `${apiAccount.id}:mail:INBOX`, accountId: apiAccount.id,
      providerId: "INBOX", kind: "mail", name: "Inbox", selected: true };
    f.vault.put("accounts", apiAccount.id, apiAccount);
    f.vault.put("sources", source.id, source);
    gmail.read.mockImplementation(async (_account, _source, _input, guard) => {
      guard();
      return capture();
    });
    return { ...f, apiAccount, apiSource: source };
  }
  it("archives formatted API bodies and attachment origins without companion dispatch", async () => {
    const f = apiFixture();
    const result = await f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true });
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(gmail.read).toHaveBeenCalledOnce();
    expect(result.messageThread?.messages).toHaveLength(2);
    for (const message of result.messageThread!.messages) {
      expect(message.html).toContain("<b>");
      expect(message.gmailApi).toEqual({ accountId: f.apiAccount.id, sourceId: f.apiSource.id });
    }
    const attachment = f.vault.all<Attachment>("attachments")[0];
    expect(attachment.gmailApi).toEqual({ accountId: f.apiAccount.id, sourceId: f.apiSource.id });
    await f.service.command({ type: "attachment.download", attachmentId: attachment.id, approved: false });
    expect(processAttachment).toHaveBeenCalledWith(attachment.id, false, expect.any(AbortSignal),
      expect.objectContaining({ validate: expect.any(Function), open: expect.any(Function) }));
    const input = processAttachment.mock.calls.at(-1)![3];
    gmail.download.mockResolvedValue(new ReadableStream({ start(controller) { controller.close(); } }));
    await input.open(new AbortController().signal);
    expect(gmail.download).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), attachment,
      f.apiAccount.id, f.apiSource.id, expect.any(AbortSignal));
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(() => input.validate()).toThrow(/API/);
    expect(f.service.snapshot().messages.some(message => message.gmailApi)).toBe(false);
    expect(f.service.snapshot().attachments).toHaveLength(0);
  });
  it("does not fallback when this mailbox's configured API rejects access", async () => {
    const f = apiFixture();
    gmail.read.mockRejectedValue(new Error("Gmail API authorization expired"));
    await expect(f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true }))
      .rejects.toThrow(/authorization expired/);
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    expect(f.vault.all<Message>("messages")).toHaveLength(1);
  });
  it("reloads a native API conversation using provider revisions rather than returning the old cache", async () => {
    const f = apiFixture();
    const message: Message = { ...f.preview, id: `${f.apiAccount.id}:message:abc`,
      providerId: "abc", accountId: f.apiAccount.id, sourceId: f.apiSource.id,
      threadId: `${f.apiAccount.id}:thread:def`, browser: undefined, revision: "history-1" };
    f.vault.put("messages", message.id, message);
    gmail.page.mockResolvedValue({ messages: [{ ...message, body: "Full MIME body", html: "<p>Full MIME body</p>", revision: "history-2" }],
      attachments: [], events: [] });
    const result = await f.service.command({ type: "message.load", messageId: message.id, refresh: true });
    expect(gmail.page).toHaveBeenCalledWith(f.apiAccount, f.apiSource, "abc", expect.any(Function), expect.any(AbortSignal));
    expect(result.messageThread).toMatchObject({ cached: false, messages: [{ body: "Full MIME body", revision: "history-2" }] });
    expect(f.vault.get<Message>("messages", message.id)?.html).toBe("<p>Full MIME body</p>");
  });
  it("routes manual refresh through the exact managed inbox request contract", async () => {
    const f = fixture();
    await f.service.command({ type: "refresh.request" });
    expect(bridge.readMailThread).toHaveBeenCalledWith(expect.objectContaining({
      accountId, inboxRefresh: true, threadId: "__relay_inbox__"
    }), expect.any(Function), expect.any(AbortSignal));
  });
  it("keeps the app usable when managed-browser user pages prevent shutdown", async () => {
    const f = fixture(true);
    const close = vi.spyOn(PlaywrightMailBrowser.prototype, "close")
      .mockRejectedValueOnce(new PlaywrightMailError("busy")).mockResolvedValue(undefined);
    try {
      await expect(f.service.stop()).rejects.toMatchObject({ code: "busy" });
      expect(bridge.stop).not.toHaveBeenCalled();
      await expect(f.service.command({ type: "clipboard.copy", text: "synthetic" })).resolves.toMatchObject({ message: "Copied to clipboard." });
      await f.service.stop();
      expect(bridge.stop).toHaveBeenCalled();
    } finally { close.mockRestore(); }
  });
  it("persists a paused fallback after Google rejects automated sign-in without changing mailbox consent", async () => {
    const f = fixture(true);
    f.vault.put("settings", "preferences", { ...defaultSettings, playwrightMailEnabled: true });
    const account = f.vault.get<Account>("accounts", accountId);
    const read = vi.spyOn(PlaywrightMailBrowser.prototype, "readMailThread")
      .mockRejectedValue(new PlaywrightMailError("sign-in-blocked"));
    try {
      await expect(f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true })).rejects.toMatchObject({ code: "sign-in-blocked" });
      expect(f.service.settings().playwrightMailEnabled).toBe(false);
      expect(f.vault.get<Account>("accounts", accountId)).toEqual(account);
      await expect(f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true })).rejects.toThrow();
      expect(read).toHaveBeenCalledTimes(1);
      expect(bridge.readMailThread).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
});

describe("message.load service integration without a real browser bridge", () => {
  const refresh = (service: RelayService, force = true, scope = accountId, signal = new AbortController().signal) =>
    service.refreshMail({ accountId: scope, force, signal, progress: vi.fn() });
  function permit(f: ReturnType<typeof fixture>) {
    f.vault.put("accounts", accountId, { ...f.vault.get<Account>("accounts", accountId)!, aiEnabled: true });
  }
  function inbox(body = "Latest urgent request"): BrowserCapture {
    return { ...capture(), messages: [{ ...capture().messages[0], id: `thread:${threadId}`,
      body, html: undefined, attachments: undefined, completeness: "preview" }] };
  }
  it("awaits a scoped native inbox acknowledgement and full indexed bodies, then reuses only verified recent freshness", async () => {
    const f = fixture(); permit(f);
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      return input.inboxRefresh ? inbox() : capture();
    });
    const result = await refresh(f.service);
    expect(result).toMatchObject({ status: "fresh", sources: [{ accountId, sourceId, downloaded: 1, pending: 0 }] });
    expect(bridge.readMailThread.mock.calls.map(([input]) => input.inboxRefresh ?? false)).toEqual([true, false]);
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledTimes(3);
    expect(f.vault.all<Message>("messages").filter(message => message.browser?.completeness === "full")).toHaveLength(2);
    expect((await refresh(f.service, false)).status).toBe("fresh");
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect((await refresh(f.service)).status).toBe("fresh");
    expect(bridge.readMailThread).toHaveBeenCalledTimes(3);
    expect(f.service.copilot.generate).not.toHaveBeenCalled(); expect(f.service.copilot.chat).not.toHaveBeenCalled();
  });
  it("reloads a previously complete old thread when its inbox snippet reveals a new reply", async () => {
    const f = fixture(); permit(f);
    let changed = false;
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) return inbox(changed ? "New urgent reply" : "Old request");
      const result = capture();
      if (changed) result.messages.push({ ...result.messages[1], id: "latest-reply", body: "Please pay today" });
      return result;
    });
    await refresh(f.service);
    f.vault.delete("checkpoints", `mail-inbox-thread:${sourceId}:${threadId}`);
    changed = true;
    const result = await refresh(f.service);
    expect(result.sources[0].downloaded).toBe(1);
    expect(bridge.readMailThread).toHaveBeenCalledTimes(4);
    expect(f.vault.all<Message>("messages").some(message => message.body === "Please pay today")).toBe(true);
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "Please pay today" }));
  });
  it("bootstraps inbox proof conservatively and repairs missing bodies despite an unchanged fingerprint", async () => {
    const f = fixture(); permit(f);
    await f.service.command({ type: "message.load", messageId: f.preview.id });
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      return input.inboxRefresh ? inbox() : capture();
    });
    expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 1, pending: 0 }] });
    expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 0, pending: 0 }] });
    f.vault.delete("messages", `${accountId}:message:complete-2`);
    expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 1, pending: 0 }] });
    expect(f.vault.get("messages", `${accountId}:message:complete-2`)).toBeDefined();
    expect(bridge.readMailThread.mock.calls.filter(([input]) => !input.inboxRefresh)).toHaveLength(3);
  });
  it("does not interpret arbitrary full-message capture timestamps as inbox freshness", async () => {
    const f = fixture(); permit(f);
    await f.service.command({ type: "message.load", messageId: f.preview.id });
    bridge.readMailThread.mockImplementation(async () => { throw new Error("Browser unavailable"); });
    const result = await refresh(f.service, false);
    expect(result.status).toBe("unavailable");
    expect(result.sources[0].checkedAt).toBeUndefined();
    expect(result.sources[0].reason).toContain("unavailable");
  });
  it("reports a refreshed inbox with failed full-body download as partial, never fresh", async () => {
    const f = fixture(); permit(f);
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) return inbox();
      throw new Error("Full email read timed out");
    });
    expect(await refresh(f.service)).toMatchObject({ status: "partial",
      sources: [{ status: "partial", downloaded: 0, pending: 1, reason: "Full email read timed out" }] });
  });
  it("filters exact accounts, respects pause and AI revocation, and cancels before capture", async () => {
    const f = fixture(); permit(f);
    expect((await refresh(f.service, true, "other-account")).sources).toEqual([]);
    f.vault.put("settings", "preferences", { ...defaultSettings, syncPaused: true });
    expect((await refresh(f.service)).status).toBe("unavailable");
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    f.vault.put("settings", "preferences", defaultSettings);
    bridge.readMailThread.mockImplementation(async () => {
      f.vault.put("accounts", accountId, { ...f.vault.get<Account>("accounts", accountId)!, aiEnabled: false });
      return inbox();
    });
    expect((await refresh(f.service)).sources[0].reason).toContain("revoked");
    expect(f.service.retrieval.indexMessage).not.toHaveBeenCalled();
    permit(f);
    const abort = new AbortController(); abort.abort(new Error("Turn cancelled"));
    await expect(refresh(f.service, true, accountId, abort.signal)).rejects.toThrow("Turn cancelled");
  });
  it("runs a mail-only API sync without AI, awaiting indexing and not syncing another selected calendar", async () => {
    const f = fixture(); permit(f);
    f.vault.put("accounts", accountId, { ...f.vault.get<Account>("accounts", accountId)!, connection: "api" });
    f.vault.put("sources", "calendar", { id: "calendar", accountId, providerId: "calendar", kind: "calendar", selected: true });
    vi.mocked(f.service.connectors.sync).mockImplementation(async (_account, sources, page) => {
      expect(sources.map(source => source.id)).toEqual([sourceId]);
      await page({ messages: [{ ...f.preview, browser: undefined, body: "Fresh API body", revision: "new" }],
        attachments: [], events: [] });
    });
    expect((await refresh(f.service)).sources[0].downloaded).toBe(1);
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "Fresh API body" }));
    expect(f.service.copilot.generate).not.toHaveBeenCalled();
    expect(bridge.readMailThread).not.toHaveBeenCalled();
  });
  it("bounds timed-out browser refreshes and aborts their exact leased request", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); permit(f);
      bridge.readMailThread.mockImplementation((_input, _guard, signal) => new Promise((_, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("Lease cancelled")), { once: true });
      }));
      const pending = refresh(f.service);
      await vi.advanceTimersByTimeAsync(150_001);
      const result = await pending;
      expect(result.status).toBe("unavailable");
      expect(result.sources[0].reason).toContain("deadline");
      expect(bridge.readMailThread.mock.calls[0][2]?.aborted).toBe(true);
      expect(f.service.retrieval.indexMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("lets explicit refresh override manual-only scheduling without changing that preference", async () => {
    const f = fixture(); permit(f);
    f.vault.put("settings", "preferences", { ...defaultSettings, refreshIntervalSeconds: 0 });
    expect((await refresh(f.service, false)).sources[0].reason).toContain("manual-only");
    expect(bridge.readMailThread).not.toHaveBeenCalled();
    bridge.readMailThread.mockImplementation(async (input, guard) => { guard(); return input.inboxRefresh ? inbox() : capture(); });
    expect((await refresh(f.service)).status).toBe("fresh");
    expect(f.service.settings().refreshIntervalSeconds).toBe(0);
  });
  it("continues other threads after a read failure and reports pending bodies honestly", async () => {
    const f = fixture(); permit(f);
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) {
        const result = inbox();
        result.messages.push({ ...result.messages[0], id: "thread:second", threadId: "second" });
        return result;
      }
      if (input.threadId === threadId) throw new Error("First thread unavailable");
      return { ...capture(), messages: capture().messages.map(message => ({ ...message, threadId: input.threadId })) };
    });
    expect(await refresh(f.service)).toMatchObject({ status: "partial",
      sources: [{ downloaded: 1, pending: 1, reason: "First thread unavailable" }] });
  });
  it("waits for an already-running API sync, then verifies the exact mail source with no AI", async () => {
    const f = fixture(); permit(f);
    f.vault.put("accounts", accountId, { ...f.vault.get<Account>("accounts", accountId)!, connection: "api" });
    let release!: () => void;
    vi.mocked(f.service.connectors.sync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const syncing = f.service.command({ type: "sync", accountId });
    const pending = refresh(f.service);
    await Promise.resolve();
    expect(f.service.connectors.sync).toHaveBeenCalledTimes(1);
    release(); await syncing;
    expect((await pending).status).toBe("fresh");
    expect(f.service.connectors.sync).toHaveBeenCalledTimes(2);
    expect(f.service.copilot.generate).not.toHaveBeenCalled();
  });
  it("bounds each download batch and resumes pending conversations without re-reading recently verified bodies", async () => {
    const f = fixture(); permit(f);
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) return { ...inbox(), messages: Array.from({ length: 13 }, (_, index) => ({
        ...inbox().messages[0], id: `thread:batch-${index}`, threadId: `batch-${index}`
      })) };
      return { ...capture(), messages: capture().messages.map(message => ({
        ...message, id: `${input.threadId}-${message.id}`, threadId: input.threadId
      })) };
    });
    expect(await refresh(f.service)).toMatchObject({ status: "partial", sources: [{ downloaded: 12, pending: 1 }] });
    expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 1, pending: 0 }] });
    expect(bridge.readMailThread).toHaveBeenCalledTimes(15);
  });
  it("converges across forced batches and reuses more than twelve proven unchanged threads after confirmation expires", async () => {
    const f = fixture(); permit(f);
    const progress = vi.fn();
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) return { ...inbox(), messages: Array.from({ length: 50 }, (_, index) => ({
        ...inbox().messages[0], id: `thread:batch-${index}`, threadId: `batch-${index}`
      })) };
      return { ...capture(), messages: capture().messages.map(message => ({
        ...message, id: `${input.threadId}-${message.id}`, threadId: input.threadId
      })) };
    });
    for (const pending of [38, 26, 14, 2, 0]) {
      const downloaded = pending ? 12 : 2;
      expect(await f.service.refreshMail({ accountId, force: true, signal: new AbortController().signal, progress }))
        .toMatchObject({ status: pending ? "partial" : "fresh", sources: [{ downloaded, pending }] });
    }
    expect(progress.mock.calls.filter(([text]) => text.includes("downloaded and indexed"))).toHaveLength(50);
    expect(progress).toHaveBeenCalledWith("Service reader: 12 of 50 conversations downloaded and indexed; 38 pending.");
    expect(progress).toHaveBeenCalledWith("Service reader: 2 of 2 conversations downloaded and indexed; 0 pending.");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 0, pending: 0 }] });
      expect(await refresh(f.service, false)).toMatchObject({ status: "fresh", sources: [{ downloaded: 0, pending: 0 }] });
    } finally { clock.mockRestore(); }
    expect(bridge.readMailThread.mock.calls.filter(([input]) => input.inboxRefresh)).toHaveLength(7);
    expect(bridge.readMailThread.mock.calls.filter(([input]) => !input.inboxRefresh)).toHaveLength(50);
    // Simulate upgrading an archive whose reader checkpoints predate inbox fingerprints.
    for (let index = 0; index < 50; index++)
      f.vault.delete("checkpoints", `mail-inbox-thread:${sourceId}:batch-${index}`);
    expect(await refresh(f.service)).toMatchObject({ status: "fresh", sources: [{ downloaded: 0, pending: 0 }] });
    expect(bridge.readMailThread.mock.calls.filter(([input]) => input.inboxRefresh)).toHaveLength(8);
    expect(bridge.readMailThread.mock.calls.filter(([input]) => !input.inboxRefresh)).toHaveLength(50);
    expect(f.vault.get("checkpoints", `mail-inbox-thread:${sourceId}:batch-49`))
      .toMatchObject({ fingerprint: expect.any(String), checkedAt: expect.any(String) });
  });
  it("does not reuse old full-body proof after a forced refresh failed", async () => {
    const f = fixture(); permit(f);
    let fail = false;
    let changed = false;
    bridge.readMailThread.mockImplementation(async (input, guard) => {
      guard();
      if (input.inboxRefresh) return inbox(changed ? "New reply requiring a full download" : "Original reply");
      if (fail) throw new Error("Latest body unavailable");
      return capture();
    });
    expect((await refresh(f.service)).status).toBe("fresh");
    changed = true;
    fail = true;
    expect((await refresh(f.service)).status).toBe("partial");
    fail = false;
    expect(await refresh(f.service, false)).toMatchObject({ status: "fresh", sources: [{ downloaded: 1 }] });
    expect(bridge.readMailThread).toHaveBeenCalledTimes(6);
  });

  it("routes local-AI-off reads through the actual reader and archive, then reuses cache and forwards explicit refresh", async () => {
    const f = fixture();
    const result = (await f.service.command({ type: "message.load", messageId: f.preview.id })).messageThread!;
    expect(bridge.readMailThread).toHaveBeenCalledWith({
      accountId, accountEmail: "service-reader@example.org", threadId,
    }, expect.any(Function));
    expect(result).toMatchObject({ accountId, sourceId, threadId: f.preview.threadId, cached: false });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map(message => message.html)).toEqual(capture().messages.map(message => message.html));
    for (const message of result.messages) expect(f.vault.get("messages", message.id)).toEqual(message);
    expect(result.attachments).toMatchObject([{ name: "Notes.txt", messageId: result.messages[1].id, browser: { source: "browser_gmail" } }]);
    expect(f.vault.get("messages", f.preview.id)).toEqual(f.preview);
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledTimes(2);
    const snapshot = f.service.snapshot();
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.attachments).toMatchObject([{ sourceId, parentAvailable: true, name: "Notes.txt" }]);
    expect(snapshot.accounts[0].aiEnabled).toBe(false);
    expect((await f.service.command({ type: "message.load", messageId: f.preview.id })).messageThread).toEqual({ ...result, cached: true });
    expect(bridge.readMailThread).toHaveBeenCalledOnce();
    expect((await f.service.command({ type: "message.load", messageId: f.preview.id, refresh: true })).messageThread?.cached).toBe(false);
    expect(bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(f.vault.all("messages")).toHaveLength(3); expect(f.vault.all("attachments")).toHaveLength(1);
    expect(f.service.copilot.generate).not.toHaveBeenCalled(); expect(f.service.copilot.chat).not.toHaveBeenCalled();
    expect(f.service.connectors.resolveBrowserThread).not.toHaveBeenCalled();
    expect(f.service.connectors.sync).not.toHaveBeenCalled(); expect(f.service.connectors.downloadAttachment).not.toHaveBeenCalled();
    expect(f.service.attachments.process).not.toHaveBeenCalled(); expect(f.host.openExternal).not.toHaveBeenCalled();
    expect(f.vault.all("jobs")).toEqual([]); expect(f.vault.all("drafts")).toEqual([]);
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("uses the real permission epoch to reject a pending read after a source is revoked and immediately re-enabled", async () => {
    const f = fixture();
    let release!: (input: BrowserCapture) => void;
    bridge.readMailThread.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.service.command({ type: "message.load", messageId: f.preview.id });
    const rejected = expect(pending).rejects.toThrow("revoked or changed");
    await f.service.command({ type: "source.select", sourceId, selected: false });
    await f.service.command({ type: "source.select", sourceId, selected: true });
    release(capture()); await rejected;
    expect(f.vault.all("messages")).toEqual([f.preview]);
    expect(f.vault.all("attachments")).toEqual([]);
    expect(f.service.retrieval.indexMessage).not.toHaveBeenCalled();
    expect(f.host.openExternal).not.toHaveBeenCalled();
  });

  it("propagates a paired-browser failure without capturing anything or opening an external email", async () => {
    const f = fixture(), failure = new Error("The verified Gmail tab is no longer available");
    bridge.readMailThread.mockRejectedValueOnce(failure);
    await expect(f.service.command({ type: "message.load", messageId: f.preview.id })).rejects.toBe(failure);
    expect(f.vault.all("messages")).toEqual([f.preview]);
    expect(f.service.retrieval.indexMessage).not.toHaveBeenCalled();
    expect(f.host.openExternal).not.toHaveBeenCalled();
    expect((await f.service.command({ type: "message.load", messageId: f.preview.id })).messageThread?.messages).toHaveLength(2);
  });

  it("does not ingest a queued completed read after permissions are revoked and re-enabled during indexing", async () => {
    const f = fixture();
    const second = { ...f.preview, id: `${accountId}:message:thread%3Asecond`, providerId: "thread:second",
      threadId: `${accountId}:thread:second` };
    f.vault.put("messages", second.id, second);
    let finishIndex!: () => void;
    vi.mocked(f.service.retrieval.indexMessage).mockImplementationOnce(() => new Promise(resolve => { finishIndex = resolve; }));
    bridge.readMailThread.mockImplementation(async input => ({ ...capture(),
      messages: capture().messages.map(item => ({ ...item, id: `${input.threadId}-${item.id}`, threadId: input.threadId })) }));
    const first = f.service.command({ type: "message.load", messageId: f.preview.id });
    const firstRejected = expect(first).rejects.toThrow(/excluded|paused/);
    await vi.waitFor(() => expect(f.service.retrieval.indexMessage).toHaveBeenCalledOnce());
    const queued = f.service.command({ type: "message.load", messageId: second.id });
    const queuedRejected = expect(queued).rejects.toThrow(/excluded|paused|revoked/);
    expect(bridge.readMailThread).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    await f.service.command({ type: "source.select", sourceId, selected: false });
    await f.service.command({ type: "source.select", sourceId, selected: true });
    finishIndex();
    await Promise.all([firstRejected, queuedRejected]);
    expect(f.vault.all<Message>("messages").filter(item => item.threadId === second.threadId)).toEqual([second]);
    expect(f.service.retrieval.indexMessage).toHaveBeenCalledOnce();
  });
});
