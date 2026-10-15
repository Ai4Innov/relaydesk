import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account, ActionItem, CalendarEvent, Citation, Collection, EventChange, Message, Settings, Snapshot, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { commandSchema } from "../src/main/ipc/schema";
import { ProductivityService } from "../src/main/productivity";
import { Productivity } from "../src/renderer/Productivity";
import type { FocusReport, TaskItem } from "../src/shared/productivity";

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
  delete(collection: Collection, id: string): void {
    this.records.get(collection)?.delete(id);
  }
}

const account: Account = { id: "account", provider: "gmail", name: "Work", email: "me@example.com", status: "connected", consent: true, aiEnabled: true };
const calendarSource: Source = { id: "calendar", accountId: account.id, providerId: "cal", name: "Primary calendar", kind: "calendar", selected: false };
const mailSource: Source = { id: "mail", accountId: account.id, providerId: "inbox", name: "Inbox", kind: "mail", selected: true };
const browserAccount: Account = { id: "browser-account", provider: "gmail", name: "Browser", email: "me@example.com", status: "connected", consent: true, aiEnabled: false, connection: "browser" };
const browserSource: Source = { id: "browser-mail", accountId: browserAccount.id, providerId: "browser", name: "Browser inbox", kind: "mail", selected: true };
const browserMessage: Message = {
  id: "browser-message",
  accountId: browserAccount.id,
  sourceId: browserSource.id,
  providerId: "bm",
  threadId: "bt",
  subject: "Undated browser request",
  sender: "sender@example.com",
  recipients: [],
  body: "Can you review this soon?",
  receivedAt: "",
  url: "https://mail.google.com",
  unread: true,
  revision: "r1",
  historical: true,
  browser: { completeness: "preview", capturedAt: "2026-09-18T10:00:00Z", dateText: "Yesterday" }
};
const exactMessage: Message = {
  id: "message",
  accountId: account.id,
  sourceId: mailSource.id,
  providerId: "m",
  threadId: "t",
  subject: "Quarterly review",
  sender: "lead@example.com",
  recipients: ["me@example.com"],
  body: "Please finish the review before tomorrow morning.",
  receivedAt: "2026-09-22T09:00:00Z",
  url: "https://mail.google.com",
  unread: true,
  revision: "r2",
  historical: false
};
const citation: Citation = { id: "cite-1", messageId: exactMessage.id, title: exactMessage.subject, excerpt: "Please finish the review before tomorrow morning." };
const browserCitation: Citation = { id: "cite-2", messageId: browserMessage.id, title: browserMessage.subject, excerpt: "Can you review this soon?" };
const action: ActionItem = {
  id: "action-1",
  messageId: exactMessage.id,
  accountId: account.id,
  title: "Finish the quarterly review",
  reason: "Email asks for review before tomorrow morning.",
  priority: "urgent",
  status: "open",
  dueAt: "2026-09-23",
  confidence: 0.9,
  citations: [citation]
};
const browserAction: ActionItem = {
  id: "action-2",
  messageId: browserMessage.id,
  accountId: browserAccount.id,
  title: "Check the browser-only request",
  reason: "Browser capture lacks an exact received date; confirm it is still current.",
  priority: "normal",
  status: "open",
  confidence: 0.5,
  citations: [browserCitation]
};
const event: CalendarEvent = {
  id: "event-1",
  accountId: account.id,
  sourceId: "selected-calendar",
  providerId: "provider-event-1",
  title: "Customer sync",
  start: "2026-09-23T08:00:00Z",
  end: "2026-09-23T08:30:00Z",
  timeZone: "UTC",
  allDay: false,
  attendees: [],
  location: "Zoom",
  description: "",
  revision: "event-r1",
  url: "https://calendar.google.com",
  reminderMinutes: 15
};
const otherAccount: Account = { id: "other-account", provider: "microsoft", name: "Other", email: "other@example.com", status: "connected", consent: true, aiEnabled: true };
const otherCalendar: Source = { id: "other-calendar", accountId: otherAccount.id, providerId: "other-cal", name: "Other calendar", kind: "calendar", selected: true };

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const settings: Settings = { ...defaultSettings, aiUsageDate: "2026-09-22", model: "test-model" };
  return {
    accounts: [account, browserAccount],
    sources: [mailSource, calendarSource, { ...calendarSource, id: "selected-calendar", name: "Selected calendar", selected: true }, browserSource],
    messages: [exactMessage, browserMessage],
    drafts: [],
    attachments: [],
    events: [event],
    actions: [action, browserAction],
    jobs: [],
    approvals: [],
    settings,
    models: [],
    copilot: { status: "ready", message: "ready" },
    archive: { messages: 2, attachments: 0, indexed: 2, searchMode: "keyword", bytes: 0 },
    demo: false,
    browser: { paired: true, running: true, port: 43891 },
    browserItems: [],
    ...overrides
  };
}

function seedVault(vault: MemoryVault, current: Snapshot): void {
  for (const item of current.accounts) vault.put("accounts", item.id, item);
  for (const item of current.sources) vault.put("sources", item.id, item);
  for (const item of current.messages) vault.put("messages", item.id, item);
}

describe("productivity schemas and service", () => {
  it("validates scheduling defaults and rejects attendees", () => {
    const parsed = commandSchema.parse({
      type: "task.schedule",
      taskId: "task:1",
      confirmed: true,
      change: {
        accountId: "account",
        sourceId: "calendar",
        title: "Focus block",
        start: "2026-09-23T09:00:00Z",
        end: "2026-09-23T10:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: [],
        location: "",
        description: ""
      }
    }) as { type: "task.schedule"; taskId: string; confirmed: true; change: EventChange };
    expect(parsed.change.reminderMinutes).toBe(15);
    expect(commandSchema.safeParse({
      type: "task.schedule",
      taskId: "task:1",
      confirmed: true,
      change: {
        accountId: "account",
        sourceId: "calendar",
        title: "Focus block",
        start: "2026-09-23T09:00:00Z",
        end: "2026-09-23T10:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: ["other@example.com"],
        location: "",
        description: ""
      }
    }).success).toBe(false);
  });

  it("derives editable tasks, preserves local edits, filters excluded sources, and produces a live report", async () => {
    const vault = new MemoryVault();
    const hooks = { changed: vi.fn(), generate: vi.fn(), schedule: vi.fn() };
    const service = new ProductivityService(vault as never, hooks);

    let current = snapshot();
    let initial = service.snapshot(current);
    expect(initial.tasks.map(task => task.title)).toContain("Finish the quarterly review");
    expect(initial.tasks.map(task => task.title)).toContain("Check the browser-only request");
    expect(initial.focusReport?.metrics.partialBrowserTasks).toBe(1);
    expect(initial.focusReport?.metrics.staleBrowserTasks).toBe(1);

    await service.command({
      type: "task.edit",
      taskId: "task:action-1",
      title: "Finish the reviewed quarterly summary",
      notes: "Block thirty focused minutes before the meeting.",
      priority: "high",
      dueAt: "2026-09-24"
    }, current);

    await service.command({
      type: "task.create",
      title: "Manual offline task",
      notes: "Capture follow-up ideas.",
      priority: "low",
      status: "open"
    }, current);

    initial = service.snapshot(current);
    const edited = initial.tasks.find(task => task.id === "task:action-1");
    expect(edited?.title).toBe("Finish the reviewed quarterly summary");
    expect(edited?.notes).toContain("thirty focused minutes");
    expect(initial.tasks.some(task => task.origin === "manual" && task.title === "Manual offline task")).toBe(true);

    current = snapshot({ sources: current.sources.map(source => source.id === browserSource.id ? { ...source, selected: false } : source) });
    const filtered = service.snapshot(current);
    expect(filtered.tasks.map(task => task.title)).not.toContain("Check the browser-only request");
    expect(filtered.focusReport?.warnings.join(" ")).not.toContain("browser preview");
  });

  it("persists safe scheduling state, marks edited tasks out of date, and blocks ambiguous retries", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(),
      schedule: vi.fn(async (change: EventChange) => ({ eventId: change.eventId ?? "scheduled-event" }))
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();

    await service.command({
      type: "task.schedule",
      taskId: "task:action-1",
      confirmed: true,
      change: {
        accountId: account.id,
        sourceId: calendarSource.id,
        title: "Review focus block",
        start: "2026-09-23T09:00:00Z",
        end: "2026-09-23T10:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: [],
        location: "",
        description: "Deep work",
        reminderMinutes: 30
      }
    }, current);

    let scheduled = service.snapshot(current).tasks.find(task => task.id === "task:action-1");
    expect(scheduled?.schedule?.state).toBe("scheduled");
    expect(scheduled?.schedule?.eventId).toBe("scheduled-event");

    await service.command({ type: "task.edit", taskId: "task:action-1", notes: "Updated summary and prep bullets." }, current);
    scheduled = service.snapshot(current).tasks.find(task => task.id === "task:action-1");
    expect(scheduled?.schedule?.state).toBe("out_of_date");

    hooks.schedule.mockRejectedValueOnce(new Error("Provider timeout"));
    await expect(service.command({
      type: "task.schedule",
      taskId: "task:action-1",
      confirmed: true,
      change: {
        accountId: account.id,
        sourceId: calendarSource.id,
        title: "Review focus block",
        start: "2026-09-24T09:00:00Z",
        end: "2026-09-24T10:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: [],
        location: "",
        description: "Retry",
        reminderMinutes: 15
      }
    }, current)).rejects.toThrow("Provider timeout");
    scheduled = service.snapshot(current).tasks.find(task => task.id === "task:action-1");
    expect(scheduled?.schedule?.state).toBe("uncertain");
    await expect(service.command({
      type: "task.schedule",
      taskId: "task:action-1",
      confirmed: true,
      change: {
        accountId: account.id,
        sourceId: calendarSource.id,
        title: "Retry again",
        start: "2026-09-24T11:00:00Z",
        end: "2026-09-24T12:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: [],
        location: "",
        description: "",
        reminderMinutes: 15
      }
    }, current)).rejects.toThrow("Inspect the calendar");
  });

  it("generates a narrative only from currently permitted AI citations", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(async (_prompt: string, citations: Citation[]) => ({
        answer: "Focus first on the urgent review request, then confirm the browser-only item is still current.",
        citationIds: citations.map(item => item.id)
      })),
      schedule: vi.fn()
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();
    seedVault(vault, current);

    const result = await service.command({ type: "report.generate", prompt: "Call out blockers." }, current);
    expect(result.reportId).toBeTruthy();
    const report = service.snapshot(current).focusReport as FocusReport;
    expect(report.narrative).toContain("Focus first");
    expect(report.citations.map(item => item.id)).toEqual(["cite-1"]);
    expect(hooks.generate).toHaveBeenCalledWith(expect.stringContaining("overdue"), [citation]);
  });

  it("forgets derived account-linked content while preserving unrelated manual tasks", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(async () => ({ answer: "Focus on the urgent review.", citationIds: [citation.id] })),
      schedule: vi.fn()
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();
    seedVault(vault, current);

    await service.command({ type: "task.create", title: "Manual offline task", notes: "Keep this.", priority: "low" }, current);
    await service.command({ type: "report.generate", prompt: "Summarize priorities." }, current);
    const before = service.snapshot(current);
    expect(before.tasks.some(task => task.origin === "action")).toBe(true);
    expect(before.tasks.some(task => task.origin === "manual")).toBe(true);
    expect(before.focusReport?.narrative).toContain("urgent review");

    service.forgetAccount(account.id);
    const after = service.snapshot(snapshot({
      accounts: [browserAccount],
      sources: [browserSource],
      messages: [browserMessage],
      actions: [browserAction],
      events: []
    }));

    expect(after.tasks.some(task => task.title === "Manual offline task")).toBe(true);
    expect(after.tasks.some(task => task.sourceAccountId === account.id)).toBe(false);
    expect(vault.all<{ id: string }>("reports")).toHaveLength(0);
  });

  it("filters transmitted report scope to permitted evidence only", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(async (_prompt: string, _citations: Citation[]) => ({ answer: "Focus on the urgent review only.", citationIds: [citation.id] })),
      schedule: vi.fn()
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();
    seedVault(vault, current);
    await service.command({ type: "task.create", title: "Manual secret task", notes: "Do not transmit.", priority: "low" }, current);

    await service.command({ type: "report.generate", prompt: "Summarize priorities." }, current);

    const prompt = hooks.generate.mock.calls[0]?.[0];
    expect(prompt).toContain("total=1");
    expect(prompt).toContain("Finish the quarterly review");
    expect(prompt).not.toContain("Check the browser-only request");
    expect(prompt).not.toContain("Manual secret task");
    expect(prompt).not.toContain("upcomingMeetings=");
  });

  it("retains every input source in report scope even when the model cites only one", async () => {
    const vault = new MemoryVault();
    const service = new ProductivityService(vault as never, {
      changed: vi.fn(), schedule: vi.fn(),
      generate: vi.fn(async () => ({ answer: "Combined context narrative", citationIds: [citation.id] }))
    });
    const current = snapshot({ accounts: [account, { ...browserAccount, aiEnabled: true }] });
    seedVault(vault, current);
    await service.command({ type: "report.generate" }, current);
    expect(service.snapshot(current).focusReport?.narrative).toBe("Combined context narrative");
    const excluded = { ...current, sources: current.sources.map(source => source.id === browserSource.id ? { ...source, selected: false } : source) };
    expect(service.snapshot(excluded).focusReport?.narrative).toBeUndefined();
    service.forgetAccount(browserAccount.id);
    expect(vault.all("reports")).toHaveLength(0);
  });

  it("uses authoritative vault eligibility after async report generation", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(async () => ({ answer: "Focus on the urgent review only.", citationIds: [citation.id] })),
      schedule: vi.fn()
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();

    await service.command({ type: "report.generate", prompt: "Summarize priorities." }, current);

    const report = service.snapshot(current).focusReport as FocusReport;
    expect(report.narrative).toBeUndefined();
    expect(report.citations).toEqual([]);
  });

  it("hides stored narrative when any previously used source loses AI eligibility", async () => {
    const vault = new MemoryVault();
    const hooks = {
      changed: vi.fn(),
      generate: vi.fn(async () => ({ answer: "Focus on the urgent review only.", citationIds: [citation.id] })),
      schedule: vi.fn()
    };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();
    seedVault(vault, current);

    await service.command({ type: "report.generate", prompt: "Summarize priorities." }, current);

    const aiRevoked = snapshot({
      accounts: [{ ...account, aiEnabled: false }, browserAccount]
    });
    const hidden = service.snapshot(aiRevoked).focusReport as FocusReport;
    expect(hidden.narrative).toBeUndefined();
    expect(hidden.citations).toEqual([]);
  });

  it("hides stored derived tasks when the underlying message is deleted", async () => {
    const vault = new MemoryVault();
    const hooks = { changed: vi.fn(), generate: vi.fn(), schedule: vi.fn() };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot();

    await service.command({ type: "task.edit", taskId: "task:action-1", notes: "Persist this task." }, current);
    const deleted = snapshot({
      messages: [{ ...exactMessage, deleted: true }, browserMessage],
      actions: [browserAction]
    });

    expect(service.snapshot(deleted).tasks.map(task => task.id)).not.toContain("task:action-1");
  });

  it("rejects scheduling when the chosen calendar source belongs to another account", async () => {
    const vault = new MemoryVault();
    const hooks = { changed: vi.fn(), generate: vi.fn(), schedule: vi.fn() };
    const service = new ProductivityService(vault as never, hooks);
    const current = snapshot({
      accounts: [account, browserAccount, otherAccount],
      sources: [...snapshot().sources, otherCalendar]
    });

    await expect(service.command({
      type: "task.schedule",
      taskId: "task:action-1",
      confirmed: true,
      change: {
        accountId: account.id,
        sourceId: otherCalendar.id,
        title: "Invalid",
        start: "2026-09-23T09:00:00Z",
        end: "2026-09-23T10:00:00Z",
        timeZone: "UTC",
        allDay: false,
        attendees: [],
        location: "",
        description: ""
      }
    }, current)).rejects.toThrow("belongs to the selected connected account");
  });
});

describe("productivity renderer", () => {
  it("renders task management, scheduling, and focus report sections", () => {
    const tasks: TaskItem[] = [{
      id: "task:action-1",
      origin: "action",
      title: "Finish the quarterly review",
      notes: "Prepare your notes.",
      status: "open",
      priority: "urgent",
      dueAt: "2026-09-23",
      createdAt: "2026-09-22T09:00:00Z",
      updatedAt: "2026-09-22T09:00:00Z",
      sourceActionId: action.id,
      sourceMessageId: exactMessage.id,
      sourceAccountId: account.id,
      sourceSourceId: mailSource.id,
      sourceReason: action.reason,
      citations: [citation],
      schedule: {
        state: "scheduled",
        operationId: "op-1",
        eventId: "scheduled-event",
        change: {
          accountId: account.id,
          sourceId: calendarSource.id,
          title: "Review focus block",
          start: "2026-09-23T09:00:00Z",
          end: "2026-09-23T10:00:00Z",
          timeZone: "UTC",
          allDay: false,
          attendees: [],
          location: "",
          description: "Deep work",
          reminderMinutes: 15
        },
        reminderMinutes: 15,
        isPrivate: true,
        noAttendees: true,
        confirmedAt: "2026-09-22T09:05:00Z",
        lastAttemptAt: "2026-09-22T09:05:00Z",
        scheduledAt: "2026-09-22T09:05:30Z",
        note: "Scheduled on your selected calendar."
      },
      focusRank: 1
    }];
    const focusReport: FocusReport = {
      id: "focus:1",
      generatedAt: "2026-09-22T09:10:00Z",
      snapshotAt: "2026-09-22T09:10:00Z",
      prompt: "Call out blockers.",
      narrative: "Handle the urgent review request first.",
      citations: [citation],
      citationIds: [citation.id],
      sourceIds: [mailSource.id],
      accountIds: [account.id],
      metrics: {
        totalTasks: 1,
        openTasks: 1,
        inProgressTasks: 0,
        waitingTasks: 0,
        completedTasks: 0,
        overdueTasks: 0,
        dueSoonTasks: 1,
        urgentTasks: 1,
        scheduledTasks: 1,
        outOfDateSchedules: 0,
        manualTasks: 0,
        actionBackedTasks: 1,
        staleBrowserTasks: 0,
        partialBrowserTasks: 0,
        upcomingMeetings: 1,
        workloadScore: 6,
        workloadLabel: "steady"
      },
      coverage: {
        includedAccountIds: [account.id],
        includedSourceIds: [mailSource.id, "selected-calendar"],
        connectedAccounts: 2,
        selectedMailSources: 2,
        selectedCalendarSources: 1,
        aiEligibleCitationCount: 1,
        exactDueDateTasks: 1,
        impreciseBrowserTasks: 0,
        dueSoonWindowHours: 72,
        meetingWindowHours: 72
      },
      rankedTasks: tasks,
      nextActions: [{ taskId: tasks[0].id, title: tasks[0].title, reason: "This item is due within 72 hours.", priority: "urgent", dueAt: "2026-09-23", sourceMessageId: exactMessage.id }],
      upcomingMeetings: [{
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        timeZone: event.timeZone,
        accountId: event.accountId,
        sourceId: event.sourceId,
        allDay: event.allDay,
        location: event.location,
        url: event.url
      }],
      warnings: []
    };

    const html = renderToStaticMarkup(createElement(Productivity, {
      data: { ...snapshot(), tasks, focusReport },
      busy: false,
      run: async () => undefined
    }));

    expect(html).toContain("Tasks, focus, and scheduling");
    expect(html).toContain("Schedule");
    expect(html).toContain("Generate focus report");
    expect(html).toContain("Focus report");
    expect(html).toContain("Prioritized next actions");
  });
});
