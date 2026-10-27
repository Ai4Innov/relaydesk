import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account, ActionItem, Citation, Collection, Message, Snapshot, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { ArchiveAiReview, REVIEW_BATCH_SIZE, REVIEW_CHUNK_SIZE } from "../src/main/ai-review";
import { ProductivityService } from "../src/main/productivity";
import { ArchiveReviewPanel } from "../src/renderer/Productivity";
import { commandSchema } from "../src/main/ipc/schema";
import { DEFAULT_PRIORITY_DOMAINS, messagePriority, normalizePriorityDomains } from "../src/shared/priority";

class MemoryVault {
  records = new Map<Collection, Map<string, unknown>>();
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
  delete(collection: Collection, id: string): void { this.records.get(collection)?.delete(id); }
  transaction<T>(work: () => T): T {
    const before = structuredClone(this.records);
    try { return work(); } catch (error) { this.records = before; throw error; }
  }
}
const account: Account = { id: "account", provider: "gmail", name: "Synthetic", email: "test@example.com", consent: true, aiEnabled: true, status: "connected" };
const source: Source = { id: "mail", accountId: account.id, providerId: "inbox", name: "Inbox", kind: "mail", selected: true };
function message(index = 0, overrides: Partial<Message> = {}): Message {
  return {
    id: `message-${index}`, accountId: account.id, sourceId: source.id, providerId: `provider-${index}`, threadId: `thread-${index}`,
    subject: `Synthetic request ${index}`, sender: "sender@example.com", recipients: [account.email],
    body: `Please review document number ${index}.`, receivedAt: new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
    url: "https://mail.google.com", unread: false, revision: "r1", historical: true, ...overrides
  };
}
function seed(messages: Message[] = [message()]): MemoryVault {
  const vault = new MemoryVault();
  vault.put("accounts", account.id, account);
  vault.put("sources", source.id, source);
  for (const item of messages) vault.put("messages", item.id, item);
  return vault;
}
function apiOriginFixture() {
  const api: Account = { ...account, id: "api-origin" };
  const apiSource: Source = { ...source, id: "api-origin-mail", accountId: api.id };
  const gmailApi = { accountId: api.id, sourceId: apiSource.id };
  const item = message(0, { gmailApi, browser: { completeness: "full", capturedAt: "", dateText: "" } });
  const vault = seed([item]);
  vault.put("accounts", account.id, { ...account, connection: "browser" });
  vault.put("accounts", api.id, api);
  vault.put("sources", apiSource.id, apiSource);
  return { vault, api, apiSource, item };
}
function response(citations: Citation[], suggest = false) {
  return {
    citationIds: citations.map(citation => citation.id),
    answer: JSON.stringify({
      reviewedCitationIds: citations.map(citation => citation.id),
      summary: "Synthetic batch reviewed; old requests need confirmation.",
      suggestions: suggest ? citations.map(citation => ({
        citationId: citation.id, quote: citation.excerpt, title: `Review ${citation.messageId}`, reason: "Explicit request; confirm it is still open.", priority: "normal"
      })) : []
    })
  };
}
function hooks(suggest = false) {
  return { changed: vi.fn(), generate: vi.fn(async (_prompt: string, citations: Citation[]) => response(citations, suggest)) };
}
function snapshot(vault: MemoryVault, messages = vault.all<Message>("messages")): Snapshot {
  return {
    accounts: vault.all("accounts"), sources: vault.all("sources"), messages, actions: vault.all("actions"),
    drafts: [], attachments: [], events: [], jobs: [], approvals: [], settings: { ...defaultSettings, model: "selected-model" },
    models: [{ id: "selected-model", name: "Selected" }], copilot: { status: "ready", message: "Synthetic" },
    archive: { messages: vault.all("messages").length, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false
  };
}

describe("resumable all-local-email review", () => {
  it.each(["consent", "ai", "source", "identity", "missing", "owner-ai"] as const)(
    "excludes API-origin aliases after %s permission loss without sending their text", async permission => {
      const f = apiOriginFixture();
      if (permission === "source") f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
      else if (permission === "missing") f.vault.delete("accounts", f.api.id);
      else if (permission === "owner-ai") f.vault.put("accounts", account.id, { ...account, connection: "browser", aiEnabled: false });
      else f.vault.put("accounts", f.api.id, { ...f.api, ...(permission === "consent" ? { consent: false }
        : permission === "ai" ? { aiEnabled: false } : { email: "different@example.com" }) });
      const generated = hooks(true);
      const review = new ArchiveAiReview(f.vault, generated);
      expect(review.coverage()).toMatchObject({ totalEligible: 0, excluded: 1, reports: [] });
      expect(() => review.start(1)).toThrow("No eligible");
      expect(generated.generate).not.toHaveBeenCalled();
    });

  it.each(["consent", "ai", "source"] as const)("discards in-flight API-origin review after %s revocation", async permission => {
    const f = apiOriginFixture();
    const generated = hooks(true);
    generated.generate.mockImplementation(async (_prompt, citations) => {
      if (permission === "source") f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
      else f.vault.put("accounts", f.api.id, { ...f.api, ...(permission === "ai" ? { aiEnabled: false } : { consent: false }) });
      return response(citations, true);
    });
    const review = new ArchiveAiReview(f.vault, generated);
    review.start(1); await review.settled();
    expect(review.coverage()).toMatchObject({ status: "paused", reviewed: 0, failures: 1, reports: [] });
    expect(f.vault.all("actions")).toEqual([]);
    expect(f.vault.all<{ kind?: string }>("checkpoints").filter(item => item.kind === "archive-review-chunk")).toEqual([]);
  });

  it("hides retained batch actions, citations, reports and focus tasks when the API origin is revoked", async () => {
    const f = apiOriginFixture();
    f.vault.put("messages", "message-1", message(1));
    const service = new ProductivityService(f.vault as never, { ...hooks(true), schedule: vi.fn() });
    service.review.start(1); await service.review.settled();
    const actions = f.vault.all<ActionItem>("actions");
    expect(actions).toHaveLength(2);
    expect(service.review.coverage().reports).toHaveLength(1);
    expect(service.snapshot(snapshot(f.vault)).tasks).toHaveLength(2);
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(actions.every(action => !service.review.actionVisible(action))).toBe(true);
    expect(actions.every(action => !service.review.citationVisible(action.citations[0]))).toBe(true);
    expect(service.review.coverage().reports).toEqual([]);
    expect(service.snapshot(snapshot(f.vault)).tasks).toEqual([]);
  });

  it("binds provenance to review fingerprints and preserves origin deletion dependencies after recapture", async () => {
    const f = apiOriginFixture();
    const review = new ArchiveAiReview(f.vault, hooks(true));
    review.start(1); await review.settled();
    const action = f.vault.all<ActionItem>("actions")[0];
    f.vault.put("messages", f.item.id, { ...f.item, gmailApi: undefined });
    expect(review.coverage()).toMatchObject({ reviewed: 0, remaining: 1, reports: [] });
    expect(review.actionVisible(action)).toBe(false);
    expect(review.forgetAccount(f.api.id).has(action.id)).toBe(true);
    expect(f.vault.all("actions")).toEqual([]);
    expect(f.vault.all<{ kind?: string }>("checkpoints").filter(item => item.kind?.startsWith("archive-review"))).toEqual([]);
  });

  it("replaces generated fields when re-reviewing a duplicate instead of relabelling old origin-derived text", async () => {
    const f = apiOriginFixture();
    const generated = hooks(true);
    generated.generate.mockImplementation(async (_prompt, citations) => {
      const result = response(citations, true);
      const output = JSON.parse(result.answer);
      output.suggestions[0].reason = "Earlier API-only sensitive context";
      return { ...result, answer: JSON.stringify(output) };
    });
    const review = new ArchiveAiReview(f.vault, generated);
    review.start(1); await review.settled();
    f.vault.put("messages", f.item.id, { ...f.item, gmailApi: undefined });
    f.vault.put("accounts", f.api.id, { ...f.api, consent: false });
    generated.generate.mockImplementation(async (_prompt, citations) => response(citations, true));
    review.start(1); await review.settled();
    const [action] = f.vault.all<ActionItem>("actions");
    expect(review.actionVisible(action)).toBe(true);
    expect(action.reason).not.toContain("API-only");
    expect(f.vault.all("actions")).toHaveLength(1);
  });

  it("accepts whitespace-only quote formatting and stores the original source passage", async () => {
    const text = "Please\nreview\u00a0the report (version 2).";
    const vault = seed([message(0, { body: text })]);
    const generated = hooks(true);
    generated.generate.mockImplementation(async (_prompt, citations) => {
      const result = response(citations, true);
      const output = JSON.parse(result.answer);
      output.suggestions[0].quote = "Please review the report (version 2).";
      return { ...result, answer: JSON.stringify(output) };
    });
    const review = new ArchiveAiReview(vault, generated);
    review.start(1);
    await review.settled();
    expect(review.coverage()).toMatchObject({ status: "complete", reviewed: 1, failures: 0 });
    expect(vault.all<ActionItem>("actions")[0].citations[0].excerpt).toBe(text);
  });
  it("reviews the entire archive beyond 500 messages, oldest first, with bounded sequential requests and persisted resume", async () => {
    const messages = Array.from({ length: 513 }, (_, index) => message(index));
    const vault = seed(messages.reverse());
    const generated = hooks();
    let review = new ArchiveAiReview(vault, generated);
    review.start(1);
    await review.settled();
    expect(generated.generate.mock.calls[0][1].map(citation => citation.messageId)).toEqual(["message-0", "message-1", "message-2", "message-3"]);
    expect(review.coverage()).toMatchObject({ status: "paused", totalEligible: 513, reviewed: 4, remaining: 509, batchesCompleted: 1 });
    review = new ArchiveAiReview(vault, generated);
    while (review.coverage().remaining) { review.start(20); await review.settled(); }
    const sent = generated.generate.mock.calls.flatMap(call => call[1]);
    expect(new Set(sent.map(citation => citation.messageId)).size).toBe(513);
    expect(sent).toHaveLength(513);
    expect(generated.generate.mock.calls.every(call => call[1].length <= REVIEW_BATCH_SIZE)).toBe(true);
    expect(review.coverage()).toMatchObject({ status: "complete", reviewed: 513, remaining: 0 });
  });

  it("reviews every character of long bodies instead of truncating their tail, and distinguishes preview coverage", async () => {
    const body = "a".repeat(REVIEW_CHUNK_SIZE * 2) + "Tail contains the important request.";
    const vault = seed([message(0, { body, browser: { completeness: "preview", capturedAt: "2026-09-22T10:00:00Z", dateText: "unknown" } })]);
    const generated = hooks();
    const review = new ArchiveAiReview(vault, generated);
    review.start(1);
    await review.settled();
    expect(generated.generate.mock.calls.flatMap(call => call[1]).map(citation => citation.excerpt).join("")).toBe(body);
    expect(review.coverage()).toMatchObject({ status: "complete", reviewed: 1, totalChunks: 3, reviewedChunks: 3, previewMessages: 1 });
    vault.put("messages", "message-0", message(0, { body: body + " New revision", revision: "r2" }));
    expect(review.coverage()).toMatchObject({ status: "paused", reviewed: 0, remaining: 1, reports: [] });
  });

  it("counts excluded sources/accounts without enabling any AI consent or sending their evidence", async () => {
    const vault = seed([message()]);
    const exclusions: [Partial<Account>, Partial<Source>, Partial<Message>][] = [
      [{ aiEnabled: false }, {}, {}], [{ consent: false }, {}, {}], [{ status: "disconnected" }, {}, {}],
      [{}, { selected: false }, {}], [{}, { kind: "channel" }, {}], [{}, {}, { deleted: true }], [{}, {}, { subject: "", body: "" }]
    ];
    exclusions.forEach(([accountChange, sourceChange, messageChange], index) => {
      vault.put("accounts", `excluded-${index}`, { ...account, id: `excluded-${index}`, ...accountChange });
      vault.put("sources", `excluded-source-${index}`, { ...source, id: `excluded-source-${index}`, accountId: `excluded-${index}`, ...sourceChange });
      vault.put("messages", `message-${index + 1}`, message(index + 1, { accountId: `excluded-${index}`, sourceId: `excluded-source-${index}`, ...messageChange }));
    });
    const generated = hooks();
    const review = new ArchiveAiReview(vault, generated);
    review.start(5); await review.settled();
    expect(review.coverage()).toMatchObject({ totalAvailable: 8, totalEligible: 1, excluded: 7, reviewed: 1 });
    expect(generated.generate.mock.calls[0][1]).toHaveLength(1);
    expect(vault.get<Account>("accounts", "excluded-0")?.aiEnabled).toBe(false);
  });

  it("never marks a budget-exhausted or failed partial run complete, and resumes without repeating saved evidence", async () => {
    const vault = seed(Array.from({ length: 9 }, (_, index) => message(index)));
    let calls = 0;
    const generate = vi.fn(async (_prompt: string, citations: Citation[]) => {
      if (++calls === 2) throw new Error("Your local daily AI-run budget is exhausted.");
      return response(citations);
    });
    const review = new ArchiveAiReview(vault, { changed: vi.fn(), generate });
    review.start(5); await review.settled();
    expect(review.coverage()).toMatchObject({ status: "paused", reviewed: 4, remaining: 5, failures: 1, failedMessages: 4 });
    expect(review.coverage().detail).toContain("budget is exhausted");
    review.start(5); await review.settled();
    expect(review.coverage()).toMatchObject({ status: "complete", reviewed: 9, remaining: 0, failures: 1, failedMessages: 0 });
    expect(generate.mock.calls[2][1].map(citation => citation.messageId)).toEqual(generate.mock.calls[1][1].map(citation => citation.messageId));
  });

  it("drops unquoted suggestions and unsupported deadlines without discarding the reviewed batch", async () => {
    for (const mode of ["quote", "deadline"] as const) {
      const vault = seed();
      const generated = hooks();
      generated.generate.mockImplementation(async (_prompt, citations) => {
        const good = response(citations, true);
        const output = JSON.parse(good.answer);
        if (mode === "quote") output.suggestions[0].quote = "Not in this message";
        if (mode === "deadline") { output.suggestions[0].dueAt = "2026-09-30"; output.suggestions[0].dueQuote = "2026-09-30"; }
        return { ...good, answer: `Here is the review:\n${JSON.stringify(output)}` };
      });
      const review = new ArchiveAiReview(vault, generated);
      review.start(1); await review.settled();
      expect(review.coverage()).toMatchObject({ reviewed: 1, remaining: 0, failures: 0 });
      const actions = vault.all<ActionItem>("actions");
      if (mode === "quote") expect(actions).toEqual([]);
      else expect(actions).toEqual([expect.objectContaining({ dueAt: undefined })]);
    }
  });

  it("rejects output that acknowledges no segment", async () => {
    for (const mode of ["acknowledgement"]) {
      const vault = seed();
      const generated = hooks();
      generated.generate.mockImplementation(async (_prompt, citations) => {
        const good = response(citations, true);
        const output = JSON.parse(good.answer);
        if (mode === "acknowledgement") output.reviewedCitationIds = [];
        return { ...good, answer: JSON.stringify(output) };
      });
      const review = new ArchiveAiReview(vault, generated);
      review.start(1); await review.settled();
      expect(review.coverage()).toMatchObject({ status: "paused", reviewed: 0, remaining: 1, failures: 1, reports: [] });
      expect(vault.all("actions")).toEqual([]);
    }
  });

  it("discards in-flight output on pause/cancel and blocks concurrent starts", async () => {
    for (const cancelled of [false, true]) {
      const vault = seed();
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const review = new ArchiveAiReview(vault, {
        changed: vi.fn(), generate: async (_prompt, citations) => { await waiting; return response(citations, true); }
      });
      review.start(5);
      expect(() => review.start(1)).toThrow("still finishing");
      review.pause(cancelled);
      release(); await review.settled();
      expect(review.coverage()).toMatchObject({ status: cancelled ? "cancelled" : "paused", reviewed: 0, remaining: 1, reports: [] });
      expect(vault.all("actions")).toEqual([]);
    }
  });

  it("rejects a complete batch when any input loses permission in flight and hides prior cross-account outputs after opt-out", async () => {
    const vault = seed([message(), message(1, { accountId: "other", sourceId: "other-mail" })]);
    vault.put("accounts", "other", { ...account, id: "other" });
    vault.put("sources", "other-mail", { ...source, id: "other-mail", accountId: "other" });
    const generated = hooks(true);
    const review = new ArchiveAiReview(vault, generated);
    review.start(1); await review.settled();
    const actions = vault.all<ActionItem>("actions");
    expect(actions).toHaveLength(2);
    vault.put("accounts", "other", { ...account, id: "other", aiEnabled: false });
    expect(review.coverage().reports).toEqual([]);
    expect(actions.every(action => !review.actionVisible(action))).toBe(true);

    const another = seed();
    const racing = new ArchiveAiReview(another, {
      changed: vi.fn(), generate: async (_prompt, citations) => {
        another.put("accounts", account.id, { ...account, aiEnabled: false });
        return response(citations, true);
      }
    });
    racing.start(1); await racing.settled();
    expect(racing.coverage()).toMatchObject({ status: "paused", failures: 1, reviewed: 0, reports: [] });
    expect(another.all("actions")).toEqual([]);
  });

  it("generates editable old-email tasks outside the snapshot and preserves manual edits/completions when evidence is re-reviewed", async () => {
    const vault = seed([message()]);
    const service = new ProductivityService(vault as never, { ...hooks(true), schedule: vi.fn() });
    await service.command({ type: "review.start", maxBatches: 1 }, snapshot(vault, []));
    await service.review.settled();
    const current = () => snapshot(vault, []);
    const task = service.snapshot(current()).tasks[0];
    expect(task.sourceMessageId).toBe("message-0");
    await service.command({ type: "task.edit", taskId: task.id, title: "My edited title", notes: "Keep my notes", status: "done" }, current());
    await service.command({ type: "task.create", title: "My manual task" }, current());
    vault.put("messages", "message-0", message(0, { revision: "r2" }));
    service.review.start(1); await service.review.settled();
    const tasks = service.snapshot(current()).tasks;
    expect(vault.all("actions")).toHaveLength(1);
    expect(tasks.find(item => item.id === task.id)).toMatchObject({ title: "My edited title", notes: "Keep my notes", status: "done" });
    expect(tasks.some(item => item.title === "My manual task")).toBe(true);
    vault.put("accounts", account.id, { ...account, aiEnabled: false });
    expect(service.snapshot(current()).tasks.map(item => item.title)).toEqual(["My manual task"]);
  });

  it("recovers interrupted runs and renders truthful persisted coverage plus explicit bounded controls", () => {
    const vault = seed();
    vault.put("checkpoints", "archive-review:state", {
      status: "running", updatedAt: "2026-09-22T00:00:00Z", failures: 0, failedEvidence: [], batchesCompleted: 0, batchLimit: 5
    });
    const review = new ArchiveAiReview(vault, hooks());
    expect(review.coverage().status).toBe("paused");
    const data = { ...snapshot(vault), aiReview: review.coverage() };
    const markup = renderToStaticMarkup(createElement(ArchiveReviewPanel, { data, busy: false, run: vi.fn() }));
    for (const text of ["1 eligible", "0 reviewed", "1 remaining", "0 excluded", "failed attempts", "Maximum sequential batches",
      "Browser capture cannot see unloaded email", "explicit AI consent", "Current model: ", "selected-model", "Persisted coverage"])
      expect(markup).toContain(text);
    expect(commandSchema.safeParse({ type: "review.start", maxBatches: 20 }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "review.start", maxBatches: 21 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "review.pause" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "review.cancel" }).success).toBe(true);
  });

  it("keeps long-message partial chunk coverage resumable without marking the message reviewed early", async () => {
    const vault = seed([message(0, { body: "x".repeat(REVIEW_CHUNK_SIZE * 5) + "last character" })]);
    const generated = hooks();
    let review = new ArchiveAiReview(vault, generated);
    review.start(1); await review.settled();
    expect(review.coverage()).toMatchObject({ reviewed: 0, remaining: 1, reviewedChunks: 4, totalChunks: 6, status: "paused" });
    review = new ArchiveAiReview(vault, generated);
    review.start(1); await review.settled();
    expect(review.coverage()).toMatchObject({ reviewed: 1, remaining: 0, reviewedChunks: 6, status: "complete" });
    expect(generated.generate.mock.calls[1][1]).toHaveLength(2);
  });

  it("protects focus narratives against revoked batch inputs and forgets derived cross-account evidence", async () => {
    const vault = seed([message(), message(1, { accountId: "other", sourceId: "other-mail" })]);
    vault.put("accounts", "other", { ...account, id: "other" });
    vault.put("sources", "other-mail", { ...source, id: "other-mail", accountId: "other" });
    const generated = hooks(true);
    const service = new ProductivityService(vault as never, { ...generated, schedule: vi.fn() });
    service.review.start(1); await service.review.settled();
    const tasks = service.snapshot(snapshot(vault)).tasks;
    await service.command({ type: "task.edit", taskId: tasks[0].id, notes: "An edited suggestion" }, snapshot(vault));
    generated.generate.mockImplementation(async (_prompt, citations) => {
      vault.put("accounts", "other", { ...account, id: "other", aiEnabled: false });
      return { answer: "Must not retain this narrative", citationIds: citations.map(citation => citation.id) };
    });
    await service.command({ type: "report.generate" }, snapshot(vault));
    expect(service.snapshot(snapshot(vault)).focusReport?.narrative).toBeUndefined();
    service.forgetAccount("other");
    expect(vault.all("actions")).toEqual([]);
    expect(vault.all("tasks")).toEqual([]);
    expect(service.review.coverage().reports).toEqual([]);
  });

  it("rechecks lifecycle controls between batches without mislabelling saved evidence as failed", async () => {
    const vault = seed(Array.from({ length: 8 }, (_, index) => message(index)));
    const generated = hooks();
    let checks = 0;
    const review = new ArchiveAiReview(vault, { ...generated, canReview: () => {
      if (++checks === 4) throw new Error("Automation is paused.");
    } });
    review.start(5); await review.settled();
    expect(generated.generate).toHaveBeenCalledTimes(1);
    expect(review.coverage()).toMatchObject({ status: "paused", reviewed: 4, remaining: 4, failedMessages: 0 });
    expect(review.coverage().detail).toContain("Automation is paused");
  });
});

describe("professional priority (Finco first, then AI4Innov)", () => {
  const recent = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const finco: Account = { ...account, id: "finco", email: "gilles@finco.digital" };
  const ai4: Account = { ...account, id: "ai4", email: "gilles@ai4innov.tech" };
  const personal: Account = { ...account, id: "personal", email: "me@gmail.com" };
  function prioritySeed(messages: Message[]): MemoryVault {
    const vault = seed(messages);
    for (const item of [finco, ai4, personal]) {
      vault.put("accounts", item.id, item);
      vault.put("sources", `${item.id}:mail`, { ...source, id: `${item.id}:mail`, accountId: item.id });
    }
    return vault;
  }
  const at = (id: string, owner: Account, days: number, overrides: Partial<Message> = {}) =>
    message(0, { id, accountId: owner.id, sourceId: `${owner.id}:mail`, recipients: [owner.email], receivedAt: recent(days), historical: false, ...overrides });

  it("ranks configured organizations, then professional, personal and bulk mail", () => {
    const domains = DEFAULT_PRIORITY_DOMAINS;
    const base = { recipients: [], body: "Can you confirm the offer?" };
    expect(messagePriority({ ...base, sender: "CERGI <m@cergi.bj>" }, "gilles@finco.digital", domains)).toMatchObject({ tier: "priority", rank: 0 });
    expect(messagePriority({ ...base, sender: "x@partner.org" }, "gilles@ai4innov.tech", domains)).toMatchObject({ tier: "priority", rank: 1 });
    expect(messagePriority({ ...base, sender: "Kezia <k@finco.digital>" }, "me@gmail.com", domains)).toMatchObject({ tier: "priority", rank: 0 });
    expect(messagePriority({ ...base, sender: "a@client.com" }, "me@gmail.com", domains).tier).toBe("professional");
    expect(messagePriority({ ...base, sender: "friend@yahoo.fr" }, "me@gmail.com", domains).tier).toBe("personal");
    expect(messagePriority({ ...base, sender: "Medium <noreply@medium.com>" }, "me@gmail.com", domains).tier).toBe("bulk");
    expect(messagePriority({ ...base, sender: "a@shop.com", body: "Big sale today! Unsubscribe here." }, "gilles@finco.digital", domains).tier).toBe("bulk");
    const score = (sender: string, email: string) => messagePriority({ ...base, sender }, email, domains).boost;
    expect(score("a@x.bj", "gilles@finco.digital")).toBeGreaterThan(score("a@x.bj", "gilles@ai4innov.tech"));
    expect(score("a@x.bj", "gilles@ai4innov.tech")).toBeGreaterThan(score("a@client.com", "me@gmail.com"));
    expect(score("a@client.com", "me@gmail.com")).toBeGreaterThan(score("f@gmail.com", "me@gmail.com"));
    expect(score("f@gmail.com", "me@gmail.com")).toBeGreaterThan(score("noreply@x.com", "me@gmail.com"));
    expect(normalizePriorityDomains([" @Finco.Digital ", "https://ai4innov.tech/x", "bad", "finco.digital"])).toEqual(["finco.digital", "ai4innov.tech"]);
  });

  it("automatically reviews recent mail priority-first, skipping newsletters and old mail", async () => {
    const vault = prioritySeed([
      at("personal-new", personal, 0.1, { sender: "friend@gmail.com" }),
      at("ai4-mid", ai4, 1, { sender: "partner@lab.org" }),
      at("finco-old", finco, 3, { sender: "m@cergi.bj" }),
      at("newsletter", finco, 0.05, { sender: "Substack <noreply@substack.com>" }),
      at("archive", finco, 60, { sender: "m@cergi.bj" })
    ]);
    const generated = hooks();
    const review = new ArchiveAiReview(vault, generated);
    const since = recent(14);
    expect(review.recentPending(since)).toBe(3);
    review.start(1, { since }); await review.settled();
    const [prompt, citations] = generated.generate.mock.calls[0];
    expect(citations.map(citation => citation.messageId)).toEqual(["finco-old", "ai4-mid", "personal-new"]);
    expect(citations[0].location).toContain("context=finco.digital (priority 1)");
    expect(prompt).toContain("Professional work comes first");
    expect(review.recentPending(since)).toBe(0);
    expect(review.coverage().detail).toMatch(/automatic/i);
  });

  it("hides keyword-rule tasks for newsletters and AI-reviewed mail and ranks Finco work first", async () => {
    const vault = prioritySeed([
      at("finco-ask", finco, 1, { sender: "m@cergi.bj" }),
      at("personal-ask", personal, 1, { sender: "friend@gmail.com" }),
      at("promo", personal, 1, { sender: "Deals <news@shop.com>", body: "Can you believe it? Sale today. Unsubscribe" })
    ]);
    const rule = (id: string, owner: Account, priority: ActionItem["priority"]): ActionItem => ({
      id: `action:${id}`, messageId: id, accountId: owner.id, title: id, reason: "Local rule", priority, status: "open", confidence: 0.5,
      citations: [{ id, messageId: id, title: id, excerpt: "Please review" }]
    });
    for (const action of [rule("finco-ask", finco, "normal"), rule("personal-ask", personal, "urgent"), rule("promo", personal, "urgent")])
      vault.put("actions", action.id, action);
    const service = new ProductivityService(vault as never, { ...hooks(), schedule: vi.fn() });
    const tasks = service.snapshot(snapshot(vault)).tasks;
    expect(tasks.map(task => task.sourceMessageId)).toEqual(["finco-ask", "personal-ask"]);
    expect(tasks[0]).toMatchObject({ context: "finco.digital (priority 1)", contextTier: "priority", focusRank: 1 });

    const generated = hooks();
    const review = new ArchiveAiReview(vault, generated);
    review.start(1); await review.settled();
    expect(service.snapshot(snapshot(vault)).tasks).toEqual([]);
  });
});
