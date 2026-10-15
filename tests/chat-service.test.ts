import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Citation, Collection, Draft, EventChange, Message, Settings, Source } from "../src/shared/contracts";
import type { ChatAgentRequest } from "../src/main/copilot";
import { defaultSettings } from "../src/shared/defaults";
import type { Vault } from "../src/main/storage/vault";
import { browserCalendarRevision } from "../src/main/browser/calendar-revision";
import type { BrowserCalendarItem } from "../src/shared/browser";
import type { BrowserCalendarMove, BrowserCalendarResult } from "../src/shared/browser-calendar";

const browserMove = vi.hoisted(() => vi.fn());
vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({ ConnectorHub: class {
  downloadAttachment = vi.fn(); resolveBrowserThread = vi.fn();
  saveDraft = vi.fn().mockResolvedValue({ providerId: "saved-draft", providerRevision: "d1" });
  writeEvent = vi.fn(async (_account: Account, _source: Source, change: EventChange) => ({
    ...change, id: "saved-event", providerId: "event", revision: "e1", url: ""
  }));
} }));
vi.mock("../src/main/attachments", () => ({ AttachmentProcessor: class {} }));
vi.mock("../src/main/retrieval", () => ({ Retrieval: class {
  stats = () => ({ indexed: 0, mode: "keyword" });
  configure = vi.fn().mockResolvedValue(undefined);
  search = vi.fn().mockResolvedValue([]);
  forgetAccount = vi.fn();
} }));
vi.mock("../src/main/browser/bridge", () => ({ BrowserBridge: class {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  status = () => ({ running: true, paired: true, port: 0 });
  requestRefresh = vi.fn();
  moveCalendarEvent = browserMove;
} }));
vi.mock("../src/main/copilot", () => ({ CopilotAdapter: class {
  status = { status: "ready", message: "Offline" };
  models = [{ id: "selected-model", name: "Selected" }];
  stop = vi.fn().mockResolvedValue(undefined);
  chat = vi.fn(async (_request: ChatAgentRequest) => ({ answer: "Hello", citationIds: [] }));
  generate = vi.fn(async (_prompt: string, _citations: Citation[], _model: string) => ({ answer: "Thank you.", citationIds: [] }));
} }));
import { RelayService } from "../src/main/service";

class MemoryVault {
  records = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined {
    const value = this.records.get(`${collection}|${id}`);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put(collection: Collection, id: string, value: unknown): void { this.records.set(`${collection}|${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] {
    return [...this.records].filter(([key]) => key.startsWith(`${collection}|`)).map(([, value]) => structuredClone(value) as T);
  }
  count(collection: Collection): number { return this.all(collection).length; }
  bytes(): number { return 0; }
  listMessages(limit = 500): Message[] { return this.all<Message>("messages").slice(0, limit); }
  transaction<T>(work: () => T): T { return work(); }
  delete(collection: Collection, id: string): void { this.records.delete(`${collection}|${id}`); }
  purgeAccount(accountId: string): void {
    for (const [key, value] of this.records) if (key === `accounts|${accountId}` ||
      (value as { accountId?: string })?.accountId === accountId) this.records.delete(key);
  }
}
const services: RelayService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); browserMove.mockReset(); });
function fixture(withBrowser = false) {
  const vault = new MemoryVault();
  vault.put("settings", "preferences", { ...defaultSettings, model: "selected-model", aiRunsToday: 0, dailyAiLimit: 5,
    aiUsageDate: new Date().toISOString().slice(0, 10) });
  vault.put("accounts", "a", { id: "a", provider: "gmail", email: "test@example.com", name: "Synthetic", consent: true,
    aiEnabled: true, status: "connected", connection: "browser" } satisfies Account);
  vault.put("sources", "s", { id: "s", accountId: "a", providerId: "inbox", kind: "mail", name: "Inbox", selected: true } satisfies Source);
  vault.put("messages", "m", { id: "m", accountId: "a", sourceId: "s", providerId: "m", threadId: "m",
    subject: "Test", sender: "sender@example.com", recipients: [], body: "Synthetic message", receivedAt: "2026-01-01T00:00:00Z",
    historical: false, unread: false, revision: "r1", url: "https://example.com",
    browser: { completeness: "full", capturedAt: "2026-01-01T00:00:00Z", dateText: "" } } satisfies Message);
  const host = { changed: vi.fn(), openExternal: vi.fn(), copy: vi.fn(), loginCopilot: vi.fn(), backupPath: vi.fn(),
    restorePath: vi.fn(), settingsChanged: vi.fn(), notify: vi.fn(),
    ...(withBrowser ? { browserExtensionId: "a".repeat(32) } : {}) };
  const service = new RelayService(vault as unknown as Vault, ".", host); services.push(service);
  return { vault, service };
}
async function proposal(service: RelayService, name: string, args: unknown) {
  vi.mocked(service.copilot.chat).mockImplementation(async request => {
    const tool = request.tools.find(tool => tool.name === name)!;
    const result = await tool.handler!(args, { sessionId: "offline", toolCallId: "proposal", toolName: tool.name, arguments: args });
    expect(result).toHaveProperty("actionId");
    return { answer: "Review the exact preview before confirming.", citationIds: [] };
  });
  const result = await service.command({ type: "chat.send", text: "Prepare the requested reviewed action" });
  await service.chat.settled();
  const turn = service.snapshot().chat!.conversations[0].turns.at(-1)!;
  expect(turn.status).toBe("complete");
  return { preview: turn.actions[0].preview, confirm: () => service.command({
    type: "chat.confirm", conversationId: result.conversationId!, turnId: turn.id, actionId: turn.actions[0].id
  }) };
}
function localDraft(vault: MemoryVault): Draft {
  const draft: Draft = { id: "draft", accountId: "a", messageId: "m", sourceRevision: "r1",
    subject: "Reviewed subject", body: "Reviewed body", recipients: ["recipient@example.com"], updatedAt: "2026-01-01T00:00:00Z",
    status: "local", citations: [] };
  vault.put("drafts", draft.id, draft);
  return draft;
}
function apiCalendar(vault: MemoryVault): EventChange {
  vault.put("accounts", "a", { ...vault.get<Account>("accounts", "a")!, connection: "api" });
  vault.put("sources", "calendar", { id: "calendar", accountId: "a", kind: "calendar", name: "Calendar",
    providerId: "primary", selected: true } satisfies Source);
  return { accountId: "a", sourceId: "calendar", title: "Reviewed focus", start: "2026-10-01T09:00:00Z",
    end: "2026-10-01T10:00:00Z", timeZone: "UTC", allDay: false, attendees: [], location: "", description: "", reminderMinutes: 10 };
}
describe("chat service wiring and AI lifecycle", () => {
  it.each(["needs-user", "uncertain"] as const)("keeps %s browser moves unresolved and refuses automatic retries", async status => {
    const { service, vault } = fixture(true);
    vault.put("sources", "calendar", { id: "calendar", accountId: "a", kind: "calendar", providerId: "calendar", name: "Calendar", selected: true });
    const item: BrowserCalendarItem = { id: "a:meeting:provider-event", accountId: "a", sourceId: "calendar",
      title: "Team discussion", whenText: "9am to 10am, Team discussion, September 24, 2026",
      description: "", location: "", capturedAt: "2026-09-23T08:00:00Z", url: "https://calendar.google.com/calendar/" };
    vault.put("browserItems", item.id, item);
    browserMove.mockImplementationOnce(async (_move: BrowserCalendarMove, authorize: () => void) => {
      authorize();
      return { status, code: status === "uncertain" ? "save-unverified" : "notification-confirmation",
        message: "Inspect the browser before proceeding.", requestId: "synthetic" };
    });
    const action = await proposal(service, "propose_browser_calendar_move", {
      itemId: item.id, newDate: "2026-09-23", startTime: "15:00", endTime: "16:00", timeZone: "Africa/Lagos",
    });
    expect((await action.confirm()).browserCalendarOutcome).toBe(status);
    const snapshot = service.snapshot();
    expect(snapshot.chat!.conversations[0].turns.at(-1)!.actions[0].status).toBe(status);
    const job = snapshot.jobs.find(job => job.kind === "calendar")!;
    expect(job.status).toBe(status === "uncertain" ? "failed" : "paused");
    expect(vault.get("checkpoints", `job:${job.id}`)).toBeUndefined();
    await expect(service.command({ type: "job.retry", jobId: job.id })).rejects.toThrow("not automatically retryable");
    await expect(action.confirm()).rejects.toThrow("not awaiting");
    expect(browserMove).toHaveBeenCalledOnce();
  });

  it("routes only reviewed moves to the browser and rechecks permission immediately before saving", async () => {
    const { service, vault } = fixture(true);
    vault.put("sources", "calendar", { id: "calendar", accountId: "a", kind: "calendar", providerId: "calendar", name: "Calendar", selected: true });
    const item: BrowserCalendarItem = { id: "a:meeting:provider-event", accountId: "a", sourceId: "calendar",
      title: "Tech team discussion", whenText: "9am to 10am, Tech team discussion, September 24, 2026",
      description: "", location: "", capturedAt: "2026-09-23T08:00:00Z", url: "https://calendar.google.com/calendar/" };
    vault.put("browserItems", item.id, item);
    const args = { itemId: item.id, newDate: "2026-09-23", startTime: "15:00", endTime: "16:00", timeZone: "Africa/Lagos" };
    browserMove.mockImplementationOnce(async (move: BrowserCalendarMove, authorize: () => void): Promise<BrowserCalendarResult> => {
      expect(move).toMatchObject({ ...args, accountId: "a", accountEmail: "test@example.com",
        providerId: "provider-event", notificationPolicy: "provider-default", proofRevision: browserCalendarRevision(item) });
      authorize();
      return { status: "saved", code: "saved", message: "Calendar move verified.", requestId: "synthetic-request" };
    });
    await expect(service.command({ type: "browser.calendar.move", ...args, expectedRevision: browserCalendarRevision(item) }))
      .rejects.toThrow("Confirm the exact");
    const action = await proposal(service, "propose_browser_calendar_move", args);
    expect(browserMove).not.toHaveBeenCalled();
    const result = await action.confirm();
    expect(result.browserCalendarOutcome).toBe("saved");
    expect(service.snapshot().jobs.find(job => job.kind === "calendar")?.status).toBe("done");
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();

    browserMove.mockImplementationOnce(async (_move: BrowserCalendarMove, authorize: () => void) => {
      vault.put("accounts", "a", { ...vault.get<Account>("accounts", "a")!, aiEnabled: false });
      authorize();
      throw new Error("Unreachable save");
    });
    const revoked = await proposal(service, "propose_browser_calendar_move", args);
    await expect(revoked.confirm()).rejects.toThrow();
    expect(service.snapshot().jobs.some(job => job.kind === "calendar" && job.status === "failed")).toBe(true);
  });

  it("routes chat through selected-model runAi accounting and enforces the shared budget", async () => {
    const { service, vault } = fixture();
    await service.command({ type: "chat.send", text: "Help" }); await service.chat.settled();
    expect(service.copilot.chat).toHaveBeenCalledWith(expect.objectContaining({ model: "selected-model" }));
    expect(service.settings().aiRunsToday).toBe(1);
    expect(service.snapshot().chat?.conversations[0].turns.at(-1)?.status).toBe("complete");
    vault.put("settings", "preferences", { ...service.settings(), aiRunsToday: 5 });
    await service.command({ type: "chat.send", text: "Another" }); await service.chat.settled();
    expect(service.copilot.chat).toHaveBeenCalledTimes(1);
    expect(service.snapshot().chat?.conversations[0].turns.at(-1)?.status).toBe("error");
  });
  it("confirms local drafts outside the chat AI lock, with no browser hydration or mailbox write", async () => {
    const { service } = fixture();
    vi.mocked(service.copilot.chat).mockImplementation(async request => {
      const tool = request.tools.find(tool => tool.name === "propose_draft_generate")!;
      await tool.handler!({ messageId: "m", instruction: "Say thanks" },
        { sessionId: "offline", toolCallId: "one", toolName: tool.name, arguments: {} });
      return { answer: "Confirm a local draft.", citationIds: [] };
    });
    const result = await service.command({ type: "chat.send", text: "Draft a reply" }); await service.chat.settled();
    const turn = service.snapshot().chat!.conversations[0].turns.at(-1)!;
    const confirmed = await service.command({ type: "chat.confirm", conversationId: result.conversationId!, turnId: turn.id, actionId: turn.actions[0].id });
    expect(confirmed.draftId).toBeTruthy();
    expect(service.copilot.generate).toHaveBeenCalledWith(expect.any(String), expect.any(Array), "selected-model");
    expect(service.connectors.resolveBrowserThread).not.toHaveBeenCalled();
    expect(service.snapshot().drafts[0]).toMatchObject({ status: "local", body: "Thank you." });
    expect(service.settings().aiRunsToday).toBe(2);
    expect(service.snapshot().chat!.busy).toBe(false);
  });
  it("cancels chat on privacy changes without touching the separate archive review controller", async () => {
    const { service } = fixture();
    const cancel = vi.spyOn(service.productivity, "pauseReview");
    vi.mocked(service.copilot.chat).mockImplementation(request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await service.command({ type: "chat.send", text: "Help" });
    await service.command({ type: "account.ai", accountId: "a", enabled: false });
    await service.chat.settled();
    expect(service.snapshot().chat?.busy).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(service.copilot.stop).not.toHaveBeenCalled();
  });
  it("does not cancel a concurrent non-chat AI request when a chat is refused by the busy gate", async () => {
    const { service } = fixture();
    let finish!: () => void;
    vi.mocked(service.copilot.generate).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ answer: "Thank you", citationIds: [] });
    }));
    const draft = service.command({ type: "draft.generate", messageId: "m" });
    await vi.waitFor(() => expect(service.copilot.generate).toHaveBeenCalledOnce());
    await service.command({ type: "chat.send", text: "Help" }); await service.chat.settled();
    await service.command({ type: "chat.cancel" });
    expect(service.copilot.chat).not.toHaveBeenCalled();
    expect(service.copilot.stop).not.toHaveBeenCalled();
    finish(); await draft;
    expect(service.snapshot().drafts).toHaveLength(1);
  });
  it("saves exactly reviewed native draft fields only after chat confirmation and only once", async () => {
    const { service, vault } = fixture();
    apiCalendar(vault); const draft = localDraft(vault);
    const args = { draftId: draft.id, subject: "Exact new subject", body: "Exact full new body\nSecond line", recipients: ["reviewed@example.com"] };
    const action = await proposal(service, "propose_draft_handoff", args);
    const preview = JSON.parse(action.preview);
    expect(preview.review).toMatchObject({ subject: args.subject, body: args.body, recipients: args.recipients, sourceRevision: "r1" });
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
    await action.confirm();
    expect(service.connectors.saveDraft).toHaveBeenCalledWith(expect.any(Object), expect.any(Object),
      expect.objectContaining({ subject: args.subject, body: args.body, recipients: args.recipients }), undefined);
    expect(service.snapshot().drafts[0].status).toBe("saved");
    await expect(action.confirm()).rejects.toThrow("not awaiting");
    expect(service.connectors.saveDraft).toHaveBeenCalledOnce();
  });
  it("rejects changed draft fields rather than executing an old preview", async () => {
    const { service, vault } = fixture();
    apiCalendar(vault); const draft = localDraft(vault);
    const action = await proposal(service, "propose_draft_save", { draftId: draft.id });
    vault.put("drafts", draft.id, { ...draft, recipients: ["unreviewed@example.com"] });
    await expect(action.confirm()).rejects.toThrow("changed");
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
    expect(service.snapshot().chat!.conversations[0].turns.at(-1)!.actions[0].status).toBe("failed");
  });
  it("discloses missing native authorization and refuses uncertain drafts without making cards", async () => {
    const { service, vault } = fixture();
    const draft = localDraft(vault);
    const results: unknown[] = [];
    vi.mocked(service.copilot.chat).mockImplementation(async request => {
      const tool = request.tools.find(t => t.name === "propose_draft_save")!;
      results.push(await tool.handler!({ draftId: draft.id }, { sessionId: "offline", toolCallId: "none", toolName: tool.name, arguments: {} }));
      return { answer: "Native saving is unavailable without matching API authorization; uncertain saves require mailbox inspection.", citationIds: [] };
    });
    await service.command({ type: "chat.send", text: "Save my draft" }); await service.chat.settled();
    expect(service.snapshot().chat!.conversations[0].turns.at(-1)!.status).toBe("complete");
    vault.put("drafts", draft.id, { ...draft, status: "uncertain" });
    await service.command({ type: "chat.send", text: "Save my draft" }); await service.chat.settled();
    expect(results[0]).toMatchObject({ error: expect.stringContaining("same mailbox"), executed: false });
    expect(results[1]).toMatchObject({ error: expect.stringContaining("cannot be safely saved"), executed: false });
    expect(service.snapshot().chat!.conversations[0].turns.at(-1)!.status).toBe("complete");
    expect(service.snapshot().chat!.conversations[0].turns.at(-1)!.actions).toEqual([]);
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
  });
  it("rechecks AI/source permissions after asynchronous browser draft preparation and before native saving", async () => {
    const { service, vault } = fixture();
    const draft = localDraft(vault);
    const apiAccount = { ...vault.get<Account>("accounts", "a")!, id: "api", connection: "api" as const };
    vault.put("accounts", apiAccount.id, apiAccount);
    vault.put("sources", "api-mail", { ...vault.get<Source>("sources", "s")!, id: "api-mail", accountId: "api" });
    const action = await proposal(service, "propose_draft_save", { draftId: draft.id });
    let resolve!: (value: Awaited<ReturnType<typeof service.connectors.resolveBrowserThread>>) => void;
    vi.mocked(service.connectors.resolveBrowserThread).mockReturnValue(new Promise(done => { resolve = done; }));
    const saving = action.confirm();
    await vi.waitFor(() => expect(service.connectors.resolveBrowserThread).toHaveBeenCalledOnce());
    await service.command({ type: "source.select", sourceId: "api-mail", selected: false });
    const rejected = expect(saving).rejects.toThrow("changed");
    resolve({ message: { ...vault.get<Message>("messages", "m")!, accountId: "api", sourceId: "api-mail" },
      threadProviderId: "thread", threadRevision: "r1", citations: [] });
    await rejected;
    expect(service.connectors.saveDraft).not.toHaveBeenCalled();
  });
  it("saves a full calendar approval payload/hash only after its explicit chat confirmation", async () => {
    const { service, vault } = fixture();
    const change = { ...apiCalendar(vault), attendees: ["invitee@example.com"] };
    const approval = await service.command({ type: "calendar.propose", change });
    const action = await proposal(service, "propose_calendar_approve", { approvalId: approval.approvalId });
    expect(JSON.parse(action.preview).review).toMatchObject({ change, hash: expect.any(String), effect: expect.stringContaining("invitations") });
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
    await action.confirm();
    expect(service.connectors.writeEvent).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), change, approval.approvalId);
    await expect(action.confirm()).rejects.toThrow("not awaiting");
    expect(service.connectors.writeEvent).toHaveBeenCalledOnce();
  });
  it("schedules a private task with the exact reviewed calendar fields and reminder", async () => {
    const { service, vault } = fixture();
    const change = apiCalendar(vault);
    const task = await service.command({ type: "task.create", title: "My local task" });
    const action = await proposal(service, "propose_task_schedule", { taskId: task.taskId, change });
    expect(JSON.parse(action.preview).command).toMatchObject({ type: "task.schedule", confirmed: true, change });
    expect(service.connectors.writeEvent).not.toHaveBeenCalled();
    await action.confirm();
    expect(service.connectors.writeEvent).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), change, expect.any(String));
    expect(service.snapshot().tasks![0].schedule).toMatchObject({ state: "scheduled", reminderMinutes: 10 });
  });
  it.each(["forget", "demo.clear"] as const)("purges encrypted associated chat state on %s", async kind => {
    const { service, vault } = fixture();
    if (kind === "demo.clear") vault.put("accounts", "a", { ...vault.get<Account>("accounts", "a")!, demo: true });
    vi.mocked(service.copilot.chat).mockImplementation(async request => {
      const tool = request.tools.find(t => t.name === "read_message")!;
      await tool.handler!({ messageId: "m" }, { sessionId: "offline", toolCallId: "one", toolName: tool.name, arguments: {} });
      return { answer: "Derived synthetic account information", citationIds: [] };
    });
    await service.command({ type: "chat.send", text: "Read a permitted synthetic message" }); await service.chat.settled();
    expect(service.snapshot().chat!.conversations).toHaveLength(1);
    await service.command(kind === "forget" ? { type: "account.disconnect", accountId: "a", forget: true } : { type: "demo.clear" });
    expect(service.snapshot().chat!.conversations).toEqual([]);
    expect(vault.get("checkpoints", "chat:v1")).toMatchObject({ conversations: [] });
  });
});
