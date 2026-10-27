import type { EventChange } from "./contracts";

const TEMPLATE_BASE = "https://calendar.google.com/calendar/render";

function utcStamp(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Pre-filled Google Calendar "create event" page for the given account. Opening it lets the user
 * save the event in Google Calendar with one click; nothing is written without that click.
 */
export function googleCalendarTemplateUrl(change: Pick<EventChange, "title" | "start" | "end" | "allDay" | "timeZone" | "location" | "description">, accountEmail?: string): string {
  const dates = change.allDay
    ? `${change.start.replace(/-/g, "")}/${change.end.replace(/-/g, "")}`
    : `${utcStamp(change.start)}/${utcStamp(change.end)}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: change.title, dates });
  if (change.description) params.set("details", change.description.slice(0, 1500));
  if (change.location) params.set("location", change.location);
  if (change.timeZone) params.set("ctz", change.timeZone);
  if (accountEmail) params.set("authuser", accountEmail);
  return `${TEMPLATE_BASE}?${params.toString()}`;
}

export function isGoogleCalendarTemplateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "calendar.google.com" && url.pathname === "/calendar/render"
      && url.searchParams.get("action") === "TEMPLATE" && !url.username && !url.password && !url.port;
  } catch { return false; }
}
