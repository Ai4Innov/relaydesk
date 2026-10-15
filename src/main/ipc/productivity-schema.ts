import { z } from "zod";
import { DEFAULT_TASK_REMINDER_MINUTES, FOCUS_REPORT_PROMPT_MAX, MAX_TASK_REMINDER_MINUTES, TASK_NOTES_MAX, TASK_TITLE_MAX, taskPriorities, taskStatuses } from "../../shared/productivity";

const id = z.string().trim().min(1).max(2048);
const dueAtDate = /^\d{4}-\d{2}-\d{2}$/;
const dueAtDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const email = z.string().trim().email().max(320);

const dueAtSchema = z.string().trim().min(1).max(40).refine((value) =>
  (dueAtDate.test(value) || dueAtDateTime.test(value)) && Number.isFinite(Date.parse(dueAtDate.test(value) ? `${value}T12:00:00` : value)),
  "Use YYYY-MM-DD or an ISO date-time with a UTC offset."
);

const scheduleChangeSchema = z.object({
  accountId: id,
  sourceId: id,
  eventId: id.optional(),
  title: z.string().trim().min(1).max(1_000),
  start: z.string().trim().min(1).max(100),
  end: z.string().trim().min(1).max(100),
  timeZone: z.string().trim().min(1).max(100),
  allDay: z.boolean(),
  attendees: z.array(email).max(0).default([]),
  location: z.string().max(2_000).default(""),
  description: z.string().max(TASK_NOTES_MAX).default(""),
  expectedRevision: z.string().trim().min(1).max(2048).optional(),
  reminderMinutes: z.number().int().min(0).max(MAX_TASK_REMINDER_MINUTES).default(DEFAULT_TASK_REMINDER_MINUTES)
}).strict().superRefine((change, context) => {
  const format = change.allDay ? dueAtDate : dueAtDateTime;
  if (!format.test(change.start) || !format.test(change.end)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: change.allDay ? "All-day schedules need date-only start and end values." : "Timed schedules need ISO date-times with a UTC offset.",
      path: ["start"]
    });
    return;
  }
  const start = Date.parse(change.start);
  const end = Date.parse(change.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Schedule end must be after start.", path: ["end"] });
  }
  try { new Intl.DateTimeFormat("en", { timeZone: change.timeZone }).format(); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a valid IANA time zone.", path: ["timeZone"] }); }
});

export const productivitySchemas = [
  z.object({
    type: z.literal("review.start"),
    maxBatches: z.number().int().min(1).max(20).optional()
  }).strict(),
  z.object({ type: z.literal("review.pause") }).strict(),
  z.object({ type: z.literal("review.cancel") }).strict(),
  z.object({
    type: z.literal("task.create"),
    title: z.string().trim().min(1).max(TASK_TITLE_MAX),
    notes: z.string().max(TASK_NOTES_MAX).optional(),
    priority: z.enum(taskPriorities).optional(),
    dueAt: dueAtSchema.optional(),
    status: z.enum(taskStatuses).optional()
  }).strict(),
  z.object({
    type: z.literal("task.edit"),
    taskId: id,
    title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
    notes: z.string().max(TASK_NOTES_MAX).optional(),
    priority: z.enum(taskPriorities).optional(),
    dueAt: dueAtSchema.nullable().optional(),
    status: z.enum(taskStatuses).optional()
  }).strict(),
  z.object({
    type: z.literal("task.status"),
    taskId: id,
    status: z.enum(taskStatuses)
  }).strict(),
  z.object({
    type: z.literal("task.schedule"),
    taskId: id,
    confirmed: z.literal(true),
    change: scheduleChangeSchema
  }).strict(),
  z.object({
    type: z.literal("report.generate"),
    prompt: z.string().trim().min(1).max(FOCUS_REPORT_PROMPT_MAX).optional()
  }).strict()
] as const;
