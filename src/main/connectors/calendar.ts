import type { EventChange } from "../../shared/contracts";
import type { Json } from "./core";

const MAX_REMINDER_MINUTES = 40320;
export function isReminderMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_MINUTES;
}
export function validateReminderMinutes(value: unknown): void {
  if (value === undefined) return;
  if (!isReminderMinutes(value)) throw new Error(`Reminder must be an integer number of minutes between 0 and ${MAX_REMINDER_MINUTES}`);
}
export function validateChange(change: EventChange): void {
  if (!change.title.trim()) throw new Error("Calendar title is required");
  try { new Intl.DateTimeFormat("en", { timeZone: change.timeZone }).format(); } catch { throw new Error("Use a valid IANA time zone"); }
  validateReminderMinutes(change.reminderMinutes);
  if (change.allDay) {
    for (const value of [change.start, change.end]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new Error("All-day events require valid YYYY-MM-DD dates; end is exclusive");
      }
    }
  } else {
    for (const value of [change.start, change.end]) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error("Timed events require ISO date-times with an explicit UTC offset");
      }
    }
  }
  if (Date.parse(change.end) <= Date.parse(change.start)) throw new Error("Event end must follow start");
  if (change.attendees.some(value => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) throw new Error("Invalid attendee email address");
  // Runtime callers must not smuggle unsupported recurrence fields through a cast.
  if ("recurrence" in change || "recurring" in change) throw new Error("Recurrence writes are not supported");
}
export function eventBody(provider: "gmail" | "microsoft", change: EventChange): Json {
  if (provider === "gmail") {
    const date = (value: string) => change.allDay ? { date: value } : { dateTime: value, timeZone: change.timeZone };
    return { summary: change.title, start: date(change.start), end: date(change.end), attendees: change.attendees.map(email => ({ email })),
      location: change.location, description: change.description,
      ...(change.reminderMinutes === undefined ? {} : { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: change.reminderMinutes }] } }) };
  }
  const date = (value: string) => {
    if (change.allDay) return { dateTime: `${value}T00:00:00`, timeZone: change.timeZone };
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: change.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
    const get = (name: string) => parts.find(part => part.type === name)?.value ?? "";
    return { dateTime: `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`, timeZone: change.timeZone };
  };
  return { subject: change.title, start: date(change.start), end: date(change.end), isAllDay: change.allDay,
    attendees: change.attendees.map(address => ({ emailAddress: { address }, type: "required" })),
    location: { displayName: change.location }, body: { contentType: "text", content: change.description },
    ...(change.reminderMinutes === undefined ? {} : { isReminderOn: true, reminderMinutesBeforeStart: change.reminderMinutes }) };
}
