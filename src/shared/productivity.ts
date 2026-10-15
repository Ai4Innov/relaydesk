import type { Citation, EventChange } from "./contracts";

export const TASK_TITLE_MAX = 240;
export const TASK_NOTES_MAX = 4_000;
export const FOCUS_REPORT_PROMPT_MAX = 2_000;
export const DEFAULT_TASK_REMINDER_MINUTES = 15;
export const MAX_TASK_REMINDER_MINUTES = 40_320;
export const PRODUCTIVITY_DUE_SOON_HOURS = 72;
export const PRODUCTIVITY_MEETING_WINDOW_HOURS = 72;
export const PRODUCTIVITY_BROWSER_STALE_HOURS = 72;

export const taskStatuses = ["open", "in_progress", "waiting", "done"] as const;
export type TaskStatus = typeof taskStatuses[number];

export const taskPriorities = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = typeof taskPriorities[number];

export type TaskOrigin = "manual" | "action";
export type TaskScheduleState = "pending" | "scheduled" | "out_of_date" | "uncertain";

export interface TaskSchedule {
  state: TaskScheduleState;
  operationId: string;
  eventId?: string;
  change: EventChange;
  reminderMinutes: number;
  isPrivate: true;
  noAttendees: true;
  confirmedAt: string;
  lastAttemptAt: string;
  scheduledAt?: string;
  note?: string;
}

export interface TaskItem {
  id: string;
  origin: TaskOrigin;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  sourceActionId?: string;
  sourceMessageId?: string;
  sourceAccountId?: string;
  sourceSourceId?: string;
  sourceReason?: string;
  citations: Citation[];
  schedule?: TaskSchedule;
  focusRank?: number;
}

export interface FocusReportMetrics {
  totalTasks: number;
  openTasks: number;
  inProgressTasks: number;
  waitingTasks: number;
  completedTasks: number;
  overdueTasks: number;
  dueSoonTasks: number;
  urgentTasks: number;
  scheduledTasks: number;
  outOfDateSchedules: number;
  manualTasks: number;
  actionBackedTasks: number;
  staleBrowserTasks: number;
  partialBrowserTasks: number;
  upcomingMeetings: number;
  workloadScore: number;
  workloadLabel: "light" | "steady" | "heavy" | "overloaded";
}

export interface FocusReportCoverage {
  includedAccountIds: string[];
  includedSourceIds: string[];
  connectedAccounts: number;
  selectedMailSources: number;
  selectedCalendarSources: number;
  aiEligibleCitationCount: number;
  exactDueDateTasks: number;
  impreciseBrowserTasks: number;
  dueSoonWindowHours: number;
  meetingWindowHours: number;
}

export interface FocusReportNextAction {
  taskId: string;
  title: string;
  reason: string;
  priority: TaskPriority;
  dueAt?: string;
  sourceMessageId?: string;
}

export interface FocusReportMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  accountId: string;
  sourceId: string;
  allDay: boolean;
  location: string;
  url?: string;
}

export interface FocusReport {
  id: string;
  generatedAt: string;
  snapshotAt: string;
  prompt?: string;
  narrative?: string;
  citations: Citation[];
  citationIds: string[];
  sourceIds: string[];
  accountIds: string[];
  metrics: FocusReportMetrics;
  coverage: FocusReportCoverage;
  rankedTasks: TaskItem[];
  nextActions: FocusReportNextAction[];
  upcomingMeetings: FocusReportMeeting[];
  warnings: string[];
}

export interface AiReviewReport {
  id: string;
  generatedAt: string;
  narrative: string;
  citations: Citation[];
}

export interface AiReviewCoverage {
  status: "idle" | "running" | "paused" | "cancelled" | "complete";
  totalAvailable: number;
  totalEligible: number;
  reviewed: number;
  remaining: number;
  excluded: number;
  exclusions: { reason: string; count: number }[];
  failures: number;
  failedMessages: number;
  totalChunks: number;
  reviewedChunks: number;
  previewMessages: number;
  batchesCompleted: number;
  batchLimit: number;
  updatedAt?: string;
  detail?: string;
  reports: AiReviewReport[];
}

export type ProductivityCommand =
  | { type: "task.create"; title: string; notes?: string; priority?: TaskPriority; dueAt?: string; status?: TaskStatus }
  | { type: "task.edit"; taskId: string; title?: string; notes?: string; priority?: TaskPriority; dueAt?: string | null; status?: TaskStatus }
  | { type: "task.status"; taskId: string; status: TaskStatus }
  | { type: "task.schedule"; taskId: string; confirmed: true; change: EventChange }
  | { type: "report.generate"; prompt?: string }
  | { type: "review.start"; maxBatches?: number }
  | { type: "review.pause" }
  | { type: "review.cancel" };
