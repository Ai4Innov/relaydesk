import { describe, expect, it } from "vitest";
import { buildCalendarWorkspace } from "../src/shared/calendar";
import type { Account, CalendarEvent, Snapshot, Source } from "../src/shared/contracts";
import type { BrowserCalendarItem } from "../src/shared/browser";

const now = new Date("2026-09-23T07:00:00Z");
const account: Account = { id: "a", provider: "gmail", name: "Work", email: "work@example.test", status: "connected", consent: true, aiEnabled: false };
const source: Source = { id: "s", accountId: "a", providerId: "primary", name: "Calendar", kind: "calendar", selected: true };
const api = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "api", accountId: "a", sourceId: "s", providerId: "provider-event", title: "Planning",
  start: "2026-09-23T09:00:00Z", end: "2026-09-23T10:00:00Z", timeZone: "UTC",
  allDay: false, attendees: [], location: "", description: "", revision: "1", url: "", ...patch,
});
const browser = (patch: Partial<BrowserCalendarItem> = {}): BrowserCalendarItem => ({
  id: "browser", accountId: "a", sourceId: "s", title: "9am to 10am, Project review, September 23, 2026",
  whenText: "9am to 10am, Project review, September 23, 2026", description: "", location: "",
  url: "", capturedAt: now.toISOString(), ...patch,
});
const data = (patch: Partial<Pick<Snapshot, "accounts" | "sources" | "events" | "browserItems">> = {}) => ({
  accounts: [account], sources: [source], events: [], browserItems: [], ...patch,
});
const workspace = (patch: Parameters<typeof data>[0]) => buildCalendarWorkspace(data(patch), { now });

describe("calendar presentation", () => {
  it("extracts accessible-label titles, preserves raw evidence and leaves capture unchanged", () => {
    const item = browser();
    const before = JSON.stringify(item);
    const entry = workspace({ browserItems: [item] }).entries[0];
    expect(entry).toMatchObject({ title: "Project review", dateKey: "2026-09-23", timeLabel: "9am to 10am", timing: "display" });
    expect(entry.whenLabel).toContain("Time zone unverified");
    expect(entry.original).toBe(item);
    expect(JSON.stringify(item)).toBe(before);
  });

  it.each([
    ["9am to 10am, Product, design, and review, September 23, 2026", "Product, design, and review", "2026-09-23"],
    ["14h00 à 15h30, Réunion client, équipe France, 23 septembre 2026", "Réunion client, équipe France", "2026-09-23"],
    ["14:00 – 15:30, Entretien, suivi, 23 février 2028", "Entretien, suivi", "2028-02-23"],
    ["\u200e9\u202fam to 10\u00a0am, Project review, September 23, 2026", "Project review", "2026-09-23"],
  ])("normalizes English/French labels without splitting title commas: %s", (label, title, dateKey) => {
    expect(workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0]).toMatchObject({ title, dateKey });
  });

  it("handles nested grid lines without inventing a date or year", () => {
    const entry = workspace({ browserItems: [browser({ title: "9am\nProject review", whenText: "9am\nProject review" })] }).entries[0];
    expect(entry).toMatchObject({ title: "Project review", timeLabel: "9am", timing: "unknown" });
    expect(entry.dateKey).toBeUndefined();
  });

  it.each([
    ["9am to 10am\nProject review, roadmap\nSeptember 23, 2026", "Project review, roadmap"],
    ["09:00 – 10:00\r\nProject review\r\nWednesday, September 23, 2026", "Project review"],
    ["14h00 à 15h30\nRéunion client, équipe France\nmercredi 23 septembre 2026", "Réunion client, équipe France"],
  ])("separates full newline grid labels into title/date/time: %s", (label, title) => {
    const result = workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0];
    expect(result).toMatchObject({ title, dateKey: "2026-09-23", timing: "display" });
    expect(result.timeLabel).not.toContain("review");
    expect((result.original as BrowserCalendarItem).whenText).toBe(label);
  });

  it.each([
    ["2pm to 2:30pm, Project review, Work account, accepted, Main calendar, September 23, 2026\nProject review\n, \n2pm", "Project review"],
    ["2:15pm to 2:45pm, Product, design review, Work account, accepted, Main calendar, September 23, 2026\nProduct, design review\n2:15 – 2:45pm", "Product, design review"],
    ["14h00 à 15h00, Réunion client, Compte travail, accepté, Calendrier principal, 23 septembre 2026\nRéunion client\n14h00", "Réunion client"],
  ])("uses repeated visible-title evidence to remove accessible-label metadata: %s", (label, title) => {
    const result = workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0];
    expect(result).toMatchObject({ title, dateKey: "2026-09-23", timing: "display" });
    expect((result.original as BrowserCalendarItem).title).toBe(label);
  });

  it("does not treat an unrelated appended detail as the title", () => {
    const label = "2pm to 3pm, Product review, Work account, September 23, 2026\nUnrelated detail";
    const result = workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0];
    expect(result.title).toContain("Product review");
    expect(result.title).not.toBe("Unrelated detail");
    expect(result.dateKey).toBe("2026-09-23");
  });

  it.each(["9am to 10am, Planning, September 23", "9am to 10am, Planning, February 30, 2026", "Planning, 23/09/2026", "Planning, 2026-13-01"])(
    "keeps missing-year, ambiguous or invalid dates uncertain: %s", label => {
      expect(workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0].dateKey).toBeUndefined();
    },
  );

  it("does not split ordinary comma-separated titles or descriptions", () => {
    const entry = workspace({ browserItems: [browser({ title: "Roadmap, design, planning", whenText: "", description: "Discuss A, B, and C" })] }).entries[0];
    expect(entry.title).toBe("Roadmap, design, planning");
    expect(entry.description).toBe("Discuss A, B, and C");
  });

  it("does not turn inconsistent dates into one certain date", () => {
    const label = "9am to 10am, Review, September 23, 2026 – September 24, 2026";
    expect(workspace({ browserItems: [browser({ title: label, whenText: label })] }).entries[0].dateKey).toBeUndefined();
  });

  it("uses device-local dates and times for explicit API instants", () => {
    const event = api({ start: "2026-09-23T00:30:00+14:00", end: "2026-09-23T01:30:00+14:00" });
    const entry = buildCalendarWorkspace(data({ events: [event] }), { now, includePast: true }).entries[0];
    const date = new Date(event.start);
    expect(entry.dateKey).toBe(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
    expect(entry.timeLabel.startsWith(`${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`)).toBe(true);
    expect(entry.timing).toBe("exact");
  });

  it("keeps all-day dates zone-independent and respects exclusive end", () => {
    const event = api({ allDay: true, start: "2026-09-22", end: "2026-09-24", timeZone: "Pacific/Honolulu" });
    const entry = workspace({ events: [event] }).entries[0];
    expect(entry).toMatchObject({ dateKey: "2026-09-22", endDateKey: "2026-09-23", timeLabel: "All day", timing: "exact" });
    expect(workspace({ events: [api({ ...event, end: "2026-09-23" })] }).entries).toHaveLength(0);
  });

  it.each([
    ["2026-02-30T09:00:00Z", "2026-02-30T10:00:00Z"],
    ["2026-09-23T09:00:00", "2026-09-23T10:00:00"],
    ["2026-09-23T10:00:00Z", "2026-09-23T09:00:00Z"],
  ])("does not silently repair invalid or unzoned API intervals", (start, end) => {
    const result = workspace({ events: [api({ start, end })] });
    expect(result.entries[0].timing).toBe("unknown");
    expect(result.conflicts).toEqual([]);
  });

  it("supports exact browser ISO ranges only when both offsets are explicit", () => {
    const result = workspace({ browserItems: [browser({ title: "Planning", whenText: "2026-09-23T09:00:00Z / 2026-09-23T10:00:00Z" })] });
    expect(result.entries[0]).toMatchObject({ timing: "exact", soon: true, title: "Planning" });
  });

  it("filters past browser dates but retains undated or today's unzoned captures", () => {
    const items = [
      browser({ id: "past", title: "Old", whenText: "9am to 10am, Review, September 22, 2026" }),
      browser({ id: "unknown", title: "Unknown", whenText: "Yesterday" }),
      browser({ id: "today", title: "Today", whenText: "1am to 2am, Review, September 23, 2026" }),
    ];
    expect(workspace({ browserItems: items }).entries.map(entry => entry.id)).toEqual(["today", "unknown"]);
    expect(buildCalendarWorkspace(data({ browserItems: items }), { now, includePast: true }).entries).toHaveLength(3);
  });

  it("sorts known days and wall times before undated events independently of input order", () => {
    const items = [
      browser({ id: "late", whenText: "14:00 to 15:00, Review, September 23, 2026" }),
      browser({ id: "unknown", title: "Untimed", whenText: "" }),
      browser({ id: "early" }),
    ];
    const result = workspace({ browserItems: items }).entries.map(entry => entry.key);
    expect(result).toEqual(workspace({ browserItems: [...items].reverse() }).entries.map(entry => entry.key));
    expect(workspace({ browserItems: items }).entries.map(entry => entry.id)).toEqual(["early", "late", "unknown"]);
  });
});

describe("calendar visibility and insights", () => {
  it("ignores connector cancellation markers but keeps read-only invitations", () => {
    const result = workspace({ events: [
      api({ id: "cancelled", writable: false, title: "(Cancelled) Client review" }),
      api({ id: "invitation", writable: false, title: "Client review" }),
    ] });
    expect(result.entries.map(entry => entry.id)).toEqual(["invitation"]);
    expect(result.conflicts).toEqual([]);
  });

  it("requires selected calendar source, connected account and read consent but not AI", () => {
    expect(workspace({ events: [api()], browserItems: [browser()] }).entries).toHaveLength(2);
    for (const patch of [
      { accounts: [{ ...account, status: "disconnected" as const }] },
      { accounts: [{ ...account, consent: false }] },
      { sources: [{ ...source, selected: false }] },
      { sources: [{ ...source, kind: "mail" as const }] },
      { sources: [{ ...source, accountId: "someone-else" }] },
    ]) expect(workspace({ ...patch, events: [api()], browserItems: [browser()] }).entries).toEqual([]);
  });

  it("applies source and search filters to both capture kinds before counting insights", () => {
    const input = data({ sources: [source, { ...source, id: "s2" }], events: [api({ title: "Client review" })],
      browserItems: [browser({ sourceId: "s2", title: "Client review", whenText: "" })] });
    expect(buildCalendarWorkspace(input, { now, sourceId: "s2", search: "client" }).entries.map(entry => entry.kind)).toEqual(["browser"]);
    expect(buildCalendarWorkspace(input, { now, sourceId: "missing" }).stats.events).toBe(0);
    expect(buildCalendarWorkspace(input, { now, search: "no match" }).stats.important).toBe(0);
  });

  it("confirms overlapping instants across accounts but not touching endpoints or all-day events", () => {
    const result = workspace({
      accounts: [account, { ...account, id: "b" }], sources: [source, { ...source, id: "s2", accountId: "b" }],
      events: [
        api(), api({ id: "overlap", sourceId: "s2", accountId: "b", start: "2026-09-23T09:30:00Z", end: "2026-09-23T10:00:00Z" }),
        api({ id: "touch", start: "2026-09-23T10:00:00Z", end: "2026-09-23T11:00:00Z" }),
        api({ id: "day", allDay: true, start: "2026-09-23", end: "2026-09-24" }),
      ],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe("confirmed");
    expect(result.entries.filter(entry => entry.conflictKeys.length)).toHaveLength(2);
  });

  it("offers possible browser overlaps within one account, never confirmed or cross-account", () => {
    const result = workspace({
      accounts: [account, { ...account, id: "b" }], sources: [source, { ...source, id: "s2", accountId: "b" }],
      events: [api()],
      browserItems: [
        browser(),
        browser({ id: "overlap", whenText: "09:30 – 10:00, Meeting, 23 septembre 2026" }),
        browser({ id: "touch", whenText: "10:00 – 11:00, Meeting, 23 septembre 2026" }),
        browser({ id: "other-account", accountId: "b", sourceId: "s2" }),
      ],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: "possible" });
    expect(result.conflicts[0].reason).toContain("time zones");
  });

  it("does not infer overnight intervals, or conflicts for all-day browser events", () => {
    const result = workspace({ browserItems: [
      browser(), browser({ id: "night", whenText: "11pm to 1am, Meeting, September 23, 2026" }),
      browser({ id: "day", title: "All day, Holiday, September 23, 2026", whenText: "All day, Holiday, September 23, 2026" }),
    ] });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.find(entry => entry.id === "day")).toMatchObject({ title: "Holiday", allDay: true });
  });

  it("does not infer missing AM/PM markers from another endpoint", () => {
    const result = workspace({ browserItems: [
      browser({ title: "1 to 2pm, Review, September 23, 2026", whenText: "1 to 2pm, Review, September 23, 2026" }),
      browser({ id: "morning", title: "Review", whenText: "9am to 10am, Review, September 23, 2026" }),
    ] });
    expect(result.conflicts).toEqual([]);
  });

  it("does not deduplicate different calendars based on matching titles or times", () => {
    const result = workspace({ sources: [source, { ...source, id: "personal" }],
      events: [api(), api({ sourceId: "personal" })] });
    expect(result.entries).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
  });

  it("uses transparent title keywords, not descriptions or fabricated priority", () => {
    const result = workspace({ events: [
      api({ id: "client", title: "Client review" }), api({ id: "entretien", title: "Entretien de recrutement" }),
      api({ id: "ordinary", title: "Planning", description: "medical client deadline" }),
    ] });
    expect(result.stats.important).toBe(2);
    expect(result.entries.find(entry => entry.id === "client")?.importance?.reason).toContain("“client”");
    expect(result.entries.find(entry => entry.id === "ordinary")?.importance).toBeUndefined();
  });

  it("reports visible busy-day coverage and stale/partial browser captures", () => {
    const result = workspace({ browserItems: Array.from({ length: 5 }, (_, index) => browser({ id: String(index), capturedAt: "2026-09-01T09:00:00Z" })) });
    expect(result.busyDateKeys).toEqual(["2026-09-23"]);
    expect(result.stats).toMatchObject({ events: 5, busyDays: 1, uncertain: 5 });
    expect(result.warnings.join(" ")).toMatch(/only visible.*incomplete/);
    expect(result.warnings.join(" ")).toContain("older than 24 hours");
  });
});
