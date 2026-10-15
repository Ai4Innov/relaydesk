import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CalendarAgenda, calendarEntryOnDay } from "../src/renderer/CalendarAgenda";
import type { CalendarEvent } from "../src/shared/contracts";
import { calendarFixture } from "./fixtures/calendar";

describe("calendar agenda presentation", () => {
  it("keeps multi-day and overnight API events in the selected day, respecting exclusive ends", () => {
    const event: CalendarEvent = { id: "event", accountId: "account", sourceId: "source", providerId: "event",
      title: "Conference", start: "2099-04-12", end: "2099-04-15", allDay: true, timeZone: "UTC",
      attendees: [], location: "", description: "", revision: "one", url: "" };
    expect(calendarEntryOnDay({ dateKey: "2099-04-12", original: event }, "2099-04-14")).toBe(true);
    expect(calendarEntryOnDay({ dateKey: "2099-04-12", original: event }, "2099-04-15")).toBe(false);
    const overnight = { ...event, allDay: false, start: new Date(2099, 3, 12, 23).toISOString(), end: new Date(2099, 3, 13, 1).toISOString() };
    expect(calendarEntryOnDay({ dateKey: "2099-04-12", original: overnight }, "2099-04-13")).toBe(true);
    expect(calendarEntryOnDay({ dateKey: "2099-04-12", original: overnight }, "2099-04-14")).toBe(false);
  });

  it("separates clean titles, times, sources and uncertain dates without requiring AI consent", () => {
    const html = renderToStaticMarkup(<CalendarAgenda data={calendarFixture()} busy={false} run={vi.fn()} onEdit={vi.fn()} editableSources={[]}/>);
    expect(html).toContain("<h3>Client presentation</h3>");
    expect(html).toContain("work@example.org");
    expect(html).toContain("personal@example.org");
    expect(html).toContain("Date not confirmed");
    expect(html).toContain("Possible overlap");
    expect(html).not.toContain(">Time conflict<");
    expect(html).toContain("Original captured label");
    expect(html).toContain("keyword suggestions");
    expect(html).toContain("Important suggestion");
    expect(html).toContain("Calendar insights");
  });
});
