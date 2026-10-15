import { createHash, randomUUID } from "node:crypto";
import type { Approval, EventChange } from "../../shared/contracts";
import { validateReminderMinutes } from "../connectors/calendar";

export function validateChange(change: EventChange): void {
  const format = change.allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
  if (!format.test(change.start) || !format.test(change.end))
    throw new Error(change.allDay ? "All-day events require date-only values and an exclusive end date." : "Timed events require ISO timestamps with a UTC offset.");
  const start = Date.parse(change.start);
  const end = Date.parse(change.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("The event end must be after its start.");
  try { new Intl.DateTimeFormat("en", { timeZone: change.timeZone }).format(); }
  catch { throw new Error("Choose a valid IANA time zone, for example Europe/Paris."); }
  validateReminderMinutes(change.reminderMinutes);
  if (change.eventId && !change.expectedRevision) throw new Error("Refresh this event before proposing an edit.");
}
export function payloadHash(change: EventChange): string {
  return createHash("sha256").update(JSON.stringify({
    accountId: change.accountId, sourceId: change.sourceId, eventId: change.eventId ?? null,
    title: change.title, start: change.start, end: change.end, timeZone: change.timeZone,
    allDay: change.allDay, attendees: [...change.attendees], location: change.location,
    description: change.description, reminderMinutes: change.reminderMinutes ?? null, expectedRevision: change.expectedRevision ?? null
  })).digest("hex");
}
export function proposeChange(change: EventChange): Approval {
  validateChange(change);
  return {
    id: randomUUID(), kind: "calendar", change, hash: payloadHash(change), createdAt: new Date().toISOString(),
    status: "pending",
    effect: change.attendees.length
      ? "This operation may send meeting invitations or updates to every listed attendee."
      : "This changes the selected calendar. Provider notification rules still apply."
  };
}
export function validateApproval(approval: Approval, hash: string): void {
  if (approval.status !== "pending") throw new Error("This approval is no longer pending. Refresh its status.");
  if (hash !== approval.hash || payloadHash(approval.change) !== hash) throw new Error("The proposed event changed. Review a new approval.");
  if (Date.now() - Date.parse(approval.createdAt) > 15 * 60 * 1000) throw new Error("This approval expired. Preview the current event again.");
  validateChange(approval.change);
}
