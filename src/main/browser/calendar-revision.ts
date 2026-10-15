import { createHash } from "node:crypto";
import type { BrowserCalendarItem } from "../../shared/browser";

export function browserCalendarRevision(item: BrowserCalendarItem): string {
  return createHash("sha256").update(JSON.stringify({
    id: item.id, accountId: item.accountId, sourceId: item.sourceId,
    title: item.title, whenText: item.whenText, description: item.description,
    location: item.location, meetingUrl: item.meetingUrl
  })).digest("hex");
}
