import { defaultSettings } from "../../src/shared/defaults";
import type { Snapshot } from "../../src/shared/contracts";

export function calendarFixture(): Snapshot {
  return {
    accounts: [
      { id: "browser-one", email: "work@example.org", name: "Work", provider: "gmail", connection: "browser", consent: true, aiEnabled: false, status: "connected" },
      { id: "browser-two", email: "personal@example.org", name: "Personal", provider: "gmail", connection: "browser", consent: true, aiEnabled: false, status: "connected" }
    ],
    sources: [
      { id: "calendar-one", accountId: "browser-one", name: "Work calendar", kind: "calendar", providerId: "calendar-one", selected: true },
      { id: "calendar-two", accountId: "browser-two", name: "Personal calendar", kind: "calendar", providerId: "calendar-two", selected: true }
    ],
    browserItems: [
      { id: "one", accountId: "browser-one", sourceId: "calendar-one", title: "9am to 10am, Client presentation, April 12, 2099", whenText: "9am to 10am, Client presentation, April 12, 2099", description: "Keep the full description in details.", location: "Room A", capturedAt: "2099-04-11T08:00:00Z", url: "https://calendar.google.com/calendar/u/0/r/agenda" },
      { id: "two", accountId: "browser-one", sourceId: "calendar-one", title: "9:30am to 10:30am, Planning, April 12, 2099", whenText: "9:30am to 10:30am, Planning, April 12, 2099", description: "", location: "", capturedAt: "2099-04-11T08:00:00Z", url: "https://calendar.google.com/calendar/u/0/r/agenda" },
      { id: "three", accountId: "browser-two", sourceId: "calendar-two", title: "Personal catch-up", whenText: "Tomorrow, 11am", description: "", location: "", capturedAt: "2099-04-11T08:00:00Z", url: "https://calendar.google.com/calendar/u/1/r/agenda" }
    ],
    messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
    settings: defaultSettings, models: [], copilot: { status: "disconnected", message: "Synthetic fixture" },
    archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false
  };
}
