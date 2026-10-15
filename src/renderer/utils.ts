import type { Account, CalendarEvent, Draft, EventChange, Message } from "../shared/contracts";

export function commandError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The action failed. Please try again.";
  return message.replace(/^Error invoking remote method ['"]relay:command['"]: (?:Error: )?/, "");
}

export type HostOS = "windows" | "macos" | "linux";
/** Renderer-side OS detection for wording only; security decisions stay in the main process. */
export function hostOS(platform = typeof navigator === "undefined" ? "" : navigator.platform): HostOS {
  return /^mac/i.test(platform) ? "macos" : /^win/i.test(platform) ? "windows" : /linux|x11|bsd/i.test(platform) ? "linux" : "windows";
}
export const OS_TEXT = {
  windows: { name: "Windows", shell: "PowerShell", tray: "the tray", documents: "Documents\\Relay Desk" },
  macos: { name: "macOS", shell: "Shell (bash/zsh)", tray: "the menu bar", documents: "Documents/Relay Desk" },
  linux: { name: "Linux", shell: "Shell (bash)", tray: "the system tray", documents: "Documents/Relay Desk" }
} as const;

export function formatDate(value: string, withTime = false): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (!Number.isFinite(date.getTime())) return value || "Not available";
  return date.toLocaleString(undefined, withTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}
export function fileSize(bytes?: number): string {
  if (bytes === undefined) return "Size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function splitAddresses(value: string): string[] {
  return value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
}
const normalizeEmail = (value: string) => value.trim().toLowerCase();
export function draftSignature(draft: Pick<Draft, "body" | "subject" | "recipients">): string {
  return JSON.stringify([draft.body, draft.subject, draft.recipients]);
}
export function nativeDraftSupport(message: Message, accounts: Account[]): { enabled: boolean; note: string } {
  const account = accounts.find(item => item.id === message.accountId);
  if (!account) return { enabled: false, note: "Reconnect this account to review native draft options." };
  if (account.provider === "whatsapp") return { enabled: false, note: "WhatsApp replies stay local. Copy the reviewed text, open the correct chat in WhatsApp Web, and send it yourself." };
  if (account.provider === "slack") return { enabled: false, note: "Slack replies stay local; copy the reviewed text into Slack yourself." };
  if (account.connection !== "browser") return { enabled: true, note: "Native email drafts are saved only when you explicitly choose below." };
  const sameMailbox = accounts.find(item =>
    item.provider === "gmail" && item.connection !== "browser" && item.status === "connected" && item.consent && !item.demo
    && normalizeEmail(item.email) === normalizeEmail(account.email));
  return sameMailbox
    ? { enabled: true, note: "Relay Desk can use your same-email Gmail API authorization to save this reviewed browser draft natively. Nothing is sent." }
    : { enabled: false, note: "To save this browser-captured Gmail reply natively, optionally connect the same Gmail address under Optional API connections. Without that exact match, Relay Desk keeps this reply local only." };
}
export function localDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function eventChange(event: CalendarEvent): EventChange {
  return {
    accountId: event.accountId, sourceId: event.sourceId, eventId: event.id,
    title: event.title, start: event.start, end: event.end, timeZone: event.timeZone,
    allDay: event.allDay, attendees: [...event.attendees], location: event.location,
    description: event.description, expectedRevision: event.revision,
    ...(event.reminderMinutes === undefined ? {} : { reminderMinutes: event.reminderMinutes }),
  };
}
export function validateEvent(change: EventChange): string | undefined {
  if (!change.accountId || !change.sourceId) return "Select an authorized calendar.";
  if (!change.title.trim()) return "Add an event title.";
  if (!change.start || !change.end) return "Choose a start and end.";
  if (change.allDay && (!/^\d{4}-\d{2}-\d{2}$/.test(change.start) || !/^\d{4}-\d{2}-\d{2}$/.test(change.end))) return "All-day events need calendar dates.";
  if (!change.allDay && (!/(Z|[+-]\d{2}:\d{2})$/.test(change.start) || !/(Z|[+-]\d{2}:\d{2})$/.test(change.end))) return "Timed events need an explicit UTC offset.";
  if (!Number.isFinite(Date.parse(change.start)) || !Number.isFinite(Date.parse(change.end)) || Date.parse(change.end) <= Date.parse(change.start)) return "End must be after start.";
  if (change.attendees.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return "Review attendee email addresses before continuing.";
  if (change.reminderMinutes !== undefined && (!Number.isInteger(change.reminderMinutes) || change.reminderMinutes < 0 || change.reminderMinutes > 40320))
    return "Reminder must be a whole number from 0 to 40320 minutes before the event.";
  try { new Intl.DateTimeFormat(undefined, { timeZone: change.timeZone }); } catch { return "Enter a valid IANA time zone, such as Europe/Paris."; }
  return undefined;
}
