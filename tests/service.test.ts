import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Approval, Attachment, CalendarEvent, Citation, Collection, Command, Draft, EventChange, Job, Message, Settings, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { commandSchema } from "../src/main/ipc/schema";
import { proposeChange } from "../src/main/approvals";
import type { Vault } from "../src/main/storage/vault";
import type { BrowserBridge } from "../src/main/browser/bridge";
import type { BrowserCapture } from "../src/shared/browser";

const browser = vi.hoisted(() => ({
  options: undefined as ConstructorParameters<typeof BrowserBridge>[1] | undefined,
  start: vi.fn().mockResolvedValue(undefined), refresh: vi.fn()
}));
vi.mock("../src/main/browser/bridge", () => ({
  BrowserBridge: class {
    constructor(_vault: unknown, options: ConstructorParameters<typeof BrowserBridge>[1]) { browser.options = options; }
    start = browser.start;
    requestRefresh = browser.refresh;
    status = () => ({ paired: true, running: true, port: 43891 });
    stop = vi.fn().mockResolvedValue(undefined);
  }
}));

vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({
  ConnectorHub: class {
    hasGmailReadConfiguration = vi.fn(() => false);
    connect = vi.fn();
    disconnect = vi.fn().mockResolvedValue(undefined);
    sync = vi.fn().mockResolvedValue(undefined);
    resolveBrowserThread = vi.fn();
    saveDraft = vi.fn().mockResolvedValue({ providerId: "native-draft", providerRevision: "d1" });
    writeEvent = vi.fn().mockResolvedValue({ id: "written-event", revision: "e1" });
    downloadAttachment = vi.fn();
  }
}));
vi.mock("../src/main/copilot", () => ({
  CopilotAdapter: class {
    status = { status: "ready", message: "Synthetic test double; no network." };
    models = [{ id: "test-model", name: "Test model" }];
    connect = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    generate = vi.fn().mockImplementation(async (_task: string, citations: Citation[]) => ({
      answer: "A reviewed reply.", citationIds: citations.map(citation => citation.id), needsReply: true
    }));
  }
}));
vi.mock("../src/main/attachments", () => ({
  AttachmentProcessor: class { process = vi.fn().mockResolvedValue(undefined); }
}));
vi.mock("../src/main/retrieval", () => ({
  Retrieval: class {
    constructor(private vault: MemoryVault) {}
    configure = vi.fn().mockResolvedValue(undefined);
    indexMessage = vi.fn().mockResolvedValue(undefined);
    reindex = vi.fn().mockResolvedValue(undefined);
    forgetAccount = vi.fn();
    stats = vi.fn(() => ({ indexed: 0, mode: "keyword" }));
    // Model the retrieval contract here; storage/retrieval tests cover its SQL implementation.
    search = vi.fn(async (_query: string, accountId?: string): Promise<Citation[]> =>
      this.vault.all<Message>("messages").filter(message => {
        const account = this.vault.get<Account>("accounts", message.accountId);
        const source = this.vault.get<Source>("sources", message.sourceId);
        return (!accountId || message.accountId === accountId) && !message.deleted
          && account?.status === "connected" && account.consent && source?.selected;
      }).map(message => ({ id: message.id, messageId: message.id, title: message.subject, excerpt: message.body })));
  }
}));

import { RelayService, safeError } from "../src/main/service";

class MemoryVault {
  private records = new Map<Collection, Map<string, unknown>>();
  get<T>(collection: Collection, id: string): T | undefined {
    const value = this.records.get(collection)?.get(id);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put(collection: Collection, id: string, value: unknown): void {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(id, structuredClone(value));
  }
  all<T>(collection: Collection): T[] {
    return [...(this.records.get(collection)?.values() ?? [])].map(value => structuredClone(value) as T);
  }
  count(collection: Collection): number { return this.records.get(collection)?.size ?? 0; }
  delete(collection: Collection, id: string): void { this.records.get(collection)?.delete(id); }
  listMessages(limit = 500): Message[] {
    return this.all<Message>("messages").sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  }
  transaction<T>(operation: () => T): T { return operation(); }
  purgeAccount = vi.fn((accountId: string) => {
    for (const [collection, records] of this.records)
      for (const [id, record] of records)
        if ((record as { accountId?: string }).accountId === accountId || (collection === "accounts" && id === accountId))
          records.delete(id);
  });
  bytes(): number { return 0; }
  backup = vi.fn().mockResolvedValue(undefined);
  restore = vi.fn().mockResolvedValue(undefined);
}

const account: Account = { id: "account", provider: "gmail", name: "Work", email: "me@example.com", status: "connected", consent: true, aiEnabled: true };
const browserAccount: Account = { id: "browser:google:me@example.com", provider: "gmail", name: "Work browser", email: "me@example.com", status: "connected", consent: true, aiEnabled: true, connection: "browser" };
const source: Source = { id: "mail", accountId: account.id, providerId: "INBOX", name: "Inbox", kind: "mail", selected: true };
const browserSource: Source = { id: `${browserAccount.id}:mail`, accountId: browserAccount.id, providerId: "mail", name: "Gmail pages (browser)", kind: "mail", selected: true };
const message: Message = {
  id: "message", accountId: account.id, sourceId: source.id, providerId: "provider-message", threadId: "thread",
  subject: "Project review", sender: "Colleague <colleague@example.com>", recipients: [account.email],
  body: "Could you review this today?", receivedAt: "2026-09-22T09:00:00Z", url: "https://mail.google.com/mail/u/0/#inbox/thread",
  unread: true, revision: "m1", historical: false
};
const browserMessage: Message = {
  id: "browser-message", accountId: browserAccount.id, sourceId: browserSource.id, providerId: "thread:legacy-thread", threadId: `${browserAccount.id}:thread:legacy-thread`,
  subject: "Project review", sender: "Colleague <colleague@example.com>", recipients: [browserAccount.email],
  body: "Could you review this today?", receivedAt: "", url: "https://mail.google.com/mail/?authuser=me@example.com#all/legacy-thread",
  unread: true, revision: "browser-r1", historical: true, browser: { completeness: "preview", capturedAt: "2026-09-22T10:00:00Z", dateText: "Yesterday" }
};
const change: EventChange = {
  accountId: account.id, sourceId: "calendar", title: "Review", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z",
  timeZone: "Europe/Paris", allDay: false, attendees: ["colleague@example.com"], location: "", description: ""
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("RelayService safety integration (in-memory storage and offline provider doubles)", () => {
  let vault: MemoryVault;
  let service: RelayService;
  let host: {
    changed: ReturnType<typeof vi.fn>; openExternal: ReturnType<typeof vi.fn>; copy: ReturnType<typeof vi.fn>;
    loginCopilot: ReturnType<typeof vi.fn>; backupPath: ReturnType<typeof vi.fn>; restorePath: ReturnType<typeof vi.fn>;
    settingsChanged: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    browser.options = undefined;
    browser.start.mockReset().mockResolvedValue(undefined);
    browser.refresh.mockReset();
    vault = new MemoryVault();
    vault.put("accounts", account.id, account);
    vault.put("sources", source.id, source);
    vault.put("sources", "calendar", { ...source, id: "calendar", kind: "calendar" });
    vault.put("messages", message.id, message);
    vault.put("settings", "preferences", { ...defaultSettings, model: "test-model", aiUsageDate: new Date().toISOString().slice(0, 10) });
    host = {
      changed: vi.fn(), openExternal: vi.fn().mockResolvedValue(undefined), copy: vi.fn(),
      loginCopilot: vi.fn().mockResolvedValue(undefined), backupPath: vi.fn().mockResolvedValue("encrypted.backup"),
      restorePath: vi.fn().mockResolvedValue("encrypted.backup"), settingsChanged: vi.fn(), notify: vi.fn()
    };
    service = new RelayService(vault as unknown as Vault, ".", host);
    vi.mocked(service.connectors.resolveBrowserThread).mockReset();
  });
  afterEach(async () => { await service.stop(); vi.useRealTimers(); });

  it("persists editable manual tasks independently of AI and supplies local focus metrics", async () => {
    vault.put("accounts", account.id, { ...account, aiEnabled: false });
    const created = await service.command({ type: "task.create", title: "Prepare review", priority: "high" });
    await service.command({ type: "task.edit", taskId: created.taskId!, title: "Prepare final review", notes: "My checklist" });
    await service.command({ type: "task.status", taskId: created.taskId!, status: "in_progress" });
    const snapshot = service.snapshot();
    expect(snapshot.tasks).toEqual([expect.objectContaining({ title: "Prepare final review", notes: "My checklist", status: "in_progress" })]);
    expect(snapshot.focusReport?.metrics.manualTasks).toBe(1);
    await service.command({ type: "report.generate" });
    expect(service.copilot.generate).not.toHaveBeenCalled();
  });

  it("schedules an explicitly confirmed private task with its reminder and enables the chosen calendar", async () => {
    vault.put("sources", "calendar", { ...source, id: "calendar", kind: "calendar", selected: false });
    const created = await service.command({ type: "task.create", title: "Prepare review" });
    const privateChange = { ...change, attendees: [], reminderMinutes: 10 };
    vi.mocked(service.connectors.writeEvent).mockResolvedValueOnce({
      ...privateChange, id: "written-event", providerId: "remote", revision: "e1", url: "", writable: true
    });
    await service.command({ type: "task.schedule", taskId: created.taskId!, confirmed: true, change: privateChange });
    expect(service.connectors.writeEvent).toHaveBeenCalledWith(account, expect.objectContaining({ selected: true }),
      expect.objectContaining({ attendees: [], reminderMinutes: 10 }), expect.any(String));
    expect(service.snapshot().tasks?.[0].schedule).toMatchObject({ state: "scheduled", eventId: "written-event", reminderMinutes: 10 });
    expect(vault.all<Approval>("approvals")[0].status).toBe("done");
  });

  it("runs focus reports through the selected Copilot model and discards results after consent revocation", async () => {
    await service.command({ type: "draft.generate", messageId: message.id });
    const pending = deferred<{ answer: string; citationIds: string[] }>();
    vi.mocked(service.copilot.generate).mockReturnValueOnce(pending.promise);
    const report = service.command({ type: "report.generate" });
    await vi.waitFor(() => expect(service.copilot.generate).toHaveBeenCalledTimes(2));
    expect(service.copilot.generate).toHaveBeenLastCalledWith(expect.stringContaining("focus report"), expect.any(Array), "test-model");
    await service.command({ type: "account.ai", accountId: account.id, enabled: false });
    pending.resolve({ answer: "Must not be retained", citationIds: [message.id] });
    await expect(report).rejects.toThrow();
    expect(vault.count("reports")).toBe(0);
  });

  it("refreshes selected channels and browser captures on demand without overriding pause", async () => {
    service = new RelayService(vault as unknown as Vault, ".", { ...host, browserExtensionId: "a".repeat(32) });
    await service.command({ type: "refresh.request" });
    expect(browser.refresh).toHaveBeenCalledOnce();
    expect(service.connectors.sync).toHaveBeenCalledOnce();
    await service.command({ type: "settings.update", patch: { syncPaused: true } });
    await service.command({ type: "refresh.request" });
    expect(browser.refresh).toHaveBeenCalledOnce();
    expect(service.connectors.sync).toHaveBeenCalledOnce();
  });

  it("supports manual-only refresh and validates refresh interval bounds", () => {
    for (const value of [0, 30, 60, 3600])
      expect(commandSchema.safeParse({ type: "settings.update", patch: { refreshIntervalSeconds: value } }).success).toBe(true);
    for (const value of [-1, 1, 29, 30.5, 3601])
      expect(commandSchema.safeParse({ type: "settings.update", patch: { refreshIntervalSeconds: value } }).success).toBe(false);
  });

  it("hands the exact reviewed reply to Gmail and opens Drafts only after a successful native save", async () => {
    const generated = await service.command({ type: "draft.generate", messageId: message.id });
    await service.command({ type: "draft.handoff", draftId: generated.draftId!, body: "My reviewed reply",
      subject: "Re: Project review", recipients: ["colleague@example.com"] });
    expect(service.connectors.saveDraft).toHaveBeenCalledWith(account, message,
      expect.objectContaining({ body: "My reviewed reply", subject: "Re: Project review", recipients: ["colleague@example.com"] }), undefined);
    expect(host.openExternal).toHaveBeenCalledWith("https://mail.google.com/mail/?authuser=me%40example.com#drafts");
    expect(vi.mocked(service.connectors.saveDraft).mock.invocationCallOrder[0]).toBeLessThan(host.openExternal.mock.invocationCallOrder[0]);
  });

  it("does not open Gmail or report success when one-click draft saving fails", async () => {
    const generated = await service.command({ type: "draft.generate", messageId: message.id });
    vi.mocked(service.connectors.saveDraft).mockRejectedValueOnce(new Error("Mailbox unavailable"));
    await expect(service.command({ type: "draft.handoff", draftId: generated.draftId!, body: "Reviewed",
      subject: "Re: Project review", recipients: ["colleague@example.com"] })).rejects.toThrow("Mailbox unavailable");
    expect(host.openExternal).not.toHaveBeenCalled();
  });
  it("keeps the workspace usable and records a browser listener startup failure", async () => {
    service = new RelayService(vault as unknown as Vault, ".", { ...host, browserExtensionId: "a".repeat(32) });
    browser.start.mockRejectedValueOnce(new Error("Browser bridge port is already in use."));
    await service.initialize();
    expect(vault.all<Job>("jobs")).toContainEqual(expect.objectContaining({
      label: "Start browser companion", status: "failed", detail: expect.stringContaining("already in use")
    }));
    expect(service.snapshot().messages).toHaveLength(1);
  });

  it("triages undated unread browser requests locally and does not auto-draft them without same-email Gmail API verification", async () => {
    service = new RelayService(vault as unknown as Vault, ".", { ...host, browserExtensionId: "a".repeat(32) });
    const payload: BrowserCapture = {
      accountEmail: "browser@example.org", accountName: "Browser", kind: "mail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
      messages: [{ id: "browser-message", threadId: "thread", subject: "Please review", sender: "sender@example.org",
        recipients: [], body: "Could you review this today?", dateText: "Today", unread: true,
        completeness: "preview", url: "https://mail.google.com/mail/u/0/#inbox/thread" }]
    };
    const { accountId } = await browser.options!.onDiscover(payload);
    await service.command({ type: "source.select", sourceId: `${accountId}:mail`, selected: true });
    await browser.options!.onCapture(payload);
    expect(service.snapshot().actions).toContainEqual(expect.objectContaining({
      accountId, reason: expect.stringContaining("confirm this request is still current")
    }));
    expect(service.copilot.generate).not.toHaveBeenCalled();
    await service.command({ type: "account.ai", accountId, enabled: true });
    vault.put("settings", "preferences", { ...service.settings(), backgroundAi: true });
    payload.messages[0].receivedAt = new Date().toISOString();
    await browser.options!.onCapture(payload);
    expect(service.copilot.generate).not.toHaveBeenCalled();
    payload.messages[0].completeness = "full";
    await browser.options!.onCapture(payload);
    expect(service.copilot.generate).not.toHaveBeenCalled();
    expect(service.snapshot().drafts).toHaveLength(0);
    expect(service.connectors.resolveBrowserThread).not.toHaveBeenCalled();
  });

  it("auto-drafts only newly observed unread browser messages after opt-in when same-email Gmail API verification proves they are recent", async () => {
    service = new RelayService(vault as unknown as Vault, ".", { ...host, browserExtensionId: "a".repeat(32) });
    const payload: BrowserCapture = {
      accountEmail: account.email, accountName: account.name, kind: "mail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
      messages: [{ id: "browser-message", threadId: "thread", subject: "Please review", sender: "sender@example.org",
        recipients: [], body: "Could you review this today?", dateText: "Today", unread: true,
        completeness: "preview", url: "https://mail.google.com/mail/u/0/#inbox/thread" }]
    };
    const { accountId } = await browser.options!.onDiscover(payload);
    await service.command({ type: "source.select", sourceId: `${accountId}:mail`, selected: true });
    await service.command({ type: "account.ai", accountId, enabled: true });
    vault.put("settings", "preferences", { ...service.settings(), backgroundAi: true });
    vi.mocked(service.connectors.resolveBrowserThread).mockResolvedValue({
      message: { ...message, id: "api-message", accountId: account.id, sourceId: "api-unselected", providerId: "api-message", revision: "api-r1",
        threadId: `${account.id}:thread:api-thread`, receivedAt: new Date().toISOString(), historical: false },
      citations: [{ id: "browser-message:api-message", messageId: `${accountId}:message:browser-message`, title: "Matched Gmail thread", excerpt: "Full API thread context" }],
      threadProviderId: "api-thread", threadRevision: "thread-r1"
    });
    await browser.options!.onCapture(payload);
    await vi.waitFor(() => expect(service.snapshot().drafts).toHaveLength(1));
    expect(service.connectors.resolveBrowserThread).toHaveBeenCalled();
    expect(service.copilot.generate).toHaveBeenCalledTimes(1);
    vi.mocked(service.connectors.resolveBrowserThread).mockClear();
    await browser.options!.onCapture(payload);
    expect(service.connectors.resolveBrowserThread).not.toHaveBeenCalled();
    expect(service.copilot.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses browser background AI for hydrated Gmail messages that are old history even if newly observed in the browser", async () => {
    service = new RelayService(vault as unknown as Vault, ".", { ...host, browserExtensionId: "a".repeat(32) });
    const payload: BrowserCapture = {
      accountEmail: account.email, accountName: account.name, kind: "mail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
      messages: [{ id: "browser-message", threadId: "thread", subject: "Please review", sender: "sender@example.org",
        recipients: [], body: "Could you review this today?", dateText: "Last week", unread: true,
        completeness: "preview", url: "https://mail.google.com/mail/u/0/#inbox/thread" }]
    };
    const { accountId } = await browser.options!.onDiscover(payload);
    await service.command({ type: "source.select", sourceId: `${accountId}:mail`, selected: true });
    await service.command({ type: "account.ai", accountId, enabled: true });
    vault.put("settings", "preferences", { ...service.settings(), backgroundAi: true });
    vi.mocked(service.connectors.resolveBrowserThread).mockResolvedValue({
      message: { ...message, id: "api-message", accountId: account.id, sourceId: "api-unselected", providerId: "api-message", revision: "api-r1",
        threadId: `${account.id}:thread:api-thread`, receivedAt: new Date(Date.now() - 86400000 * 3).toISOString(), historical: true },
      citations: [{ id: "browser-message:api-message", messageId: `${accountId}:message:browser-message`, title: "Matched Gmail thread", excerpt: "Old API thread context" }],
      threadProviderId: "api-thread", threadRevision: "thread-r1"
    });
    await browser.options!.onCapture(payload);
    expect(service.connectors.resolveBrowserThread).toHaveBeenCalled();
    expect(service.copilot.generate).not.toHaveBeenCalled();
    expect(service.snapshot().drafts).toHaveLength(0);
  });

  it("keeps a failed post-authorization connection visible without adding a phantom account or storing its input secret", async () => {
    vi.mocked(service.connectors.connect).mockRejectedValue(new Error("OAuth exchange failed (400). Check the Google desktop client secret."));
    await expect(service.command({ type: "account.connect", provider: "gmail", consent: true, token: "synthetic-secret-input" })).rejects.toThrow("client secret");
    expect(vault.all<Account>("accounts")).toEqual([account]);
    expect(vault.all<Job>("jobs")).toEqual([expect.objectContaining({
      label: "Connect gmail", status: "failed", detail: expect.stringContaining("client secret")
    })]);
    expect(JSON.stringify(service.snapshot())).not.toContain("synthetic-secret-input");
    expect(host.changed).toHaveBeenCalled();
  });

  it("publishes an account only after complete discovery with source and AI opt-in preserved", async () => {
    const connected = { ...account, id: "new-account" };
    vi.mocked(service.connectors.connect).mockResolvedValue({
      account: connected, sources: [{ ...source, id: "new-source", accountId: connected.id, selected: false }]
    });
    await service.command({ type: "account.connect", provider: "gmail", consent: true });
    expect(vault.get<Account>("accounts", connected.id)).toMatchObject({ consent: true, aiEnabled: false });
    expect(vault.get<Source>("sources", "new-source")?.selected).toBe(false);
    expect(vault.all<Job>("jobs")[0].status).toBe("done");
  });
  it("never routes browser accounts through API synchronization or calendar proposals", async () => {
    vault.put("accounts", account.id, { ...account, connection: "browser" });
    await expect(service.command({ type: "sync", accountId: account.id })).rejects.toThrow("Browser sources");
    await expect(service.command({ type: "calendar.propose", change })).rejects.toThrow("read-only");
    expect(service.connectors.sync).not.toHaveBeenCalled();
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });
  it("opens an explicitly selected Google identity rather than a positional account slot", async () => {
    vault.put("accounts", account.id, { ...account, connection: "browser" });
    await service.command({ type: "browser.open", kind: "mail", accountId: account.id });
    const url = new URL(host.openExternal.mock.calls[0][0]);
    expect(url.hostname).toBe("mail.google.com");
    expect(url.searchParams.get("authuser")).toBe(account.email);
    expect(url.pathname).not.toContain("/u/0");
  });

  async function generate(): Promise<Draft> {
    const result = await service.command({ type: "draft.generate", messageId: message.id });
    return vault.get<Draft>("drafts", result.draftId!)!;
  }
  function settings(patch: Partial<Settings>): void {
    vault.put("settings", "preferences", { ...service.settings(), ...patch });
  }
  function syncPage(messages: Message[]) {
    vi.mocked(service.connectors.sync).mockImplementation(async (_account, _sources, onPage) => {
      await onPage({ messages, attachments: [], events: [], checkpoint: { id: "cursor", value: { cursor: "next" } } });
    });
  }

  it("generates and edits locally; only explicit Save writes a native draft", async () => {
    const draft = await generate();
    expect(draft.status).toBe("local");
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
    await service.command({ type: "draft.edit", draftId: draft.id, body: "My edited reply", subject: "Reviewed", recipients: ["reviewer@example.com"] });
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
    await service.command({ type: "draft.save", draftId: draft.id });
    expect(service.connectors.saveDraft).toHaveBeenCalledExactlyOnceWith(account, message, expect.objectContaining({
      body: "My edited reply", subject: "Reviewed", recipients: ["reviewer@example.com"]
    }), undefined);
    expect(vault.get<Draft>("drafts", draft.id)).toMatchObject({ status: "saved", providerId: "native-draft", savedBody: "My edited reply" });
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("generates browser drafts with verified same-email Gmail context and saves them through the linked API account", async () => {
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, browserSource);
    vault.put("messages", browserMessage.id, browserMessage);
    vi.mocked(service.connectors.resolveBrowserThread).mockResolvedValue({
      message: { ...message, id: "api-message", accountId: account.id, sourceId: "unselected-api-mail", providerId: "api-message",
        threadId: `${account.id}:thread:api-thread`, revision: "api-r1", historical: false },
      citations: [{ id: `${browserMessage.id}:api-message`, messageId: browserMessage.id, title: "Matched Gmail thread", excerpt: "Full API thread context", location: "Matched reply target" }],
      threadProviderId: "api-thread", threadRevision: "thread-r1"
    });
    const generated = await service.command({ type: "draft.generate", messageId: browserMessage.id });
    const draft = vault.get<Draft>("drafts", generated.draftId!)!;
    expect(generated.message).toContain("verified Gmail thread");
    expect(draft.nativeTarget).toMatchObject({ accountId: account.id, provider: "gmail", messageProviderId: "api-message", messageRevision: "api-r1" });
    vi.mocked(service.connectors.resolveBrowserThread).mockClear();
    await service.command({ type: "draft.save", draftId: draft.id });
    expect(service.connectors.resolveBrowserThread).not.toHaveBeenCalled();
    expect(service.connectors.saveDraft).toHaveBeenCalledWith(account, expect.objectContaining({
      accountId: account.id, providerId: "api-message", sourceId: `${account.id}:mail:__browser-thread__`, revision: "api-r1"
    }), expect.objectContaining({ accountId: account.id, messageId: `${account.id}:message:api-message`, sourceRevision: "api-r1" }), { browserMessageId: browserMessage.id });
    expect(vault.get<Draft>("drafts", draft.id)).toMatchObject({ status: "saved", providerId: "native-draft", savedBody: draft.body });
  });

  it("keeps browser drafts local when no same-email Gmail API authorization is available", async () => {
    vault.put("accounts", account.id, { ...account, email: "other@example.com", name: "Other" });
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, browserSource);
    vault.put("messages", browserMessage.id, browserMessage);
    const generated = await service.command({ type: "draft.generate", messageId: browserMessage.id });
    expect(generated.message).toContain("Optional API connections");
    const draft = vault.get<Draft>("drafts", generated.draftId!)!;
    expect(draft.nativeTarget).toBeUndefined();
    await expect(service.command({ type: "draft.save", draftId: draft.id })).rejects.toThrow("Optional API connections");
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
  });
  it("surfaces Gmail verification failures instead of silently generating from a preview", async () => {
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, browserSource);
    vault.put("messages", browserMessage.id, browserMessage);
    vi.mocked(service.connectors.resolveBrowserThread).mockRejectedValue(new Error("Gmail authorization expired"));
    await expect(service.command({ type: "draft.generate", messageId: browserMessage.id })).rejects.toThrow("Gmail authorization expired");
    expect(service.copilot.generate).not.toHaveBeenCalled();
    expect(service.snapshot().jobs).toContainEqual(expect.objectContaining({ status: "failed", detail: "Gmail authorization expired" }));
  });
  it("does not disclose Gmail context if AI is disabled while verification is running", async () => {
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, browserSource);
    vault.put("messages", browserMessage.id, browserMessage);
    const pending = deferred<Awaited<ReturnType<typeof service.connectors.resolveBrowserThread>>>();
    vi.mocked(service.connectors.resolveBrowserThread).mockReturnValue(pending.promise);
    const generation = service.command({ type: "draft.generate", messageId: browserMessage.id });
    await vi.waitFor(() => expect(service.connectors.resolveBrowserThread).toHaveBeenCalled());
    await service.command({ type: "account.ai", accountId: browserAccount.id, enabled: false });
    pending.resolve({ message, citations: [], threadProviderId: "thread", threadRevision: "thread-r1" });
    await expect(generation).rejects.toThrow("Enable AI");
    expect(service.copilot.generate).not.toHaveBeenCalled();
  });

  it("background opt-in generates only local replies for new, not historical, messages", async () => {
    settings({ backgroundAi: true });
    syncPage([message, { ...message, id: "old", historical: true }]);
    await service.command({ type: "sync", accountId: account.id });
    expect(vault.all<Draft>("drafts").map(draft => draft.messageId)).toEqual([message.id]);
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
    expect(vault.get("checkpoints", `ai:${message.id}:${message.revision}`)).toEqual({ done: true });
  });

  it("does not call Copilot during ordinary sync without automation opt-in", async () => {
    syncPage([message]);
    await service.command({ type: "sync", accountId: account.id });
    expect(service.copilot.generate).not.toHaveBeenCalled();
    expect(vault.all("actions")).toHaveLength(1);
  });

  it("prohibits email sending and Slack posting at the command boundary", () => {
    for (const type of ["email.send", "draft.send", "slack.post", "calendar.delete", "shell.execute"])
      expect(commandSchema.safeParse({ type }).success).toBe(false);
    for (const patch of [{ aiRunsToday: 0 }, { aiUsageDate: "2099-01-01" }, { dailyAiLimit: 0 }])
      expect(commandSchema.safeParse({ type: "settings.update", patch }).success).toBe(false);
  });

  it("keeps Slack drafts local and supports explicit copying only", async () => {
    vault.put("accounts", account.id, { ...account, provider: "slack" });
    const draft = await generate();
    await expect(service.command({ type: "draft.save", draftId: draft.id })).rejects.toThrow("copy/paste");
    await service.command({ type: "clipboard.copy", text: draft.body });
    expect(host.copy).toHaveBeenCalledWith(draft.body);
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
  });

  it("marks drafts stale on source revisions and refuses native saving", async () => {
    const draft = await generate();
    syncPage([{ ...message, revision: "m2" }]);
    await service.command({ type: "sync", accountId: account.id });
    expect(vault.get<Draft>("drafts", draft.id)?.status).toBe("stale");
    await service.command({ type: "draft.edit", draftId: draft.id, body: "Still stale", recipients: draft.recipients, subject: draft.subject });
    await expect(service.command({ type: "draft.save", draftId: draft.id })).rejects.toThrow("conversation changed");
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
  });

  it("retains uncertain draft saves after conflicts instead of duplicating or overwriting", async () => {
    const draft = await generate();
    vi.mocked(service.connectors.saveDraft).mockRejectedValue(new Error("Provider draft changed; conflict."));
    await expect(service.command({ type: "draft.save", draftId: draft.id })).rejects.toThrow("conflict");
    expect(vault.get<Draft>("drafts", draft.id)?.status).toBe("uncertain");
    await expect(service.command({ type: "draft.save", draftId: draft.id })).rejects.toThrow("prior save");
    await expect(service.command({ type: "draft.edit", draftId: draft.id, body: "Changed", recipients: [], subject: "" })).rejects.toThrow("uncertain");
    expect(service.connectors.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("discards generation if the source changed while Copilot was working", async () => {
    vi.mocked(service.copilot.generate).mockImplementation(async () => {
      vault.put("messages", message.id, { ...message, revision: "m2" });
      return { answer: "Outdated", citationIds: [message.id] };
    });
    await expect(generate()).rejects.toThrow("changed while generating");
    expect(vault.all("drafts")).toEqual([]);
  });

  it("excludes unselected sources and disconnected accounts from retrieval", async () => {
    expect((await service.command({ type: "search", query: "review", accountId: account.id })).citations).toHaveLength(1);
    expect(service.retrieval.search).toHaveBeenCalledWith("review", account.id);
    await service.command({ type: "source.select", sourceId: source.id, selected: false });
    expect((await service.command({ type: "search", query: "review" })).citations).toEqual([]);
    await expect(generate()).rejects.toThrow("not selected");
    await service.command({ type: "source.select", sourceId: source.id, selected: true });
    await service.command({ type: "account.disconnect", accountId: account.id, forget: false });
    expect(service.retrieval.forgetAccount).toHaveBeenCalledWith(account.id);
    expect(vault.get("messages", message.id)).toBeDefined();
    expect((await service.command({ type: "search", query: "review" })).citations).toEqual([]);
    await expect(service.command({ type: "sync", accountId: account.id })).rejects.toThrow("Reconnect");
    await expect(generate()).rejects.toThrow("Reconnect");
  });

  it("requires separate AI consent while local search remains available", async () => {
    await service.command({ type: "account.ai", accountId: account.id, enabled: false });
    expect((await service.command({ type: "search", query: "review" })).citations).toHaveLength(1);
    await expect(service.command({ type: "ask", query: "review" })).rejects.toThrow("No eligible evidence");
    await expect(generate()).rejects.toThrow("Enable AI");
    expect(service.copilot.generate).not.toHaveBeenCalled();
  });

  it("discards AI output if source consent is revoked during generation", async () => {
    vi.mocked(service.copilot.generate).mockImplementation(async () => {
      await service.command({ type: "account.ai", accountId: account.id, enabled: false });
      return { answer: "No longer authorized", citationIds: [message.id] };
    });
    await expect(service.command({ type: "ask", query: "review" })).rejects.toThrow("Enable AI");
  });

  it("exhausts the local budget without disabling local search or editing", async () => {
    const draft = await generate();
    settings({ dailyAiLimit: 1, aiRunsToday: 1 });
    await expect(generate()).rejects.toThrow("budget");
    expect((await service.command({ type: "search", query: "review" })).citations).toHaveLength(1);
    await service.command({ type: "draft.edit", draftId: draft.id, body: "Manual", recipients: [], subject: "Manual" });
    expect(service.copilot.generate).toHaveBeenCalledTimes(1);
  });

  it("records disconnected Copilot failure, consumes a run, and creates no draft", async () => {
    vi.mocked(service.copilot.generate).mockRejectedValue(new Error("Sign in using Copilot CLI (/login)"));
    await expect(generate()).rejects.toThrow("/login");
    expect(service.settings().aiRunsToday).toBe(1);
    expect(vault.all("drafts")).toEqual([]);
    expect(vault.all<Job>("jobs")).toEqual([expect.objectContaining({ kind: "ai", status: "failed", detail: expect.stringContaining("/login") })]);
  });

  it("records sync checkpoints and jobs, and retries only checkpointed failures", async () => {
    vi.mocked(service.connectors.sync).mockRejectedValueOnce(new Error("Offline Bearer secret-token"));
    await expect(service.command({ type: "sync", accountId: account.id })).rejects.toThrow("Offline");
    const failed = vault.all<Job>("jobs")[0];
    expect(failed).toMatchObject({ status: "failed", detail: expect.stringContaining("Offline") });
    expect(failed.detail).not.toContain("secret-token");
    expect(vault.get<Command>("checkpoints", `job:${failed.id}`)).toEqual({ type: "sync", accountId: account.id });
    syncPage([message]);
    await service.command({ type: "job.retry", jobId: failed.id });
    expect(vault.get("checkpoints", "cursor")).toEqual({ cursor: "next" });
    expect(vault.all<Job>("jobs")).toContainEqual(expect.objectContaining({ status: "done", progress: 100 }));
    expect(safeError(new Error("ghp_private xoxb-private"))).not.toContain("private");
  });

  it("does not advance a sync cursor if indexing fails", async () => {
    syncPage([message]);
    vi.mocked(service.retrieval.indexMessage).mockRejectedValue(new Error("Index unavailable"));
    await expect(service.command({ type: "sync", accountId: account.id })).rejects.toThrow("Index unavailable");
    expect(vault.get("checkpoints", "cursor")).toBeUndefined();
    expect(vault.all<Job>("jobs")[0].status).toBe("failed");
  });

  it("recovers interrupted durable work without replaying writes on startup", () => {
    vault.put("jobs", "interrupted", { id: "interrupted", status: "running" });
    vault.put("jobs", "queued", { id: "queued", status: "pending" });
    const approval = proposeChange(change);
    vault.put("approvals", approval.id, { ...approval, status: "executing" });
    new RelayService(vault as unknown as Vault, ".", host);
    expect(vault.all<Job>("jobs").every(job => job.status === "paused")).toBe(true);
    expect(vault.get<Approval>("approvals", approval.id)?.status).toBe("uncertain");
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("requires exact, single-use calendar approval before any provider write", async () => {
    const result = await service.command({ type: "calendar.propose", change });
    const approval = vault.get<Approval>("approvals", result.approvalId!)!;
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: "0".repeat(64) })).rejects.toThrow("changed");
    await service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash });
    expect(service.connectors.writeEvent).toHaveBeenCalledExactlyOnceWith(account, expect.objectContaining({ id: "calendar" }), change, approval.id);
    expect(vault.get("audit", approval.id)).toMatchObject({ payloadHash: approval.hash, kind: "calendar.write" });
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("no longer pending");
  });

  it("rejects approval payload tampering and expiry", async () => {
    const approval = proposeChange(change);
    vault.put("approvals", approval.id, { ...approval, change: { ...change, attendees: ["unreviewed@example.com"] } });
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("changed");
    vault.put("approvals", approval.id, { ...approval, createdAt: new Date(Date.now() - 16 * 60000).toISOString() });
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("expired");
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("does not replay uncertain calendar writes after provider failure", async () => {
    const approval = proposeChange(change);
    vault.put("approvals", approval.id, approval);
    vi.mocked(service.connectors.writeEvent).mockRejectedValue(new Error("Connection lost after write"));
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("Connection lost");
    expect(vault.get<Approval>("approvals", approval.id)?.status).toBe("uncertain");
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("no longer pending");
    expect(service.connectors.writeEvent).toHaveBeenCalledTimes(1);
  });

  it("blocks recurring calendar edits and deselected calendar approvals", async () => {
    vault.put("events", "event", { id: "event", accountId: account.id, sourceId: "calendar", recurring: true } as CalendarEvent);
    await expect(service.command({ type: "calendar.propose", change: { ...change, eventId: "event", expectedRevision: "e1" } })).rejects.toThrow("recurring");
    const approval = proposeChange(change);
    vault.put("approvals", approval.id, approval);
    await service.command({ type: "source.select", sourceId: "calendar", selected: false });
    await expect(service.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash })).rejects.toThrow("not selected");
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("forwards explicit attachment approval and prevents disconnected processing", async () => {
    const attachment: Attachment = { id: "file", accountId: account.id, messageId: message.id, providerId: "file", name: "large.pdf", mimeType: "application/pdf", size: 30 * 1024 * 1024, status: "awaiting-approval" };
    vault.put("attachments", attachment.id, attachment);
    await service.command({ type: "attachment.process", attachmentId: attachment.id, approved: false });
    expect(service.attachments.process).toHaveBeenLastCalledWith(attachment.id, false, expect.any(AbortSignal));
    await service.command({ type: "attachment.process", attachmentId: attachment.id, approved: true });
    expect(service.attachments.process).toHaveBeenLastCalledWith(attachment.id, true, expect.any(AbortSignal));
    await service.command({ type: "account.disconnect", accountId: account.id, forget: false });
    await expect(service.command({ type: "attachment.process", attachmentId: attachment.id, approved: true })).rejects.toThrow("Reconnect");
    expect(service.attachments.process).toHaveBeenCalledTimes(2);
  });

  it("restores with automation paused and old approvals made non-replayable", async () => {
    const approval = proposeChange(change);
    vault.restore.mockImplementation(async () => {
      settings({ syncPaused: false, backgroundAi: true });
      vault.put("jobs", "restored-job", { id: "restored-job", status: "running" });
      vault.put("approvals", approval.id, approval);
    });
    await service.command({ type: "archive.restore" });
    expect(vault.restore).toHaveBeenCalledWith("encrypted.backup");
    expect(service.settings()).toMatchObject({ syncPaused: true, backgroundAi: false });
    expect(vault.get<Job>("jobs", "restored-job")?.status).toBe("paused");
    expect(vault.get<Approval>("approvals", approval.id)?.status).toBe("uncertain");
    expect(service.retrieval.configure).toHaveBeenCalled();
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("pauses restored automation and invalidates approvals even if post-restore cleanup fails", async () => {
    const approval = proposeChange(change);
    vault.restore.mockImplementation(async () => {
      settings({ syncPaused: false, backgroundAi: true });
      vault.put("jobs", "restored-job", { id: "restored-job", status: "running" });
      vault.put("approvals", approval.id, approval);
      throw new Error("Rollback cleanup failed");
    });
    await expect(service.command({ type: "archive.restore" })).rejects.toThrow("Automation remains paused");
    expect(service.settings()).toMatchObject({ syncPaused: true, backgroundAi: false });
    expect(vault.get<Job>("jobs", "restored-job")?.status).toBe("paused");
    expect(vault.get<Approval>("approvals", approval.id)?.status).toBe("uncertain");
    expect(host.settingsChanged).toHaveBeenCalled();
    expect(service.retrieval.configure).toHaveBeenCalled();
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
  });

  it("never touches archive storage when restore is cancelled", async () => {
    host.restorePath.mockResolvedValue(undefined);
    expect(await service.command({ type: "archive.restore" })).toEqual({ message: "Restore cancelled." });
    expect(vault.restore).not.toHaveBeenCalled();
  });

  it("refuses restore while a job is running", async () => {
    const pending = deferred<void>();
    vi.mocked(service.connectors.sync).mockImplementation(() => pending.promise);
    const sync = service.command({ type: "sync", accountId: account.id });
    await expect(service.command({ type: "archive.restore" })).rejects.toThrow("active jobs");
    expect(host.restorePath).not.toHaveBeenCalled();
    pending.resolve(undefined);
    await sync;
  });

  it("regression: refuses restore if sync starts while the native restore dialog is open", async () => {
    const dialog = deferred<string>();
    const pending = deferred<void>();
    host.restorePath.mockReturnValue(dialog.promise);
    vi.mocked(service.connectors.sync).mockImplementation(() => pending.promise);
    const restore = service.command({ type: "archive.restore" });
    const sync = service.command({ type: "sync", accountId: account.id });
    dialog.resolve("encrypted.backup");
    try {
      await expect(restore).rejects.toThrow("active jobs");
      expect(vault.restore).not.toHaveBeenCalled();
    } finally {
      pending.resolve(undefined);
      await sync;
    }
  });

  it("regression: refuses to disclose deleted message bodies to Copilot", async () => {
    vault.put("messages", message.id, { ...message, deleted: true });
    await expect(generate()).rejects.toThrow();
    expect(service.copilot.generate).not.toHaveBeenCalled();
  });

  it("uses allowed provider links only", async () => {
    for (const url of ["https://evil.example/message", "file:///C:/secret", "https://me:secret@mail.google.com/"]) {
      vault.put("messages", message.id, { ...message, url });
      await expect(service.command({ type: "open.message", messageId: message.id })).rejects.toThrow("allowed destination");
    }
    expect(host.openExternal).not.toHaveBeenCalled();
  });
});
