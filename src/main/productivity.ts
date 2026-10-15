import { randomUUID } from "node:crypto";
import type { Account, ActionItem, Attachment, CalendarEvent, Citation, EventChange, Message, Snapshot, Source } from "../shared/contracts";
import { mailOriginAllowed } from "../shared/mail-transport";
import {
  DEFAULT_TASK_REMINDER_MINUTES,
  PRODUCTIVITY_BROWSER_STALE_HOURS,
  PRODUCTIVITY_DUE_SOON_HOURS,
  PRODUCTIVITY_MEETING_WINDOW_HOURS,
  TASK_NOTES_MAX,
  TASK_TITLE_MAX,
  type FocusReport,
  type AiReviewCoverage,
  type FocusReportMeeting,
  type FocusReportNextAction,
  type ProductivityCommand,
  type TaskItem,
  type TaskPriority,
  type TaskSchedule,
  type TaskStatus
} from "../shared/productivity";
import { validateChange as validateCalendarChange } from "./connectors/calendar";
import type { Vault } from "./storage/vault";
import { ArchiveAiReview } from "./ai-review";

interface ProductivityHooks {
  changed(): void;
  canReview?(): void;
  generate(prompt: string, citations: Citation[]): Promise<{ answer: string; citationIds: string[] }>;
  schedule(change: EventChange, beforeWrite?: () => void): Promise<{ eventId: string }>;
}

interface StoredTaskRecord extends Omit<TaskItem, "focusRank"> {
  custom?: {
    title?: boolean;
    notes?: boolean;
    priority?: boolean;
    dueAt?: boolean;
  };
}

interface StoredReportRecord {
  id: string;
  generatedAt: string;
  prompt?: string;
  narrative?: string;
  citationIds: string[];
  inputCitationIds?: string[];
  sourceIds: string[];
  accountIds: string[];
  taskIds: string[];
  mailOrigins?: Pick<Message, "accountId" | "gmailApi">[];
}

const now = () => new Date().toISOString();
const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const taskIdForAction = (actionId: string) => `task:${actionId}`;
const dueAtDate = /^\d{4}-\d{2}-\d{2}$/;
const dueAtDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function trimText(value: string | undefined, max: number): string {
  return (value || "").trim().slice(0, max);
}
function normalizeNotes(value: string | undefined): string {
  return (value || "").trim().slice(0, TASK_NOTES_MAX);
}
function normalizeDueAt(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const valid = (dueAtDate.test(trimmed) || dueAtDateTime.test(trimmed))
    && Number.isFinite(Date.parse(dueAtDate.test(trimmed) ? `${trimmed}T12:00:00` : trimmed));
  if (!valid) throw new Error("Use YYYY-MM-DD or an ISO date-time with a UTC offset for task due dates.");
  return trimmed;
}
function mapActionPriority(priority: ActionItem["priority"]): TaskPriority {
  return priority === "urgent" ? "urgent" : priority === "important" ? "high" : "medium";
}
function mapActionStatus(status: ActionItem["status"]): TaskStatus {
  if (status === "done") return "done";
  if (status === "waiting" || status === "snoozed") return "waiting";
  return "open";
}
function sortUnique(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => !!value))].sort((left, right) => left.localeCompare(right));
}
function scheduleAffectsCalendar(state: TaskSchedule["state"] | undefined): boolean {
  return state === "scheduled" || state === "out_of_date";
}
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "The operation failed.").slice(0, 1_500);
}
interface ReportPromptScope {
  tasks: TaskItem[];
  metrics: Pick<FocusReport["metrics"], "totalTasks" | "openTasks" | "inProgressTasks" | "waitingTasks" | "overdueTasks" | "dueSoonTasks" | "urgentTasks" | "staleBrowserTasks" | "partialBrowserTasks" | "workloadScore" | "workloadLabel">;
}

export class ProductivityService {
  readonly review: ArchiveAiReview;
  constructor(readonly vault: Vault, private readonly hooks: ProductivityHooks) {
    this.review = new ArchiveAiReview(vault, hooks);
  }

  private archiveSource(source: Snapshot): Snapshot {
    const messages = new Map(source.messages.map(message => [message.id, message]));
    for (const message of this.vault.all<Message>("messages"))
      if (!messages.has(message.id)) messages.set(message.id, message);
    const visible = { ...source, messages: [...messages.values()].filter(message => mailOriginAllowed(this.vault, message)) };
    return { ...visible, actions: source.actions.filter(action => this.review.actionVisible(action) && this.actionVisible(action, visible)) };
  }

  snapshot(source: Snapshot): { tasks: TaskItem[]; focusReport?: FocusReport; aiReview: AiReviewCoverage; actions: ActionItem[] } {
    source = this.archiveSource(source);
    const tasks = this.materializeTasks(source);
    const aiReview = this.review.coverage();
    const focusReport = this.buildFocusReport(source, tasks, this.latestReportRecord());
    if (aiReview.remaining) focusReport.warnings.push(`Archive AI review is partial: ${aiReview.reviewed} of ${aiReview.totalEligible} eligible emails reviewed; ${aiReview.remaining} remaining.`);
    const taskByAction = new Map(tasks.filter(task => task.sourceActionId).map(task => [task.sourceActionId, task]));
    const actions = source.actions.map(action => {
      const task = taskByAction.get(action.id);
      if (!task) return action;
      return {
        ...action, title: task.title, dueAt: task.dueAt,
        priority: task.priority === "urgent" ? "urgent" : task.priority === "high" ? "important" : "normal",
        status: task.status === "done" ? "done" : task.status === "waiting"
          ? action.status === "snoozed" ? "snoozed" : "waiting" : "open"
      } satisfies ActionItem;
    });
    return { tasks, focusReport, aiReview, actions };
  }

  pauseReview(): void { this.review.interrupt(); }

  syncActionStatus(action: ActionItem, waitingOnly = false): void {
    for (const task of this.vault.all<StoredTaskRecord>("tasks")) {
      if (task.sourceActionId !== action.id || (waitingOnly && task.status !== "waiting")) continue;
      const status = mapActionStatus(action.status);
      if (task.status === status) continue;
      this.vault.put("tasks", task.id, {
        ...task, status, updatedAt: now(), completedAt: status === "done" ? task.completedAt ?? now() : undefined
      } satisfies StoredTaskRecord);
    }
  }

  forgetAccount(accountId: string): void {
    const removedReviewActions = this.review.forgetAccount(accountId);
    const removedTaskIds = new Set([...removedReviewActions].map(taskIdForAction));
    for (const record of this.vault.all<StoredTaskRecord>("tasks")) {
      if (record.origin === "action" && (record.sourceAccountId === accountId || (record.sourceActionId && removedReviewActions.has(record.sourceActionId)))) {
        this.vault.delete?.("tasks", record.id);
        removedTaskIds.add(record.id);
        continue;
      }
      if (record.schedule?.change.accountId !== accountId) continue;
      const next: StoredTaskRecord = {
        ...record,
        updatedAt: now(),
        schedule: undefined
      };
      this.vault.put("tasks", record.id, next);
    }
    for (const report of this.vault.all<StoredReportRecord>("reports")) {
      if (report.accountIds.includes(accountId) || report.mailOrigins?.some(origin => origin.gmailApi?.accountId === accountId)
        || report.taskIds.some(taskId => removedTaskIds.has(taskId)))
        this.vault.delete?.("reports", report.id);
    }
    this.hooks.changed();
  }

  async command(command: ProductivityCommand, source: Snapshot, beforeWrite?: () => void): Promise<{ message?: string; taskId?: string; reportId?: string }> {
    source = this.archiveSource(source);
    switch (command.type) {
      case "review.start":
        this.review.start(command.maxBatches);
        return { message: "Archive review started. Batches run sequentially within the selected limit and existing AI budget; coverage is saved after each batch." };
      case "review.pause":
        this.review.pause();
        return { message: "Archive review paused. Saved progress is retained; any in-flight result will be discarded." };
      case "review.cancel":
        this.review.pause(true);
        return { message: "Archive review cancelled. Existing tasks and completed coverage are retained." };
      case "task.create": {
        const record: StoredTaskRecord = {
          id: `task:${randomUUID()}`,
          origin: "manual",
          title: trimText(command.title, TASK_TITLE_MAX),
          notes: normalizeNotes(command.notes),
          status: command.status ?? "open",
          priority: command.priority ?? "medium",
          dueAt: normalizeDueAt(command.dueAt),
          createdAt: now(),
          updatedAt: now(),
          completedAt: command.status === "done" ? now() : undefined,
          citations: []
        };
        this.vault.put("tasks", record.id, record);
        this.hooks.changed();
        return { taskId: record.id, message: "Task created locally." };
      }
      case "task.edit": {
        const stored = this.storedRecordForCommand(command.taskId, source);
        const next: StoredTaskRecord = {
          ...stored,
          updatedAt: now(),
          title: command.title !== undefined ? trimText(command.title, TASK_TITLE_MAX) : stored.title,
          notes: command.notes !== undefined ? normalizeNotes(command.notes) : stored.notes,
          priority: command.priority ?? stored.priority,
          dueAt: command.dueAt !== undefined ? normalizeDueAt(command.dueAt) : stored.dueAt,
          status: command.status ?? stored.status
        };
        if (!next.title) throw new Error("Task title is required.");
        if (next.status === "done" && stored.status !== "done") next.completedAt = now();
        if (next.status !== "done") next.completedAt = undefined;
        if (stored.origin === "action") {
          next.custom = {
            ...stored.custom,
            ...(command.title !== undefined ? { title: true } : {}),
            ...(command.notes !== undefined ? { notes: true } : {}),
            ...(command.priority !== undefined ? { priority: true } : {}),
            ...(command.dueAt !== undefined ? { dueAt: true } : {})
          };
        }
        const calendarRelevantChange = stored.title !== next.title || stored.notes !== next.notes || stored.priority !== next.priority || stored.dueAt !== next.dueAt;
        if (calendarRelevantChange && scheduleAffectsCalendar(stored.schedule?.state)) {
          next.schedule = {
            ...stored.schedule!,
            state: "out_of_date",
            note: "This task changed locally after it was scheduled. Review the event details and reschedule explicitly."
          };
        }
        this.vault.put("tasks", next.id, next);
        this.hooks.changed();
        return { taskId: next.id, message: next.schedule?.state === "out_of_date" ? "Task updated. Calendar details now need explicit rescheduling." : "Task updated." };
      }
      case "task.status": {
        const stored = this.storedRecordForCommand(command.taskId, source);
        const next: StoredTaskRecord = {
          ...stored,
          status: command.status,
          updatedAt: now(),
          completedAt: command.status === "done" ? stored.completedAt ?? now() : undefined
        };
        this.vault.put("tasks", next.id, next);
        this.hooks.changed();
        return { taskId: next.id, message: command.status === "done" ? "Task marked done locally." : "Task status updated." };
      }
      case "task.schedule": {
        if (!command.confirmed) throw new Error("Calendar scheduling requires explicit confirmation.");
        const stored = this.storedRecordForCommand(command.taskId, source);
        if (stored.schedule?.state === "pending" || stored.schedule?.state === "uncertain")
          throw new Error("This task has a calendar write in progress or an uncertain result. Inspect the calendar before scheduling again.");
        const normalizedChange = this.normalizeScheduleChange(command.change, stored, source);
        const operationId = randomUUID();
        const pendingSchedule: TaskSchedule = {
          state: "pending",
          operationId,
          eventId: normalizedChange.eventId,
          change: normalizedChange,
          reminderMinutes: normalizedChange.reminderMinutes ?? DEFAULT_TASK_REMINDER_MINUTES,
          isPrivate: true,
          noAttendees: true,
          confirmedAt: now(),
          lastAttemptAt: now()
        };
        const pendingTask: StoredTaskRecord = { ...stored, updatedAt: now(), schedule: pendingSchedule };
        this.vault.put("tasks", pendingTask.id, pendingTask);
        this.hooks.changed();
        try {
          const result = await this.hooks.schedule(normalizedChange, beforeWrite);
          const scheduledTask: StoredTaskRecord = {
            ...pendingTask,
            updatedAt: now(),
            schedule: {
              ...pendingSchedule,
              state: "scheduled",
              eventId: result.eventId,
              scheduledAt: now(),
              note: "Scheduled on your selected calendar.",
              change: { ...pendingSchedule.change, eventId: result.eventId }
            }
          };
          this.vault.put("tasks", scheduledTask.id, scheduledTask);
          this.hooks.changed();
          return { taskId: scheduledTask.id, message: "Task scheduled on your calendar." };
        } catch (error) {
          this.vault.put("tasks", pendingTask.id, {
            ...pendingTask,
            updatedAt: now(),
            schedule: {
              ...pendingSchedule,
              state: "uncertain",
              note: "The calendar write may or may not have completed. Inspect the provider calendar before retrying."
            }
          } satisfies StoredTaskRecord);
          this.hooks.changed();
          throw error;
        }
      }
      case "report.generate": {
        const tasks = this.materializeTasks(source);
        const baseReport = this.buildFocusReport(source, tasks, this.latestReportRecord());
        const requestedCitations = this.selectReportCitations(tasks, source);
        const promptScope = this.reportPromptScope(tasks, source, requestedCitations);
        const reportId = `report:${randomUUID()}`;
        if (!requestedCitations.length) {
          const record: StoredReportRecord = {
            id: reportId,
            generatedAt: now(),
            prompt: trimText(command.prompt, 2_000) || undefined,
            narrative: undefined,
            citationIds: [],
            sourceIds: sortUnique(tasks.map(task => task.sourceSourceId)),
            accountIds: sortUnique(tasks.map(task => task.sourceAccountId)),
            taskIds: tasks.map(task => task.id)
          };
          this.vault.put("reports", record.id, record);
          this.hooks.changed();
          return {
            reportId: record.id,
            message: baseReport.metrics.totalTasks
              ? "Focus report updated with local metrics only. Enable AI on selected sources to add a narrative."
              : "No eligible email evidence is selected yet, so only the local focus summary is available."
          };
        }
        const prompt = this.reportPrompt(command.prompt, promptScope, requestedCitations);
        const mailOrigins = requestedCitations.flatMap(citation => {
          const message = source.messages.find(item => item.id === citation.messageId);
          if (!message) return [];
          const attachment = citation.attachmentId ? this.vault.get<Attachment>("attachments", citation.attachmentId) : undefined;
          return [message.gmailApi, attachment?.gmailApi].filter(origin => !!origin)
            .map(gmailApi => ({ accountId: message.accountId, gmailApi }));
        });
        const generated = await this.hooks.generate(prompt, requestedCitations);
        const scopeEligible = requestedCitations.every(citation => this.citationEligibleAfterAsync(citation, true))
          && mailOrigins.every(origin => mailOriginAllowed(this.vault, origin as Message, true));
        const permitted = scopeEligible ? requestedCitations.filter(citation => generated.citationIds.includes(citation.id)) : [];
        const permittedTaskIds = new Set(
          tasks.filter(task => task.citations.some(citation => permitted.some(permittedCitation => permittedCitation.id === citation.id))).map(task => task.id)
        );
        const record: StoredReportRecord = {
          id: reportId,
          generatedAt: now(),
          prompt: trimText(command.prompt, 2_000) || undefined,
          narrative: permitted.length ? generated.answer.trim() : undefined,
          citationIds: permitted.map(citation => citation.id),
          inputCitationIds: requestedCitations.map(citation => citation.id),
          sourceIds: sortUnique(requestedCitations.map(citation => source.messages.find(message => message.id === citation.messageId)?.sourceId)),
          accountIds: sortUnique(requestedCitations.map(citation => source.messages.find(message => message.id === citation.messageId)?.accountId)),
          taskIds: tasks.filter(task => permittedTaskIds.has(task.id)).map(task => task.id),
          mailOrigins
        };
        this.vault.put("reports", record.id, record);
        this.hooks.changed();
        return {
          reportId: record.id,
          message: permitted.length
            ? "Focus report generated with Copilot narrative and exact source citations."
            : "Focus report updated, but the eligible sources changed before the narrative could be retained."
        };
      }
    }
  }

  private latestReportRecord(): StoredReportRecord | undefined {
    return this.vault.all<StoredReportRecord>("reports").sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
  }

  private storedRecordForCommand(taskId: string, source: Snapshot): StoredTaskRecord {
    const task = this.materializeTasks(source).find(item => item.id === taskId);
    if (!task) throw new Error("Task not found.");
    const stored = this.vault.get<StoredTaskRecord>("tasks", taskId);
    return {
      ...task,
      custom: stored?.custom
    };
  }

  private materializeTasks(source: Snapshot): TaskItem[] {
    const storedRecords = this.vault.all<StoredTaskRecord>("tasks");
    const storedByAction = new Map<string, StoredTaskRecord>();
    const untouchedActionRecords = new Map<string, StoredTaskRecord>();
    const manualRecords = storedRecords.filter(record => record.origin === "manual");
    for (const record of storedRecords) {
      if (record.origin !== "action" || !record.sourceActionId) continue;
      storedByAction.set(record.sourceActionId, record);
      untouchedActionRecords.set(record.id, record);
    }

    const actionTasks: TaskItem[] = [];
    for (const action of source.actions) {
      if (!this.actionVisible(action, source)) continue;
      const merged = this.mergeActionTask(action, source, storedByAction.get(action.id));
      actionTasks.push(merged);
      untouchedActionRecords.delete(merged.id);
    }
    for (const record of untouchedActionRecords.values())
      if (this.recordVisible(record, source)) actionTasks.push(this.publicTask(record));

    const manualTasks = manualRecords.map(record => this.publicTask(record));
    return this.rankTasks([...manualTasks, ...actionTasks]);
  }

  private mergeActionTask(action: ActionItem, source: Snapshot, stored?: StoredTaskRecord): TaskItem {
    const message = source.messages.find(item => item.id === action.messageId);
    const createdAt = stored?.createdAt || message?.receivedAt || message?.browser?.capturedAt || now();
    const updatedAt = stored?.updatedAt || message?.receivedAt || message?.browser?.capturedAt || createdAt;
    const merged: StoredTaskRecord = {
      id: stored?.id || taskIdForAction(action.id),
      origin: "action",
      title: stored?.custom?.title ? stored.title : trimText(action.title, TASK_TITLE_MAX),
      notes: stored?.notes || "",
      status: stored?.status || mapActionStatus(action.status),
      priority: stored?.custom?.priority ? stored.priority : mapActionPriority(action.priority),
      dueAt: stored?.custom?.dueAt ? stored.dueAt : normalizeDueAt(action.dueAt),
      createdAt,
      updatedAt,
      completedAt: stored?.completedAt,
      sourceActionId: action.id,
      sourceMessageId: action.messageId,
      sourceAccountId: action.accountId,
      sourceSourceId: message?.sourceId || stored?.sourceSourceId,
      sourceReason: trimText(action.reason, TASK_NOTES_MAX),
      citations: this.visibleCitations(action.citations, source),
      schedule: stored?.schedule,
      custom: stored?.custom || {}
    };
    if (merged.status !== "done") merged.completedAt = undefined;
    return this.publicTask(merged);
  }

  private publicTask(record: StoredTaskRecord): TaskItem {
    return {
      id: record.id,
      origin: record.origin,
      title: record.title,
      notes: record.notes,
      status: record.status,
      priority: record.priority,
      dueAt: record.dueAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      sourceActionId: record.sourceActionId,
      sourceMessageId: record.sourceMessageId,
      sourceAccountId: record.sourceAccountId,
      sourceSourceId: record.sourceSourceId,
      sourceReason: record.sourceReason,
      citations: record.citations,
      schedule: record.schedule
    };
  }

  private rankTasks(tasks: TaskItem[]): TaskItem[] {
    const ranked = [...tasks].sort((left, right) => {
      const diff = this.focusScore(right) - this.focusScore(left);
      if (diff) return diff;
      const dueLeft = left.dueAt ? Date.parse(dueAtDate.test(left.dueAt) ? `${left.dueAt}T12:00:00` : left.dueAt) : Number.POSITIVE_INFINITY;
      const dueRight = right.dueAt ? Date.parse(dueAtDate.test(right.dueAt) ? `${right.dueAt}T12:00:00` : right.dueAt) : Number.POSITIVE_INFINITY;
      if (dueLeft !== dueRight) return dueLeft - dueRight;
      if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
      return left.title.localeCompare(right.title);
    });
    return ranked.map((task, index) => ({ ...task, focusRank: index + 1 }));
  }

  private focusScore(task: TaskItem): number {
    if (task.status === "done") return -1_000;
    let score = ({ urgent: 300, high: 220, medium: 150, low: 80 } satisfies Record<TaskPriority, number>)[task.priority];
    if (task.status === "in_progress") score += 40;
    if (task.status === "waiting") score -= 60;
    if (task.schedule?.state === "out_of_date") score += 45;
    const due = task.dueAt ? Date.parse(dueAtDate.test(task.dueAt) ? `${task.dueAt}T12:00:00` : task.dueAt) : undefined;
    if (due !== undefined && Number.isFinite(due)) {
      const deltaHours = (due - Date.now()) / 3_600_000;
      if (deltaHours < 0) score += 180;
      else if (deltaHours <= 24) score += 120;
      else if (deltaHours <= PRODUCTIVITY_DUE_SOON_HOURS) score += 60;
    }
    return score;
  }

  private actionVisible(action: ActionItem, source: Snapshot): boolean {
    const message = source.messages.find(item => item.id === action.messageId);
    if (!message || message.deleted || !mailOriginAllowed(this.vault, message)
      || !action.citations.every(citation => this.originCitationAllowed(citation, false, source))) return false;
    return this.sourceVisible(message.accountId, message.sourceId, source);
  }

  private recordVisible(record: StoredTaskRecord, source: Snapshot): boolean {
    if (record.origin === "manual") return true;
    if (!record.sourceAccountId || !record.sourceSourceId || !record.sourceMessageId) return false;
    const message = source.messages.find(item => item.id === record.sourceMessageId);
    if (!message || message.deleted || !mailOriginAllowed(this.vault, message)
      || !record.citations.every(citation => this.originCitationAllowed(citation, false, source))) return false;
    const action = record.sourceActionId ? this.vault.get<ActionItem>("actions", record.sourceActionId) : undefined;
    if (record.sourceActionId?.startsWith("review-action:") && !action) return false;
    if (action && !this.review.actionVisible(action)) return false;
    return this.sourceVisible(record.sourceAccountId, record.sourceSourceId, source);
  }

  private sourceVisible(accountId: string, sourceId: string, source: Snapshot): boolean {
    const account = source.accounts.find(item => item.id === accountId);
    const selectedSource = source.sources.find(item => item.id === sourceId);
    return !!(account && account.status === "connected" && account.consent && selectedSource?.selected && selectedSource.accountId === account.id);
  }

  private visibleCitations(citations: Citation[], source: Snapshot): Citation[] {
    const seen = new Set<string>();
    return citations.filter(citation => {
      if (seen.has(citation.id) || !this.originCitationAllowed(citation, false, source)) return false;
      const message = source.messages.find(item => item.id === citation.messageId);
      if (!message || message.deleted || !this.sourceVisible(message.accountId, message.sourceId, source)) return false;
      seen.add(citation.id);
      return true;
    });
  }

  private citationEligibleForAi(citation: Citation, source: Snapshot): boolean {
    if (!this.review.citationVisible(citation) || !this.originCitationAllowed(citation, true, source)) return false;
    const message = source.messages.find(item => item.id === citation.messageId);
    if (!message || message.deleted || !this.sourceVisible(message.accountId, message.sourceId, source)) return false;
    const account = source.accounts.find(item => item.id === message.accountId);
    return !!account?.aiEnabled;
  }

  private citationEligibleInVault(messageId: string, requireAi: boolean): boolean {
    const message = this.vault.get<Message>("messages", messageId);
    if (!message || message.deleted || !mailOriginAllowed(this.vault, message, requireAi)) return false;
    const account = this.vault.get<Account>("accounts", message.accountId);
    const source = this.vault.get<Source>("sources", message.sourceId);
    return !!(account && account.status === "connected" && account.consent && (!requireAi || account.aiEnabled)
      && source && source.selected && source.accountId === account.id);
  }

  private citationEligibleAfterAsync(citation: Citation, requireAi: boolean): boolean {
    return this.review.citationVisible(citation) && this.originCitationAllowed(citation, requireAi)
      && this.citationEligibleInVault(citation.messageId, requireAi);
  }
  private originCitationAllowed(citation: Citation, ai = false, source?: Snapshot): boolean {
    const message = this.vault.get<Message>("messages", citation.messageId) ?? source?.messages.find(item => item.id === citation.messageId);
    if (!message || !mailOriginAllowed(this.vault, message, ai)) return false;
    if (!citation.attachmentId) return true;
    const attachment = this.vault.get<Attachment>("attachments", citation.attachmentId);
    return !!attachment && attachment.messageId === message.id && attachment.accountId === message.accountId
      && mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi }, ai);
  }

  private normalizeScheduleChange(change: EventChange, task: StoredTaskRecord, source: Snapshot): EventChange {
    const calendarSource = source.sources.find(item => item.id === change.sourceId);
    const calendarAccount = source.accounts.find(item => item.id === change.accountId);
    if (!calendarSource || calendarSource.kind !== "calendar") throw new Error("Choose a connected calendar.");
    if (calendarSource.accountId !== change.accountId) throw new Error("Choose a calendar that belongs to the selected connected account.");
    if (!calendarAccount || calendarAccount.status !== "connected" || !calendarAccount.consent || calendarAccount.demo) throw new Error("Choose a real connected calendar.");
    if (calendarAccount.connection === "browser") throw new Error("Browser calendars are read-only. Choose an API calendar for scheduling.");
    const existingEvent = task.schedule?.eventId ? source.events.find(event => event.id === task.schedule?.eventId) : undefined;
    const normalized: EventChange = {
      ...change,
      title: trimText(change.title, 1_000),
      location: (change.location || "").slice(0, 2_000),
      description: (change.description || "").slice(0, TASK_NOTES_MAX),
      attendees: [],
      reminderMinutes: change.reminderMinutes ?? DEFAULT_TASK_REMINDER_MINUTES,
      eventId: change.eventId ?? task.schedule?.eventId,
      expectedRevision: change.expectedRevision ?? existingEvent?.revision
    };
    if (!normalized.title) throw new Error("Calendar title is required.");
    if (change.attendees.length) throw new Error("Task scheduling only supports private events with no attendees.");
    validateCalendarChange(normalized);
    return normalized;
  }

  private selectReportCitations(tasks: TaskItem[], source: Snapshot): Citation[] {
    const seen = new Set<string>();
    const picked: Citation[] = [];
    for (const task of tasks) {
      if (task.origin !== "action" || task.status === "done") continue;
      if (task.sourceMessageId && !this.citationEligibleInVault(task.sourceMessageId, true)) continue;
      for (const citation of task.citations) {
        if (!this.citationEligibleForAi(citation, source) || seen.has(citation.id)) continue;
        seen.add(citation.id);
        picked.push(citation);
        if (picked.length >= 12) return picked;
      }
    }
    return picked;
  }

  private reportPromptScope(tasks: TaskItem[], source: Snapshot, citations: Citation[]): ReportPromptScope {
    const permittedCitationIds = new Set(citations.map(citation => citation.id));
    const scopedTasks = tasks.filter(task =>
      task.origin === "action"
      && task.status !== "done"
      && (!task.sourceMessageId || this.citationEligibleInVault(task.sourceMessageId, true))
      && task.citations.some(citation => permittedCitationIds.has(citation.id))
    );
    const openTasks = scopedTasks.filter(task => task.status === "open");
    const inProgressTasks = scopedTasks.filter(task => task.status === "in_progress");
    const waitingTasks = scopedTasks.filter(task => task.status === "waiting");
    const overdueTasks = scopedTasks.filter(task => this.dueBucket(task) === "overdue");
    const dueSoonTasks = scopedTasks.filter(task => this.dueBucket(task) === "soon");
    const urgentTasks = scopedTasks.filter(task => task.priority === "urgent" || task.priority === "high");
    const partialBrowserTasks = scopedTasks.filter(task => this.taskHasPartialBrowserCoverage(task, source));
    const staleBrowserTasks = scopedTasks.filter(task => this.taskHasStaleBrowserCoverage(task, source));
    const workloadScore = openTasks.length + inProgressTasks.length * 2 + overdueTasks.length * 3 + urgentTasks.length * 2 + waitingTasks.length;
    const workloadLabel = workloadScore >= 18 ? "overloaded"
      : workloadScore >= 10 ? "heavy"
        : workloadScore >= 5 ? "steady"
          : "light";
    return {
      tasks: scopedTasks,
      metrics: {
        totalTasks: scopedTasks.length,
        openTasks: openTasks.length,
        inProgressTasks: inProgressTasks.length,
        waitingTasks: waitingTasks.length,
        overdueTasks: overdueTasks.length,
        dueSoonTasks: dueSoonTasks.length,
        urgentTasks: urgentTasks.length,
        staleBrowserTasks: staleBrowserTasks.length,
        partialBrowserTasks: partialBrowserTasks.length,
        workloadScore,
        workloadLabel
      }
    };
  }

  private buildFocusReport(source: Snapshot, tasks: TaskItem[], stored?: StoredReportRecord): FocusReport {
    const snapshotAt = now();
    const upcomingMeetings = this.upcomingMeetings(source);
    const openTasks = tasks.filter(task => task.status === "open");
    const inProgressTasks = tasks.filter(task => task.status === "in_progress");
    const waitingTasks = tasks.filter(task => task.status === "waiting");
    const completedTasks = tasks.filter(task => task.status === "done");
    const overdueTasks = tasks.filter(task => task.status !== "done" && this.dueBucket(task) === "overdue");
    const dueSoonTasks = tasks.filter(task => task.status !== "done" && this.dueBucket(task) === "soon");
    const urgentTasks = tasks.filter(task => task.status !== "done" && (task.priority === "urgent" || task.priority === "high"));
    const partialBrowserTasks = tasks.filter(task => this.taskHasPartialBrowserCoverage(task, source));
    const staleBrowserTasks = tasks.filter(task => this.taskHasStaleBrowserCoverage(task, source));
    const aiEligibleCitationCount = this.selectReportCitations(tasks, source).length;
    const workloadScore = openTasks.length + inProgressTasks.length * 2 + overdueTasks.length * 3 + urgentTasks.length * 2 + waitingTasks.length;
    const workloadLabel = workloadScore >= 18 ? "overloaded"
      : workloadScore >= 10 ? "heavy"
        : workloadScore >= 5 ? "steady"
          : "light";

    const citationLookup = new Map(tasks.flatMap(task => task.citations.map(citation => [citation.id, citation] as const)));
    const reportScopeVisible = this.storedReportStillVisible(stored, source, citationLookup);
    const visibleNarrativeCitations = reportScopeVisible ? stored?.citationIds.map(id => citationLookup.get(id)).filter((citation): citation is Citation => !!citation) ?? [] : [];
    const rankedTasks = tasks.filter(task => task.status !== "done").slice(0, 6);
    const nextActions = rankedTasks.slice(0, 4).map(task => this.nextAction(task)) as FocusReportNextAction[];
    const warnings = [
      ...(overdueTasks.length ? [`${overdueTasks.length} task${overdueTasks.length === 1 ? "" : "s"} are overdue.`] : []),
      ...(partialBrowserTasks.length ? [`${partialBrowserTasks.length} task${partialBrowserTasks.length === 1 ? "" : "s"} rely on browser preview coverage or missing exact message dates.`] : []),
      ...(staleBrowserTasks.length ? [`${staleBrowserTasks.length} browser-captured task${staleBrowserTasks.length === 1 ? "" : "s"} were last captured more than ${PRODUCTIVITY_BROWSER_STALE_HOURS} hours ago.`] : []),
      ...(tasks.filter(task => task.schedule?.state === "out_of_date").length ? ["Some scheduled tasks changed locally and need an explicit reschedule."] : []),
      ...(!source.sources.some(item => item.kind === "mail" && item.selected) ? ["No mail source is currently selected for email-backed focus narrative coverage."] : [])
    ];

    return {
      id: stored?.id ?? "focus:live",
      generatedAt: stored?.generatedAt ?? snapshotAt,
      snapshotAt,
      prompt: stored?.prompt,
      narrative: reportScopeVisible && visibleNarrativeCitations.length === stored?.citationIds.length ? stored?.narrative : undefined,
      citations: visibleNarrativeCitations,
      citationIds: visibleNarrativeCitations.map(citation => citation.id),
      sourceIds: sortUnique(visibleNarrativeCitations.map(citation => source.messages.find(message => message.id === citation.messageId)?.sourceId)),
      accountIds: sortUnique(visibleNarrativeCitations.map(citation => source.messages.find(message => message.id === citation.messageId)?.accountId)),
      metrics: {
        totalTasks: tasks.length,
        openTasks: openTasks.length,
        inProgressTasks: inProgressTasks.length,
        waitingTasks: waitingTasks.length,
        completedTasks: completedTasks.length,
        overdueTasks: overdueTasks.length,
        dueSoonTasks: dueSoonTasks.length,
        urgentTasks: urgentTasks.length,
        scheduledTasks: tasks.filter(task => task.schedule?.state === "scheduled").length,
        outOfDateSchedules: tasks.filter(task => task.schedule?.state === "out_of_date").length,
        manualTasks: tasks.filter(task => task.origin === "manual").length,
        actionBackedTasks: tasks.filter(task => task.origin === "action").length,
        staleBrowserTasks: staleBrowserTasks.length,
        partialBrowserTasks: partialBrowserTasks.length,
        upcomingMeetings: upcomingMeetings.length,
        workloadScore,
        workloadLabel
      },
      coverage: {
        includedAccountIds: sortUnique(tasks.map(task => task.sourceAccountId).concat(upcomingMeetings.map(meeting => meeting.accountId))),
        includedSourceIds: sortUnique(tasks.map(task => task.sourceSourceId).concat(upcomingMeetings.map(meeting => meeting.sourceId))),
        connectedAccounts: source.accounts.filter(account => account.status === "connected" && account.consent).length,
        selectedMailSources: source.sources.filter(item => item.kind === "mail" && item.selected).length,
        selectedCalendarSources: source.sources.filter(item => item.kind === "calendar" && item.selected).length,
        aiEligibleCitationCount,
        exactDueDateTasks: tasks.filter(task => !!task.dueAt).length,
        impreciseBrowserTasks: partialBrowserTasks.length,
        dueSoonWindowHours: PRODUCTIVITY_DUE_SOON_HOURS,
        meetingWindowHours: PRODUCTIVITY_MEETING_WINDOW_HOURS
      },
      rankedTasks,
      nextActions,
      upcomingMeetings,
      warnings
    };
  }

  private storedReportStillVisible(
    stored: StoredReportRecord | undefined,
    source: Snapshot,
    citationLookup: Map<string, Citation>
  ): boolean {
    if (!stored?.narrative) return false;
    if (stored.mailOrigins?.some(origin => !mailOriginAllowed(this.vault, origin as Message, true))) return false;
    const allAccountsEligible = stored.accountIds.every(accountId => {
      const account = source.accounts.find(item => item.id === accountId);
      return !!account && account.status === "connected" && account.consent && account.aiEnabled;
    });
    if (!allAccountsEligible) return false;
    const allSourcesEligible = stored.sourceIds.every(sourceId => {
      const selectedSource = source.sources.find(item => item.id === sourceId);
      return !!selectedSource && selectedSource.selected;
    });
    if (!allSourcesEligible) return false;
    return stored.citationIds.length > 0 && (stored.inputCitationIds ?? stored.citationIds).every(citationId => {
      const citation = citationLookup.get(citationId);
      return !!citation && this.citationEligibleForAi(citation, source);
    });
  }

  private dueBucket(task: TaskItem): "none" | "overdue" | "soon" | "later" {
    if (!task.dueAt) return "none";
    const parsed = Date.parse(dueAtDate.test(task.dueAt) ? `${task.dueAt}T12:00:00` : task.dueAt);
    if (!Number.isFinite(parsed)) return "none";
    if (parsed < Date.now()) return "overdue";
    if ((parsed - Date.now()) / 3_600_000 <= PRODUCTIVITY_DUE_SOON_HOURS) return "soon";
    return "later";
  }

  private nextAction(task: TaskItem): FocusReportNextAction {
    const due = this.dueBucket(task);
    const reason = task.schedule?.state === "out_of_date"
      ? "Local task details changed after scheduling; verify and reschedule the calendar event explicitly."
      : due === "overdue"
        ? "This item is already past its due date."
        : due === "soon"
          ? `This item is due within ${PRODUCTIVITY_DUE_SOON_HOURS} hours.`
          : task.status === "waiting"
            ? "This item is waiting on a reply, dependency, or later review."
            : task.sourceReason || "This is ready for focused progress.";
    return { taskId: task.id, title: task.title, reason, priority: task.priority, dueAt: task.dueAt, sourceMessageId: task.sourceMessageId };
  }

  private upcomingMeetings(source: Snapshot): FocusReportMeeting[] {
    const cutoff = Date.now() + PRODUCTIVITY_MEETING_WINDOW_HOURS * 3_600_000;
    return source.events.filter(event =>
      this.sourceVisible(event.accountId, event.sourceId, source)
      && Number.isFinite(Date.parse(event.start))
      && Date.parse(event.start) >= Date.now()
      && Date.parse(event.start) <= cutoff
    ).sort((left, right) => left.start.localeCompare(right.start))
      .slice(0, 5)
      .map(event => ({
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
      }));
  }

  private taskHasPartialBrowserCoverage(task: TaskItem, source: Snapshot): boolean {
    return task.citations.some(citation => {
      const message = source.messages.find(item => item.id === citation.messageId);
      return !!message?.browser && (message.browser.completeness === "preview" || !message.receivedAt);
    });
  }

  private taskHasStaleBrowserCoverage(task: TaskItem, source: Snapshot): boolean {
    return task.citations.some(citation => {
      const message = source.messages.find(item => item.id === citation.messageId);
      return !!message?.browser && Number.isFinite(Date.parse(message.browser.capturedAt))
        && Date.parse(message.browser.capturedAt) <= Date.now() - PRODUCTIVITY_BROWSER_STALE_HOURS * 3_600_000;
    });
  }

  private reportPrompt(userPrompt: string | undefined, scope: ReportPromptScope, citations: Citation[]): string {
    const taskLines = scope.tasks.slice(0, 6).map(task =>
      `- ${task.title} | priority=${task.priority} | status=${task.status}${task.dueAt ? ` | due=${task.dueAt}` : ""}${task.sourceReason ? ` | why=${task.sourceReason}` : ""}`
    );
    return [
      "Write a concise focus report using only the supplied citations.",
      "Ground every claim in the supplied evidence. Do not invent dates, senders, or deadlines.",
      "If any cited browser message lacks an exact received date, say that its freshness is unconfirmed.",
      "Do not mention sources that are not cited.",
      "Put the readable narrative in the answer field and return supplied citation IDs using the required response format.",
      "If useful, organize the answer with short headings such as: Act now, Next 72h, Waiting, Uncertainty.",
      `User emphasis: ${trimText(userPrompt, 2_000) || "Summarize what deserves focus next, why it matters, and what can safely wait."}`,
      `Metrics: total=${scope.metrics.totalTasks}, open=${scope.metrics.openTasks}, inProgress=${scope.metrics.inProgressTasks}, waiting=${scope.metrics.waitingTasks}, overdue=${scope.metrics.overdueTasks}, dueSoon=${scope.metrics.dueSoonTasks}, urgent=${scope.metrics.urgentTasks}, workload=${scope.metrics.workloadLabel}, partialBrowser=${scope.metrics.partialBrowserTasks}, staleBrowser=${scope.metrics.staleBrowserTasks}.`,
      "Top current tasks:",
      ...taskLines,
      `Citations available: ${citations.map(citation => citation.id).join(", ")}.`
    ].join("\n");
  }
}
