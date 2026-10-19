import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@github/copilot-sdk";
import { ChatService, chatFailureMessage, toolParameters } from "../src/main/chat";
import type { ChatAgentRequest } from "../src/main/copilot";
import type { Account, Collection, Command, CommandResult, Message, Settings, Snapshot, Source } from "../src/shared/contracts";
import { CHAT_MESSAGE_MAX, ChatTimeoutError, skipsChatMailRefresh, type ChatMailRefresh } from "../src/shared/chat";
import { defaultSettings } from "../src/shared/defaults";
import type { Vault } from "../src/main/storage/vault";
import { commandSchema } from "../src/main/ipc/schema";
import type { MailFreshnessRequest, MailFreshnessResult } from "../src/shared/mail-freshness";

class MemoryVault {
  records = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined {
    const item = this.records.get(`${collection}|${id}`);
    return item === undefined ? undefined : structuredClone(item) as T;
  }
  put(collection: Collection, id: string, item: unknown): void { this.records.set(`${collection}|${id}`, structuredClone(item)); }
  all<T>(collection: Collection): T[] {
    return [...this.records].filter(([key]) => key.startsWith(`${collection}|`)).map(([, value]) => structuredClone(value) as T);
  }
  documentChunks = vi.fn(() => [{ id: "chunk", title: "Document", text: "Synthetic indexed text", location: "Page 1" }]);
}
async function call(tools: Tool[], name: string, args: unknown = {}) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool?.handler) throw new Error(`Missing ${name}`);
  return tool.handler(args, { sessionId: "offline", toolCallId: "tool", toolName: name, arguments: args }) as Promise<any>;
}
function fixture() {
  const vault = new MemoryVault();
  const account: Account = { id: "allowed", provider: "gmail", name: "Synthetic", email: "test@example.com",
    status: "connected", consent: true, aiEnabled: true };
  const source: Source = { id: "mail", accountId: "allowed", providerId: "INBOX", name: "Inbox", kind: "mail", selected: true };
  const message: Message = { id: "m1", accountId: "allowed", sourceId: "mail", providerId: "1", threadId: "1", subject: "Synthetic request",
    sender: "sender@example.com", recipients: [], body: "Please review the synthetic document.", receivedAt: "2026-01-01T00:00:00Z",
    url: "https://example.com", unread: true, revision: "r1", historical: false };
  vault.put("accounts", account.id, account); vault.put("sources", source.id, source); vault.put("messages", message.id, message);
  vault.put("accounts", "excluded", { ...account, id: "excluded", aiEnabled: false });
  vault.put("sources", "excluded-mail", { ...source, id: "excluded-mail", accountId: "excluded" });
  vault.put("messages", "private", { ...message, id: "private", accountId: "excluded", sourceId: "excluded-mail", body: "DO NOT SHARE" });
  const settings: Settings = { ...defaultSettings, model: "user-selected" };
  const workspace = { tasks: [], settings, aiReview: { status: "idle" } } as unknown as Snapshot;
  const hooks = {
    changed: vi.fn(), settings: () => settings, workspace: () => workspace,
    search: vi.fn(async () => [
      { id: "c1", messageId: "m1", title: "Synthetic request", excerpt: message.body },
      { id: "bad", messageId: "private", title: "PRIVATE", excerpt: "DO NOT SHARE" }
    ]),
    refreshMail: vi.fn(async (request: MailFreshnessRequest): Promise<MailFreshnessResult> => ({
      status: "fresh", checkedAt: new Date().toISOString(),
      sources: vault.all<Source>("sources").filter(item => item.selected && item.kind === "mail"
        && (!request.accountId || item.accountId === request.accountId) && (!request.sourceId || item.id === request.sourceId))
        .map(item => ({ accountId: item.accountId, sourceId: item.id, status: "fresh", checkedAt: new Date().toISOString(), downloaded: 0, pending: 0 })),
      limitation: "Synthetic confirmed refresh."
    })),
    execute: vi.fn(async (_command: Command): Promise<CommandResult> => ({ message: "Task created locally." })),
    generate: vi.fn(async (_request: ChatAgentRequest) => ({ answer: "A useful answer.", citationIds: [] as string[] }))
  };
  const chat = new ChatService(vault as unknown as Vault, hooks);
  const send = async (text = "Help me", conversationId?: string, mailRefresh?: ChatMailRefresh) => {
    const result = await chat.command({ type: "chat.send", text, conversationId, mailRefresh });
    await chat.settled(); return result.conversationId!;
  };
  const last = () => chat.snapshot().conversations[0].turns.at(-1)!;
  const confirm = () => chat.command({ type: "chat.confirm", conversationId: chat.snapshot().conversations[0].id, turnId: last().id, actionId: last().actions[0].id });
  return { vault, hooks, chat, send, last, confirm, account, source, message, workspace };
}

describe("chat agent tools, consent and encrypted checkpoint state", () => {
  it.each([false, true])("keeps the answer and flags recaptured email evidence only when content changes: %s", async changed => {
    const f = fixture();
    const message: Message = { ...f.message,
      browser: { completeness: "full", capturedAt: "2026-09-25T14:00:00Z", dateText: "" } };
    f.vault.put("messages", message.id, message);
    f.hooks.generate.mockImplementation(async request => {
      const recent = await call(request.tools, "list_recent_messages", { accountId: "allowed" });
      f.vault.put("messages", message.id, { ...message,
        body: changed ? "The request was cancelled." : message.body,
        browser: { ...message.browser, capturedAt: "2026-09-25T14:01:00Z" } });
      return { answer: "The current email requests a review.", citationIds: [recent.messages[0].citation.id] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    expect(f.last().text).toContain("requests a review");
    expect(f.last().text.includes("Some sources were updated")).toBe(changed);
  });
  it("does not publish a claimed latest-inbox answer without any actual freshness attempt", async () => {
    const f = fixture();
    f.hooks.generate.mockResolvedValue({ answer: "I fetched the latest inbox and everything is complete.", citationIds: [] });
    await f.send("fetch latest emails for acme and tell me urgent tasks", undefined, "download");
    expect(f.last().text).toContain("Latest emails were not verified");
    expect(f.last().text).not.toContain("everything is complete");
  });
  it("awaits a scoped refresh and downloaded new reply before exposing recent messages or urgent tasks", async () => {
    const f = fixture();
    let release!: () => void;
    const download = new Promise<void>(resolve => { release = resolve; });
    f.hooks.refreshMail.mockImplementation(async request => {
      expect(request).toMatchObject({ accountId: "allowed", sourceId: "mail", force: true });
      request.progress("Downloading new email...");
      await download;
      f.vault.put("messages", "new-reply", { ...f.message, id: "new-reply", providerId: "new",
        threadId: "new-thread", revision: "new", receivedAt: "2026-09-25T14:00:00Z",
        body: "The incorporation forms were received and signed today. No signature follow-up is needed." });
      return { status: "fresh", checkedAt: "2026-09-25T14:01:00Z",
        sources: [{ accountId: "allowed", sourceId: "mail", status: "fresh", downloaded: 1, pending: 0 }],
        limitation: "Loaded inbox refreshed and discovered messages downloaded." };
    });
    f.hooks.generate.mockImplementation(async request => {
      expect(request.tools.some(tool => tool.name === "propose_refresh_request")).toBe(false);
      const status = await call(request.tools, "workspace_status");
      expect(status.accounts.map((account: Account) => account.email)).toEqual(["test@example.com"]);
      let readFinished = false;
      const reading = call(request.tools, "list_recent_messages", { accountId: "allowed" }).then(result => { readFinished = true; return result; });
      await vi.waitFor(() => expect(f.hooks.refreshMail).toHaveBeenCalledOnce());
      expect(readFinished).toBe(false);
      expect(f.last().progress).toBe("Downloading new email...");
      release();
      const recent = await reading;
      expect(recent.freshness.status).toBe("fresh");
      expect(recent.messages[0].id).toBe("new-reply");
      expect(recent.messages[0].citation.excerpt).toContain("were received and signed");
      await call(request.tools, "attention_overview", { accountId: "allowed" });
      await call(request.tools, "refresh_inbox", { accountId: "allowed" });
      expect(f.hooks.refreshMail).toHaveBeenCalledOnce();
      return { answer: "The newly downloaded reply confirms the forms are signed.", citationIds: [recent.messages[0].citation.id] };
    });
    await f.send("fetch latest emails for Synthetic and tell me urgent tasks", undefined, "download");
    expect(f.last().status).toBe("complete");
    expect(f.last().actions).toEqual([]);
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("makes failed live freshness prominent even if the model calls cached mail latest", async () => {
    const f = fixture();
    f.hooks.refreshMail.mockResolvedValue({ status: "partial", checkedAt: "2026-09-25T14:01:00Z",
      sources: [{ accountId: "allowed", sourceId: "mail", status: "partial", downloaded: 1, pending: 2,
        reason: "Two new conversations still need full-body downloads." }], limitation: "Incomplete download." });
    f.hooks.generate.mockImplementation(async request => {
      const overview = await call(request.tools, "attention_overview");
      expect(overview.freshness.status).toBe("partial");
      return { answer: "Here are the latest emails.", citationIds: [] };
    });
    await f.send("Help me", undefined, "download");
    expect(f.last().text).toMatch(/^\*\*Live inbox refresh is incomplete/);
    expect(f.last().text).toContain("Two new conversations");
    expect(f.last().actions).toHaveLength(0);
  });
  it("reports an unavailable read honestly without leaking raw provider errors", async () => {
    const f = fixture();
    f.hooks.refreshMail.mockRejectedValue(new Error("raw-secret-provider-detail"));
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "refresh_inbox", { accountId: "allowed" });
      expect(result.status).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("raw-secret-provider-detail");
      return { answer: "The live inbox could not be checked.", citationIds: [] };
    });
    await f.send("Help me", undefined, "download");
    expect(f.last().status).toBe("complete");
    expect(f.last().text).toContain("not a verified latest-inbox summary");
  });
  it("never refreshes an AI-excluded account or an unrelated account for a scoped question", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      expect((await call(request.tools, "refresh_inbox", { accountId: "excluded" })).status).toBe("unavailable");
      expect(f.hooks.refreshMail).not.toHaveBeenCalled();
      await call(request.tools, "refresh_inbox", { accountId: "allowed", sourceId: "mail" });
      expect(f.hooks.refreshMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: "allowed", sourceId: "mail" }));
      return { answer: "Only the requested permitted inbox was refreshed.", citationIds: [] };
    });
    await f.send("Help me", undefined, "download");
    expect(f.last().status).toBe("complete");
  });
  it("allows follow-up freshness to replace old message evidence without reusing old quotes", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementationOnce(async request => {
      const read = await call(request.tools, "read_message", { messageId: "m1" });
      return { answer: "An older message needed review.", citationIds: [read.citation.id] };
    });
    const conversation = await f.send();
    f.hooks.refreshMail.mockImplementationOnce(async () => {
      f.vault.put("messages", "m1", { ...f.message, body: "Review completed in the newly downloaded version.", revision: "r2" });
      return { status: "fresh", checkedAt: new Date().toISOString(), sources: [
        { accountId: "allowed", sourceId: "mail", status: "fresh", downloaded: 1, pending: 0 }
      ], limitation: "Synthetic refreshed evidence." };
    });
    f.hooks.generate.mockImplementationOnce(async request => {
      await call(request.tools, "refresh_inbox", { accountId: "allowed" });
      const read = await call(request.tools, "read_message", { messageId: "m1" });
      expect(read.citation.excerpt).toContain("Review completed");
      return { answer: "The review is now complete.", citationIds: [read.citation.id] };
    });
    await f.send("Fetch latest again", conversation, "download");
    expect(f.last().status).toBe("complete");
    expect(f.last().citations[0].excerpt).toContain("Review completed");
  });
  it("cancels evidence reads if permissions change during awaited refresh", async () => {
    const f = fixture();
    f.hooks.refreshMail.mockImplementation(async () => {
      f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
      return { status: "fresh", checkedAt: new Date().toISOString(), sources: [], limitation: "" };
    });
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "list_recent_messages", { accountId: "allowed" });
      return { answer: "MUST NOT APPEAR", citationIds: [] };
    });
    await f.send("Help me", undefined, "download");
    expect(f.last().text).not.toContain("MUST NOT APPEAR");
    expect(f.last().status).not.toBe("complete");
  });

  it.each([undefined, "local"] as const)("never refreshes mail through any read tool without this turn's approval (%s)", async mailRefresh => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      expect(JSON.parse(request.prompt).mailRefresh).toBe("local");
      for (const [name, args] of [
        ["refresh_inbox", {}], ["attention_overview", {}], ["list_recent_messages", {}],
        ["search_archive", { query: "review" }], ["read_message", { messageId: "m1" }]
      ] as const) {
        const result = await call(request.tools, name, args);
        expect(name === "refresh_inbox" ? result.status : result.freshness.status).toBe("local");
      }
      return { answer: "Using saved messages, the document needs review.", citationIds: [] };
    });
    await f.send("Which of my latest messages need attention today?", undefined, mailRefresh);
    expect(f.hooks.refreshMail).not.toHaveBeenCalled();
    expect(f.last()).toMatchObject({ status: "complete", mailRefresh: "local" });
    expect(f.last().mailFreshness).toBeUndefined();
    expect(f.last().text).toBe("Using saved messages, the document needs review.");
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });

  it.each(["no need to refresh messages", "don't download emails", "Do not refresh", "without downloading",
    "use saved messages", "pas besoin de télécharger"])("honors explicit opt-out even over an accidental download choice: %s", text => {
    expect(skipsChatMailRefresh(text)).toBe(true);
  });

  it("enforces explicit opt-out server-side and does not inherit earlier download approval", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "list_recent_messages");
      return { answer: "Saved context.", citationIds: [] };
    });
    const id = await f.send("Review messages", undefined, "download");
    expect(f.hooks.refreshMail).toHaveBeenCalledOnce();
    await f.send("Which emails need attention today? no need to refresh messages", id, "download");
    expect(f.hooks.refreshMail).toHaveBeenCalledOnce();
    expect(f.last().mailRefresh).toBe("local");
    expect(f.last().mailFreshness).toBeUndefined();
    await f.send("And the latest messages?", id);
    expect(f.hooks.refreshMail).toHaveBeenCalledOnce();
    expect(f.last().text).toBe("Saved context.");
    expect(commandSchema.safeParse({ type: "chat.send", text: "Hi", mailRefresh: "always" }).success).toBe(false);
  });

  it("includes today's local arrivals and a newer reply preview instead of repeating old urgent thread members", async () => {
    const f = fixture();
    for (let i = 0; i < 15; i++) f.vault.put("messages", `old-${i}`, { ...f.message,
      id: `old-${i}`, threadId: "long-old-thread", body: "Urgent: please confirm the overdue forms.",
      receivedAt: `2026-09-24T15:${String(i).padStart(2, "0")}:00Z`,
      browser: { completeness: "full", capturedAt: "2026-09-28T00:00:00Z", dateText: "" } });
    const today = { ...f.message, id: "today", threadId: "new-thread", receivedAt: "2026-09-29T09:30:00Z",
      subject: "New local mail", body: "The contract was signed this morning.", unread: false };
    f.vault.put("messages", today.id, today);
    f.vault.put("messages", "new-reply", { ...today, id: "new-reply", threadId: "long-old-thread",
      providerId: "thread:long-old-thread", receivedAt: "2026-09-29T09:20:00Z",
      body: "Forms were completed today.",
      browser: { completeness: "preview", capturedAt: "2026-09-29T09:21:00Z", dateText: "" } });
    f.hooks.generate.mockImplementation(async request => {
      const overview = await call(request.tools, "attention_overview");
      expect(overview.shortlist.map((item: { messageId: string }) => item.messageId)).toContain("today");
      expect(overview.shortlist.map((item: { messageId: string }) => item.messageId)).toContain("new-reply");
      expect(overview.shortlist.some((item: { messageId: string }) => item.messageId.startsWith("old-"))).toBe(false);
      expect(overview.coverage.newestLocalReceivedAt).toBe(today.receivedAt);
      expect(overview.coverage.permittedConversations).toBe(3);
      const recent = await call(request.tools, "list_recent_messages", { limit: 2 });
      expect(recent.messages.map((m: Message) => m.id)).toEqual(["today", "new-reply"]);
      return { answer: "Today's saved messages are included; the new reply is a preview.",
        citationIds: overview.shortlist.map((item: { citation: { id: string } }) => item.citation.id) };
    });
    await f.send("Which messages need attention? no need to refresh messages");
    expect(f.last().status).toBe("complete");
    expect(f.hooks.refreshMail).not.toHaveBeenCalled();
  });

  it("re-reads newly imported local mail on a follow-up instead of recycling the previous answer's evidence", async () => {
    const f = fixture();
    const observed: string[] = [];
    f.hooks.generate.mockImplementation(async request => {
      const latest = await call(request.tools, "list_recent_messages", { limit: 1 });
      observed.push(latest.messages[0].id);
      return { answer: "The newest saved message.", citationIds: [latest.messages[0].citation.id] };
    });
    const conversation = await f.send("Summarize my latest local messages");
    f.vault.put("messages", "arrived-after-answer", { ...f.message, id: "arrived-after-answer",
      threadId: "new-thread", receivedAt: "2026-09-29T09:30:00Z", revision: "new" });
    await f.send("And now? No need to refresh.", conversation, "local");
    expect(observed).toEqual(["m1", "arrived-after-answer"]);
    expect(f.last().citations[0].messageId).toBe("arrived-after-answer");
    expect(f.hooks.refreshMail).not.toHaveBeenCalled();
    const recovered = new ChatService(f.vault as unknown as Vault, f.hooks);
    expect(recovered.snapshot().conversations[0].turns.at(-1)?.mailRefresh).toBe("local");
  });

  it("builds a bounded account-balanced attention overview with permitted full-body citations", async () => {
    const f = fixture();
    f.vault.put("accounts", "second", { ...f.account, id: "second" });
    f.vault.put("sources", "second-mail", { ...f.source, id: "second-mail", accountId: "second" });
    f.vault.put("messages", "second-message", { ...f.message, id: "second-message", accountId: "second",
      sourceId: "second-mail", body: "A recent note.", unread: false });
    for (let i = 0; i < 14; i++) f.vault.put("messages", `candidate-${i}`, { ...f.message,
      id: `candidate-${i}`, threadId: `thread-${i}`, body: "intro ".repeat(300) + "Please review the decision before the deadline.",
      html: "<div>HTML_NOT_EVIDENCE</div>" });
    f.vault.put("messages", "preview", { ...f.message, id: "preview",
      browser: { completeness: "preview", capturedAt: "", dateText: "" } });
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "attention_overview");
      expect(result.shortlist).toHaveLength(8);
      expect(result.coverage).toMatchObject({ selectedMessages: 8, permittedAccounts: 2, selectedAccounts: 2 });
      expect(result.shortlist.some((item: { accountId: string }) => item.accountId === "second")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/DO NOT SHARE|HTML_NOT_EVIDENCE|chat:attention:preview/);
      expect(result.shortlist[0].citation.excerpt).toContain("Please review");
      expect(JSON.stringify(result).length).toBeLessThan(24000);
      const excluded = await call(request.tools, "attention_overview", { accountId: "excluded" });
      expect(excluded.shortlist).toEqual([]);
      return { answer: "A cited shortlist, with limited coverage.", citationIds: result.shortlist.map((item: { citation: { id: string } }) => item.citation.id) };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("explains provider stalls without blaming the breadth of a normal request", () => {
    expect(chatFailureMessage(new ChatTimeoutError("idle"))).toContain("stopped responding");
    expect(chatFailureMessage(new ChatTimeoutError("idle"))).not.toContain("narrower");
    expect(chatFailureMessage(new ChatTimeoutError("deadline"))).toContain("ten-minute");
  });
  it("prefers actual full mail, redirects retained preview reads with real IDs, and exposes honest coverage", async () => {
    const f = fixture();
    const preview: Message = { ...f.message, providerId: "thread:legacy", threadId: "allowed:thread:legacy",
      browser: { completeness: "preview", capturedAt: "2026-09-23T12:00:00Z", dateText: "" } };
    const full: Message = { ...preview, id: "full", providerId: "actual-message",
      body: "plain body ".repeat(1100) + " beyondpreview", html: "<div>HTML_ONLY_SECRET</div>",
      browser: { ...preview.browser!, completeness: "full", capturedAt: "2026-09-22T12:00:00Z" } };
    f.vault.put("messages", preview.id, preview); f.vault.put("messages", full.id, full);
    f.hooks.generate.mockImplementation(async request => {
      expect(JSON.parse(request.prompt).guidance).toContain("incomplete snippets");
      const recent = await call(request.tools, "list_recent_messages");
      expect(recent.messages.map((m: Message) => m.id)).toEqual(["full"]);
      expect(recent.messages[0].citation.location).toContain("Full message body");
      const retained = await call(request.tools, "read_message", { messageId: preview.id });
      expect(retained).toMatchObject({ completeness: "preview", fullMessageIds: ["full"] });
      expect(retained.citation.location).toContain("Browser Inbox preview");
      expect(retained.limitation).toContain("predate");
      const first = await call(request.tools, "read_message", { messageId: full.id });
      expect(first).toMatchObject({ completeness: "full", nextOffset: 10000, capturedAt: full.browser!.capturedAt });
      const next = await call(request.tools, "read_message", { messageId: full.id, offset: first.nextOffset });
      expect(next.citation.excerpt).toContain("beyondpreview");
      expect(JSON.stringify([first, next])).not.toContain("HTML_ONLY_SECRET");
      expect(await call(request.tools, "review_coverage")).toMatchObject({
        permittedMessages: 1, fullMessages: 1, downloadedBrowserFullMessages: 1, browserPreviewMessages: 0, retainedPreviewRecords: 1
      });
      return { answer: "Verified downloaded evidence.", citationIds: [next.citation.id] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
  });

  it("does not treat previews or another source's bodies as downloaded full evidence and blocks AI-off reads", async () => {
    const f = fixture();
    const preview: Message = { ...f.message, providerId: "thread:legacy", browser: { completeness: "preview", capturedAt: "", dateText: "" } };
    f.vault.put("messages", preview.id, preview);
    f.vault.put("sources", "other", { ...f.source, id: "other" });
    f.vault.put("messages", "other-full", { ...preview, id: "other-full", sourceId: "other", providerId: "actual",
      browser: { ...preview.browser!, completeness: "full" } });
    f.hooks.generate.mockImplementation(async request => {
      const retained = await call(request.tools, "read_message", { messageId: preview.id });
      expect(retained).toMatchObject({ completeness: "preview", fullMessageIds: [] });
      expect(retained.limitation).toContain("No full messages");
      expect((await call(request.tools, "list_recent_messages", { sourceId: "mail" })).messages[0].id).toBe(preview.id);
      expect(await call(request.tools, "read_message", { messageId: "private" })).toHaveProperty("error");
      expect((await call(request.tools, "list_recent_messages", { accountId: "excluded" })).messages).toEqual([]);
      return { answer: "Only a preview is available.", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
  });

  it("binds redirected full-message evidence revisions to pending actions without rewriting preview references", async () => {
    const f = fixture();
    const preview: Message = { ...f.message, providerId: "thread:legacy", browser: { completeness: "preview", capturedAt: "", dateText: "" } };
    const full: Message = { ...preview, id: "full", providerId: "actual", browser: { ...preview.browser!, completeness: "full" } };
    f.vault.put("messages", preview.id, preview); f.vault.put("messages", full.id, full);
    f.hooks.generate.mockImplementation(async request => {
      expect((await call(request.tools, "read_message", { messageId: preview.id })).fullMessageIds).toEqual(["full"]);
      f.vault.put("messages", full.id, { ...full, revision: "changed", body: "Changed after read" });
      return { answer: "Answer from the evidence read.", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    expect(f.last().text).toContain("Some sources were updated");
    expect(f.vault.get<Message>("messages", preview.id)?.revision).toBe(preview.revision);
  });

  it("proposes exact browser meeting moves and executes only the confirmed stored payload once", async () => {
    const f = fixture();
    f.vault.put("accounts", "allowed", { ...f.account, connection: "browser" });
    f.vault.put("sources", "calendar", { ...f.source, id: "calendar", kind: "calendar" });
    const item = { id: "meeting", accountId: "allowed", sourceId: "calendar", title: "Tech team discussion",
      whenText: "9am to 10am, Tech team discussion, September 24, 2026", location: "", description: "",
      capturedAt: "2026-09-23T08:00:00Z", url: "https://calendar.google.com/calendar/" };
    f.vault.put("browserItems", item.id, item);
    f.hooks.generate.mockImplementation(async request => {
      const tool = request.tools.find(tool => tool.name === "propose_browser_calendar_move")!;
      expect(JSON.stringify(tool.parameters)).not.toContain("expectedRevision");
      const proposal = await call(request.tools, tool.name, {
        itemId: item.id, newDate: "2026-09-23", startTime: "15:00", endTime: "16:00", timeZone: "Africa/Lagos"
      });
      expect(proposal.status).toBe("pending_confirmation");
      expect(proposal.preview).toContain("Tech team discussion");
      expect(proposal.preview).toContain("Africa/Lagos");
      expect(proposal.preview).toContain("may notify guests");
      return { answer: "Review the move to **today, 3–4pm (Africa/Lagos)** and confirm its card.", citationIds: [] };
    });
    await f.send();
    expect(f.hooks.execute).not.toHaveBeenCalled();
    f.vault.put("browserItems", item.id, { ...item, capturedAt: "2026-09-23T08:00:30Z" });
    f.hooks.execute.mockResolvedValueOnce({ message: "Google Calendar asks for guest confirmation.", browserCalendarOutcome: "needs-user" });
    await f.confirm();
    expect(f.hooks.execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "browser.calendar.move", itemId: "meeting", newDate: "2026-09-23", startTime: "15:00", endTime: "16:00",
      timeZone: "Africa/Lagos", expectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/)
    }), expect.any(Function));
    expect(f.last().actions[0].status).toBe("needs-user");
    await expect(f.confirm()).rejects.toThrow("not awaiting confirmation");
  });

  it("refuses invalid or excluded browser move proposals and invalidates changed events", async () => {
    const f = fixture();
    f.vault.put("accounts", "allowed", { ...f.account, connection: "browser" });
    f.vault.put("sources", "calendar", { ...f.source, id: "calendar", kind: "calendar" });
    const item = { id: "meeting", accountId: "allowed", sourceId: "calendar", title: "Discussion",
      whenText: "9am to 10am, Discussion, September 24, 2026", location: "", description: "",
      capturedAt: "2026-09-23T08:00:00Z", url: "" };
    f.vault.put("browserItems", item.id, item);
    f.vault.put("browserItems", "hidden", { ...item, id: "hidden", accountId: "excluded", sourceId: "excluded-mail" });
    f.hooks.generate.mockImplementation(async request => {
      const args = { itemId: "meeting", newDate: "2026-09-23", startTime: "15:00", endTime: "16:00", timeZone: "UTC" };
      for (const patch of [{ itemId: "hidden" }, { newDate: "2026-02-30" }, { endTime: "14:00" }, { timeZone: "Not/AZone" }])
        expect(await call(request.tools, "propose_browser_calendar_move", { ...args, ...patch })).toHaveProperty("error");
      expect(await call(request.tools, "propose_browser_calendar_move", args)).toHaveProperty("actionId");
      return { answer: "Review the pending move.", citationIds: [] };
    });
    await f.send();
    f.vault.put("browserItems", item.id, { ...item, whenText: "Changed calendar time" });
    await expect(f.confirm()).rejects.toThrow("changed");
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });

  it("finds named browser events beyond the first page without disclosing excluded calendars", async () => {
    const f = fixture();
    f.vault.put("sources", "calendar", { ...f.source, id: "calendar", kind: "calendar" });
    for (let i = 0; i < 25; i++) f.vault.put("browserItems", `event-${i}`, { id: `event-${i}`, accountId: "allowed", sourceId: "calendar",
      title: i === 24 ? "Tech team discussion" : `Unrelated ${i}`, whenText: "September 24, 2026, 10am", description: "", location: "", capturedAt: "2026-09-23T08:00:00Z", url: "" });
    f.vault.put("browserItems", "hidden", { id: "hidden", accountId: "excluded", sourceId: "excluded-mail",
      title: "Tech team discussion private", whenText: "DO NOT SHARE", description: "", location: "", capturedAt: "", url: "" });
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "find_browser_calendar_events", { query: "tech TEAM discussion" });
      expect(result.total).toBe(1);
      expect(result.events[0].id).toBe("event-24");
      expect(JSON.stringify(result)).not.toContain("DO NOT SHARE");
      const prompt = JSON.parse(request.prompt);
      expect(prompt.deviceTimeZone).toBeTruthy();
      expect(prompt.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return { answer: "Found the requested permitted event.", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
  });

  it("surfaces safe failure reasons without persisting raw provider content", () => {
    expect(chatFailureMessage(new SyntaxError("Private provider payload"))).toContain("invalid response JSON");
    expect(chatFailureMessage(new Error("Evidence changed during this chat. Start a new request."))).toContain("evidence changed");
    expect(chatFailureMessage(new Error("Copilot cited evidence it did not read."))).toContain("unverified citation");
    expect(chatFailureMessage(new Error("Private provider payload with sensitive event content"))).not.toContain("sensitive event");
  });

  it("exposes calendar insights only for AI-permitted sources and tracks uncited calendar evidence", async () => {
    const f = fixture();
    f.vault.put("sources", "calendar", { ...f.source, id: "calendar", kind: "calendar" });
    f.vault.put("sources", "private-calendar", { ...f.source, id: "private-calendar", accountId: "excluded", kind: "calendar" });
    const item = { id: "calendar-event", accountId: "allowed", sourceId: "calendar",
      title: "9am to 10am, Client briefing, April 12, 2099", whenText: "9am to 10am, Client briefing, April 12, 2099",
      location: "", description: "", url: "https://calendar.google.com/calendar/u/0/r/agenda", capturedAt: "2099-04-11T08:00:00Z" };
    f.vault.put("browserItems", item.id, item);
    f.vault.put("browserItems", "private-event", { ...item, id: "private-event", accountId: "excluded", sourceId: "private-calendar", title: "DO NOT SHARE", whenText: "DO NOT SHARE" });
    f.hooks.generate.mockImplementation(async request => {
      const insights = await call(request.tools, "calendar_insights");
      expect(insights.totalEntries).toBe(1);
      expect(JSON.stringify(insights)).not.toContain("DO NOT SHARE");
      expect(insights.upcoming[0].title).toBe("Client briefing");
      expect((await call(request.tools, "calendar_insights", { accountId: "excluded" })).totalEntries).toBe(0);
      return { answer: "Prepare for the client briefing; verify the displayed time zone.", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    f.vault.put("sources", "calendar", { ...f.source, id: "calendar", kind: "calendar", selected: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("client briefing");
  });

  it("lists recent messages without search terms, with scoped pagination and retained evidence", async () => {
    const f = fixture();
    f.vault.put("messages", "newer", { ...f.message, id: "newer", receivedAt: "2026-02-01T00:00:00Z" });
    f.vault.put("messages", "deleted", { ...f.message, id: "deleted", deleted: true });
    f.hooks.generate.mockImplementation(async request => {
      const first = await call(request.tools, "list_recent_messages", { limit: 1 });
      expect(first.total).toBe(2);
      expect(first.messages.map((message: { id: string }) => message.id)).toEqual(["newer"]);
      expect(first.nextOffset).toBe(1);
      expect(JSON.stringify(first)).not.toContain("DO NOT SHARE");
      const second = await call(request.tools, "list_recent_messages", { accountId: "allowed", sourceId: "mail", offset: 1 });
      expect(second.messages.map((message: { id: string }) => message.id)).toEqual(["m1"]);
      const excluded = await call(request.tools, "list_recent_messages", { accountId: "excluded" });
      expect(excluded.messages).toEqual([]);
      expect(await call(request.tools, "list_recent_messages", { limit: 13 })).toHaveProperty("error");
      return { answer: "These are the recent permitted messages.", citationIds: [] };
    });
    await f.send("Show my latest emails");
    expect(f.last().citations).toHaveLength(2);
    f.vault.put("sources", "mail", { ...f.source, selected: false });
    expect(f.chat.snapshot().conversations[0].title).toBe("Conversation unavailable");
  });

  it("uses the complete user message and selected model; runs real tool callbacks, not a router", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      expect(request.model).toBe("user-selected");
      expect(JSON.parse(request.prompt).userMessage).toBe("  explain everything\nwithout changing my text  ");
      expect(request.prompt).not.toContain("DO NOT SHARE");
      const data = await call(request.tools, "search_archive", { query: "document" });
      expect(data.excerpts.map((c: { id: string }) => c.id)).toEqual(["c1"]);
      const detail = await call(request.tools, "read_message", { messageId: "m1" });
      expect(detail.citation.excerpt).toContain("synthetic");
      expect(f.last().progress).toContain("Reading");
      return { answer: "The message asks for a document review.", citationIds: ["c1"] };
    });
    await f.send("  explain everything\nwithout changing my text  ");
    expect(f.hooks.search).toHaveBeenCalledWith("document", "allowed");
    expect(f.last().citations.length).toBe(2);
    expect(f.last().status).toBe("complete");
    expect(f.vault.get("checkpoints", "chat:v1")).toBeDefined();
    expect(JSON.stringify(f.chat.snapshot())).not.toContain('"guards"');
  });
  it("rejects unpermitted, unavailable and malformed tool arguments without reading them", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      expect(await call(request.tools, "read_message", { messageId: "private" })).toHaveProperty("error");
      expect(await call(request.tools, "read_message", { messageId: "m1", extra: "injection" })).toHaveProperty("error");
      expect(await call(request.tools, "propose_task_status", { taskId: "missing", status: "done" })).toHaveProperty("error");
      expect(request.tools.some(t => /shell|execute|send_mail|settings/.test(t.name) || ["calendar.approve", "draft.save", "task.schedule"].includes(t.name))).toBe(false);
      return { answer: "Those sources are not available.", citationIds: [] };
    });
    await f.send(); expect(f.last().actions).toEqual([]); expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("checks consent after an asynchronous tool read and does not publish its response", async () => {
    const f = fixture();
    f.hooks.search.mockImplementation(async () => {
      f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
      return [{ id: "c1", messageId: "m1", title: "Secret", excerpt: "new secret" }];
    });
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "search_archive", { query: "document" });
      return { answer: "new secret", citationIds: [] };
    });
    await f.send();
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("new secret");
    expect(f.last().status).not.toBe("complete");
  });
  it("rechecks consent after AI and removes all stale history, evidence and preview payloads", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "read_message", { messageId: "m1" });
      await call(request.tools, "propose_task_create", { title: "Derived private title" });
      f.vault.put("sources", "mail", { ...f.source, selected: false });
      return { answer: "Private output", citationIds: [] };
    });
    await f.send("User followup might quote source evidence");
    const persisted = JSON.stringify(f.vault.get("checkpoints", "chat:v1"));
    expect(persisted).not.toContain("Private output");
    expect(persisted).not.toContain("Derived private title");
    expect(persisted).not.toContain("User followup");
    expect(f.last().text).toContain("no longer permitted");
  });
  it("keeps completed conversations when cited mail is later removed from its label or replaced by provider churn", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "read_message", { messageId: "m1" });
      return { answer: "Answer the user already saw", citationIds: [] };
    });
    await f.send();
    f.vault.put("messages", "m1", { ...f.message, deleted: true });
    expect(f.chat.snapshot().conversations[0].title).not.toBe("Conversation unavailable");
    expect(JSON.stringify(f.chat.snapshot())).toContain("Answer the user already saw");
    f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("Answer the user already saw");
  });
  it("hides completed conversations immediately on later account revocation", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "read_message", { messageId: "m1" });
      return { answer: "Sensitive answer", citationIds: [] };
    });
    await f.send();
    f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("Sensitive answer");
    const reloaded = new ChatService(f.vault as unknown as Vault, f.hooks);
    expect(JSON.stringify(reloaded.snapshot())).not.toContain("Sensitive answer");
  });
  it("reads only already-indexed attachment pages", async () => {
    const f = fixture();
    f.vault.put("attachments", "a1", { id: "a1", messageId: "m1", accountId: "allowed", status: "indexed" });
    f.hooks.generate.mockImplementation(async request => {
      expect(await call(request.tools, "read_attachment", { attachmentId: "a1" })).toMatchObject({ excerpts: [{ id: "chunk" }] });
      expect(await call(request.tools, "read_attachment", { attachmentId: "not-indexed" })).toHaveProperty("error");
      return { answer: "Document summary", citationIds: ["chunk"] };
    });
    await f.send();
    expect(f.vault.documentChunks).toHaveBeenCalledWith("attachment:a1", 0, 6);
    expect(f.last().citations[0].attachmentId).toBe("a1");
  });
  it("restores interrupted turns as cancelled and never retries interrupted actions", () => {
    const f = fixture();
    f.vault.put("checkpoints", "chat:v1", { conversations: [{ id: "c", title: "Chat", updatedAt: "", turns: [{
      id: "t", role: "assistant", status: "working", text: "", createdAt: "", citations: [], evidence: [], actions: [{
        id: "a", title: "task.create", description: "", preview: "", status: "running", command: { type: "task.create", title: "Test" }, guards: []
      }]
    }] }] });
    const restored = new ChatService(f.vault as unknown as Vault, f.hooks);
    expect(restored.snapshot().conversations[0].turns[0]).toMatchObject({ status: "cancelled", actions: [{ status: "failed" }] });
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("returns immediately, publishes progress, cancels only this request, and bounds input", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await f.chat.command({ type: "chat.send", text: "A long-running question" });
    expect(f.chat.snapshot().busy).toBe(true);
    await f.chat.command({ type: "chat.cancel" }); await f.chat.settled();
    expect(f.chat.snapshot().busy).toBe(false); expect(f.last().status).toBe("cancelled");
    await expect(f.chat.command({ type: "chat.send", text: "x".repeat(CHAT_MESSAGE_MAX + 1) })).rejects.toThrow();
    expect(f.hooks.generate).toHaveBeenCalledOnce();
  });
  it("rejects hallucinated citations and excessive tool loops", async () => {
    const f = fixture();
    f.hooks.generate.mockResolvedValueOnce({ answer: "Claim", citationIds: ["never-read"] });
    await f.send(); expect(f.last().status).toBe("error");
    f.hooks.generate.mockImplementation(async request => {
      for (let i = 0; i < 17; i++) await call(request.tools, "workspace_status");
      return { answer: "Loop", citationIds: [] };
    });
    await f.send(); expect(f.last().status).toBe("error");
    expect(f.last().text).toContain("tool-call limit (16)");
  });
  it("purges forgotten account/source conversations from the encrypted checkpoint, including prior redaction placeholders", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "read_message", { messageId: "m1" });
      return { answer: "Account-specific answer", citationIds: [] };
    });
    await f.send();
    f.chat.forgetSource("mail");
    expect(f.chat.snapshot().conversations).toEqual([]);
    expect(JSON.stringify(f.vault.get("checkpoints", "chat:v1"))).not.toContain("Account-specific answer");
    await f.send();
    f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
    expect(f.chat.snapshot().conversations[0].title).toBe("Conversation unavailable");
    f.chat.forgetAccount("allowed");
    expect(f.chat.snapshot().conversations).toEqual([]);
    expect(f.vault.get("checkpoints", "chat:v1")).toMatchObject({ conversations: [] });
  });
  it("tracks calendar scope without model citations and preserves ambiguous browser time labels", async () => {
    const f = fixture();
    f.vault.put("sources", "cal", { ...f.source, id: "cal", kind: "calendar" });
    f.vault.put("browserItems", "meeting", { id: "meeting", accountId: "allowed", sourceId: "cal",
      title: "Protected browser meeting", whenText: "Tomorrow · about lunchtime", capturedAt: "2026-01-01T00:00:00Z", location: "" });
    let captured: unknown;
    f.hooks.generate.mockImplementation(async request => {
      captured = await call(request.tools, "list_browser_calendar");
      return { answer: "Protected browser meeting around lunchtime.", citationIds: [] };
    });
    await f.send();
    expect(captured).toMatchObject({ items: [{ whenText: "Tomorrow · about lunchtime" }] });
    f.vault.put("sources", "cal", { ...f.source, id: "cal", kind: "calendar", selected: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("Protected browser meeting");
  });
  it("tracks aggregate task-count scope even for permitted tasks outside the returned page", async () => {
    const f = fixture();
    f.vault.put("accounts", "other", { ...f.account, id: "other" });
    f.vault.put("sources", "other-mail", { ...f.source, id: "other-mail", accountId: "other" });
    f.vault.put("messages", "other-message", { ...f.message, id: "other-message", accountId: "other", sourceId: "other-mail" });
    const manual = { id: "manual", origin: "manual" as const, title: "Manual", notes: "", status: "open" as const, priority: "medium" as const,
      createdAt: "", updatedAt: "", citations: [] };
    const derived = { ...manual, id: "derived", origin: "action" as const, sourceAccountId: "other", sourceSourceId: "other-mail", sourceMessageId: "other-message" };
    f.workspace.tasks = [manual, derived];
    f.vault.put("tasks", "manual", manual); f.vault.put("tasks", "derived", derived);
    let captured: unknown;
    f.hooks.generate.mockImplementation(async request => {
      captured = await call(request.tools, "list_tasks", { limit: 1 });
      return { answer: "The permitted count is two.", citationIds: [] };
    });
    await f.send();
    expect(captured).toMatchObject({ tasks: [{ id: "manual" }], total: 2 });
    f.vault.put("accounts", "other", { ...f.account, id: "other", aiEnabled: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("permitted count is two");
  });
  it("withholds an oversized tool page without failing the answer and keeps status tools free of client credentials", async () => {
    const f = fixture();
    f.hooks.settings().googleClientId = "private-client-setting";
    let status: unknown;
    f.hooks.generate.mockImplementation(async request => {
      status = await call(request.tools, "workspace_status");
      for (let i = 0; i < 20; i++) f.vault.put("events", `event-${i}`, { id: `event-${i}`, accountId: "allowed", sourceId: "mail",
        title: "X".repeat(1500), start: "2026-01-01", end: "2026-01-02", timeZone: "UTC" });
      const oversized = await call(request.tools, "list_calendar");
      expect(oversized).toMatchObject({ executed: false, error: expect.stringContaining("limit 24,000 per tool response") });
      expect(JSON.stringify(oversized)).not.toContain("XXXX");
      return { answer: "Answered without the oversized page", citationIds: [] };
    });
    await f.send();
    expect(JSON.stringify(status)).not.toContain("private-client-setting");
    expect(f.last().status).toBe("complete");
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("XXXX");
  });
  it("withholds tool output beyond the evidence budget and lets the model answer from what it gathered", async () => {
    const f = fixture();
    f.vault.put("messages", "m1", { ...f.message, body: "X".repeat(10000) });
    f.hooks.generate.mockImplementation(async request => {
      const results = [];
      for (let i = 0; i < 16; i++) results.push(await call(request.tools, "read_message", { messageId: "m1" }));
      const withheld = results.filter(result => result.budgetExhausted);
      expect(withheld.length).toBeGreaterThan(0);
      expect(results.findIndex(result => result.budgetExhausted)).toBeGreaterThan(10);
      expect(withheld[0].error).toContain("Answer now from the evidence already gathered");
      expect(JSON.stringify(withheld)).not.toContain("XXXX");
      return { answer: "Answer from gathered evidence", citationIds: [] };
    });
    await f.send();
    expect(f.last()).toMatchObject({ status: "complete", text: expect.stringContaining("Answer from gathered evidence") });
  });
  it("tracks report calendar scope even with no model or report mail citations", async () => {
    const f = fixture();
    f.vault.put("sources", "cal", { ...f.source, id: "cal", kind: "calendar" });
    f.workspace.focusReport = {
      generatedAt: "", narrative: "Protected report summary", accountIds: [], sourceIds: [], rankedTasks: [], citations: [], nextActions: [],
      metrics: {}, warnings: [], upcomingMeetings: [{ accountId: "allowed", sourceId: "cal" }]
    } as unknown as NonNullable<Snapshot["focusReport"]>;
    let captured: unknown;
    f.hooks.generate.mockImplementation(async request => {
      captured = await call(request.tools, "read_focus_report");
      return { answer: "Protected report summary", citationIds: [] };
    });
    const conversationId = await f.send();
    expect(captured).toMatchObject({ narrative: "Protected report summary" });
    f.vault.put("sources", "cal", { ...f.source, id: "cal", kind: "calendar", selected: false });
    expect(JSON.stringify(f.chat.snapshot())).not.toContain("Protected report summary");
    f.hooks.generate.mockImplementation(async request => {
      expect(request.prompt).not.toContain("Protected report summary");
      return { answer: "Start again with permitted data.", citationIds: [] };
    });
    await f.send("Continue", conversationId);
    expect(f.last().status).toBe("complete");
  });
  it("reloads the replacement encrypted checkpoint on restore rather than retaining pre-restore memory", async () => {
    const f = fixture();
    const old = await f.send();
    f.vault.put("checkpoints", "chat:v1", { activeConversationId: "restored", conversations: [{
      id: "restored", title: "Restored", updatedAt: "", turns: [{
        id: "restored-turn", role: "assistant", text: "Restored answer", status: "complete", createdAt: "", citations: [], actions: [],
        evidence: [{ collection: "messages", id: "m1", accountId: "allowed", sourceId: "mail" }]
      }]
    }] });
    f.chat.recover(true);
    expect(f.chat.snapshot().conversations.map(c => c.id)).toEqual(["restored"]);
    expect(f.chat.snapshot().conversations.map(c => c.id)).not.toContain(old);
    f.vault.put("accounts", "allowed", { ...f.account, aiEnabled: false });
    f.chat.recover(true);
    expect(JSON.stringify(f.vault.get("checkpoints", "chat:v1"))).not.toContain("Restored answer");
  });
});

describe("persisted one-shot chat action approvals", () => {
  it("executes only the stored exact payload, once, after the agent is finished", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_task_create", { title: "Call Alex", notes: "Tomorrow", priority: "high" });
      expect(f.hooks.execute).not.toHaveBeenCalled();
      await expect(f.confirm()).rejects.toThrow("running");
      return { answer: "Please confirm the task preview.", citationIds: [] };
    });
    await f.send();
    expect(f.last().actions[0].preview).toContain("Call Alex");
    await f.confirm();
    expect(f.hooks.execute).toHaveBeenCalledExactlyOnceWith({ type: "task.create", title: "Call Alex", notes: "Tomorrow", priority: "high" }, expect.any(Function));
    await expect(f.confirm()).rejects.toThrow("not awaiting");
    expect(f.last().actions[0].status).toBe("completed");
  });
  it("keeps status/task proposals valid across harmless background refresh timestamps", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "workspace_status");
      await call(request.tools, "propose_task_create", { title: "Review refreshed inbox" });
      f.vault.put("sources", "mail", { ...f.source, lastSync: "2026-01-01T01:00:00Z" });
      return { answer: "Confirm the task", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    f.vault.put("sources", "mail", { ...f.source, lastSync: "2026-01-01T02:00:00Z" });
    await f.confirm();
    expect(f.hooks.execute).toHaveBeenCalledOnce();
  });
  it("rechecks target revisions and keeps failures visible and one-shot", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_draft_generate", { messageId: "m1", instruction: "Thank them" });
      return { answer: "Confirm a local draft.", citationIds: [] };
    });
    await f.send();
    f.vault.put("messages", "m1", { ...f.message, revision: "r2" });
    await expect(f.confirm()).rejects.toThrow("changed");
    expect(f.hooks.execute).not.toHaveBeenCalled();
    expect(f.last().actions[0].status).toBe("failed");
  });
  it("keeps a read-only answer but voids a proposal when its sources change mid-request", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_draft_generate", { messageId: "m1", instruction: "Thank them" });
      f.vault.put("messages", "m1", { ...f.message, revision: "r2" });
      return { answer: "Here is the overview.", citationIds: [] };
    });
    await f.send();
    expect(f.last().status).toBe("complete");
    expect(f.last().text).toContain("Here is the overview.");
    expect(f.last().text).toContain("Some sources were updated");
    expect(f.last().actions[0].status).toBe("failed");
    await expect(f.confirm()).rejects.toThrow();
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("does not claim success when an approved app command fails", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_task_create", { title: "Review inbox" });
      return { answer: "Confirm task", citationIds: [] };
    });
    f.hooks.execute.mockRejectedValue(new Error("provider unavailable"));
    await f.send(); await expect(f.confirm()).rejects.toThrow("failed");
    expect(f.last().actions[0]).toMatchObject({ status: "failed" });
    await expect(f.confirm()).rejects.toThrow("not awaiting");
    expect(f.hooks.execute).toHaveBeenCalledOnce();
  });
  it("persists pending exact approvals across restart but invalidates them after backup restore", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_task_create", { title: "Persist this exact title" });
      return { answer: "Confirm the preview", citationIds: [] };
    });
    await f.send();
    const restarted = new ChatService(f.vault as unknown as Vault, f.hooks);
    expect(restarted.snapshot().conversations[0].turns.at(-1)?.actions[0].status).toBe("pending");
    restarted.recover(true);
    expect(restarted.snapshot().conversations[0].turns.at(-1)?.actions[0].status).toBe("failed");
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("rejects a modified persisted payload even when its action ID is valid", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      await call(request.tools, "propose_task_create", { title: "Reviewed title" });
      return { answer: "Confirm the preview", citationIds: [] };
    });
    await f.send();
    const state = f.vault.get<any>("checkpoints", "chat:v1");
    state.conversations[0].turns.at(-1).actions[0].command = { type: "task.create", title: "Unreviewed replacement" };
    f.vault.put("checkpoints", "chat:v1", state);
    const restarted = new ChatService(f.vault as unknown as Vault, f.hooks);
    const conversation = restarted.snapshot().conversations[0], turn = conversation.turns.at(-1)!;
    await expect(restarted.command({ type: "chat.confirm", conversationId: conversation.id, turnId: turn.id, actionId: turn.actions[0].id })).rejects.toThrow("preview");
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });
  it("rejects unavailable calendar actions and only proposes a separate approval", async () => {
    const f = fixture();
    f.vault.put("sources", "cal", { ...f.source, id: "cal", kind: "calendar" });
    f.hooks.generate.mockImplementation(async request => {
      const change = { accountId: "allowed", sourceId: "cal", title: "Focus", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z",
        timeZone: "UTC", allDay: false, attendees: [], location: "", description: "" };
      expect(await call(request.tools, "propose_calendar_propose", { change: { ...change, end: "bad" } })).toHaveProperty("error");
      expect(await call(request.tools, "propose_calendar_propose", { change })).toHaveProperty("actionId");
      return { answer: "Create a Calendar approval after confirming this preview.", citationIds: [] };
    });
    await f.send(); await f.confirm();
    expect(f.hooks.execute.mock.calls[0][0]).toMatchObject({ type: "calendar.propose" });
  });
  it("the IPC contract rejects renderer-supplied execution payloads and schemas are SDK JSON Schema", () => {
    expect(commandSchema.safeParse({ type: "chat.confirm", conversationId: "c", turnId: "t", actionId: "a", command: { type: "settings.update" } }).success).toBe(false);
    const schema = commandSchema.options.find(item => item.shape.type.value === "chat.send")!;
    expect(toolParameters(schema)).toMatchObject({ type: "object", additionalProperties: false, required: ["type", "text"] });
  });
});
