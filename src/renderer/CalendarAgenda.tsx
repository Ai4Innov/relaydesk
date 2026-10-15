import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, ExternalLink, RefreshCw, Search, Star } from "lucide-react";
import type { CalendarEvent, Command, CommandResult, Snapshot } from "../shared/contracts";
import { buildCalendarWorkspace, type CalendarEntry } from "../shared/calendar";
import "./calendar.css";

type Lens = "all" | "conflicts" | "important" | "uncertain";
interface Props {
  data: Snapshot;
  busy: boolean;
  run(command: Command, success?: string): Promise<CommandResult | undefined>;
  onEdit(event: CalendarEvent): void;
  editableSources: string[];
}
const localKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const fromKey = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const dateHeading = (key: string) => fromKey(key).toLocaleDateString(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric"
});
export function calendarEntryOnDay(entry: Pick<CalendarEntry, "dateKey" | "original">, key: string): boolean {
  if (entry.dateKey === key) return true;
  if (!("start" in entry.original)) return false;
  const event = entry.original;
  if (event.allDay) return event.start <= key && event.end > key;
  const start = fromKey(key);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return Date.parse(event.start) < end.getTime() && Date.parse(event.end) > start.getTime();
}

export function CalendarAgenda({ data, busy, run, onEdit, editableSources }: Props) {
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [includePast, setIncludePast] = useState(false);
  const [lens, setLens] = useState<Lens>("all");
  const [selectedDay, setSelectedDay] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const workspace = useMemo(() => buildCalendarWorkspace(data, {
    sourceId: source || undefined, search: query, includePast
  }), [data, source, query, includePast]);
  const sources = data.sources.filter(item => item.kind === "calendar" && item.selected &&
    data.accounts.some(account => account.id === item.accountId && account.consent && account.status === "connected"));
  const sourceLabel = (sourceId: string) => {
    const calendar = data.sources.find(item => item.id === sourceId);
    const account = data.accounts.find(item => item.id === calendar?.accountId);
    return `${account?.email || account?.name || "Unknown account"} · ${calendar?.name || "Calendar"} · ${account?.connection === "browser" ? "Browser" : "API"}`;
  };
  const conflictKeys = new Set(workspace.conflicts.flatMap(conflict => conflict.entryKeys));
  const matchesLens = (entry: CalendarEntry) => lens === "all" ||
    (lens === "conflicts" && conflictKeys.has(entry.key)) ||
    (lens === "important" && !!entry.importance) ||
    (lens === "uncertain" && entry.timing !== "exact");
  const entries = workspace.entries.filter(entry => matchesLens(entry) && (!selectedDay || calendarEntryOnDay(entry, selectedDay)));
  const groups = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const key = selectedDay || entry.dateKey || "";
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  const today = localKey(new Date());
  const monday = new Date();
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return { date, key: localKey(date) };
  });
  const counts = new Map<string, number>();
  for (const entry of workspace.entries) if (entry.dateKey) counts.set(entry.dateKey, (counts.get(entry.dateKey) || 0) + 1);
  const busyDays = [...counts].filter(([, count]) => count >= 5);
  const important = workspace.entries.filter(entry => entry.importance);
  const uncertain = workspace.entries.filter(entry => entry.timing !== "exact");
  const showLens = (value: Lens) => { setLens(value); setSelectedDay(""); };
  const displayedKeys = new Set(entries.map(entry => entry.key));
  const conflicts = workspace.conflicts.filter(conflict => conflict.entryKeys.some(key => displayedKeys.has(key)));
  const confirmedCount = workspace.conflicts.filter(conflict => conflict.kind === "confirmed").length;

  return <section className="calendar-workspace" aria-label="Calendar agenda and insights">
    <div className="calendar-controls card">
      <div className="calendar-filter-row">
        <label className="calendar-search"><Search size={16}/><span className="sr-only">Search calendar</span><input aria-label="Search calendar" placeholder="Search titles, places, or details" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <label className="calendar-source-select"><span className="sr-only">Calendar filter</span><select aria-label="Calendar filter" value={source} onChange={event => { setSource(event.target.value); setSelectedDay(""); }}><option value="">All selected calendars</option>{sources.map(item => <option value={item.id} key={item.id}>{sourceLabel(item.id)}</option>)}</select></label>
        <button className="secondary small" disabled={busy} onClick={() => void run({ type: "refresh.request" })}><RefreshCw size={14}/>Refresh calendars</button>
      </div>
      <div className="calendar-coverage"><label className="checkbox-label"><input type="checkbox" checked={includePast} onChange={event => setIncludePast(event.target.checked)}/>Include past events</label><span>API times: {zone}. Browser times: as displayed in Google Calendar.</span></div>
    </div>

    <div className="calendar-insight-grid" aria-label="Calendar insights">
      <button className={`calendar-insight ${lens === "conflicts" ? "selected" : ""}`} onClick={() => showLens("conflicts")}><span className="calendar-insight-icon amber"><AlertTriangle size={18}/></span><strong>{workspace.conflicts.length}</strong><span>Overlaps to review</span><small>{confirmedCount} confirmed · {workspace.conflicts.length - confirmedCount} possible</small></button>
      <button className={`calendar-insight ${lens === "important" ? "selected" : ""}`} onClick={() => showLens("important")}><span className="calendar-insight-icon rose"><Star size={18}/></span><strong>{important.length}</strong><span>Worth preparing for</span><small>Suggested from event titles · inspect reasons</small></button>
      <button className="calendar-insight" onClick={() => { setLens("all"); setSelectedDay(busyDays[0]?.[0] || ""); }}><span className="calendar-insight-icon teal"><CalendarDays size={18}/></span><strong>{busyDays.length}</strong><span>Busy days</span><small>5+ visible entries, not confirmed busy hours</small></button>
      <button className={`calendar-insight ${lens === "uncertain" ? "selected" : ""}`} onClick={() => showLens("uncertain")}><span className="calendar-insight-icon"><Clock3 size={18}/></span><strong>{uncertain.length}</strong><span>Time needs verification</span><small>Incomplete date or unverified time zone</small></button>
    </div>

    <section className="calendar-week card" aria-label="Week overview">
      <div className="calendar-week-heading"><div><strong>{monday.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong><span className="caption">Choose a day to narrow the agenda</span></div><div className="button-row"><button className="icon-button" aria-label="Previous week" onClick={() => setWeekOffset(value => value - 1)}><ArrowLeft size={15}/></button><button className="quiet small" onClick={() => { setWeekOffset(0); setSelectedDay(""); }}>This week</button><button className="icon-button" aria-label="Next week" onClick={() => setWeekOffset(value => value + 1)}><ArrowRight size={15}/></button></div></div>
      <div className="calendar-week-days">{days.map(({ date, key }) => <button className={`calendar-day ${selectedDay === key ? "selected" : ""} ${today === key ? "today" : ""}`} key={key} aria-label={`Show ${dateHeading(key)}`} aria-pressed={selectedDay === key} onClick={() => setSelectedDay(selectedDay === key ? "" : key)}><span>{date.toLocaleDateString(undefined, { weekday: "short" })}</span><strong>{date.getDate()}</strong><small>{workspace.entries.filter(entry => calendarEntryOnDay(entry, key)).length} events</small></button>)}</div>
    </section>

    <div className="calendar-view-bar"><div className="calendar-lenses" role="group" aria-label="Agenda focus">{(["all", "conflicts", "important", "uncertain"] as const).map(value => <button key={value} className={lens === value ? "selected" : ""} aria-pressed={lens === value} onClick={() => showLens(value)}>{({ all: "All events", conflicts: "Overlaps", important: "Important", uncertain: "Verify time" })[value]}</button>)}</div><span className="caption">{entries.length} visible {entries.length === 1 ? "entry" : "entries"}</span>{selectedDay && <button className="text-button" onClick={() => setSelectedDay("")}>Clear day filter</button>}</div>

    {!!conflicts.length && <section className="calendar-alerts" aria-label="Scheduling overlaps">{conflicts.slice(0, 10).map(conflict => <article key={conflict.id}><AlertTriangle size={17}/><div><strong>{conflict.kind === "confirmed" ? "Time conflict" : "Possible overlap — verify times"}</strong><p>{conflict.entryKeys.map(key => workspace.entries.find(entry => entry.key === key)?.title || "Calendar entry").join(" ↔ ")}</p><small>{conflict.reason}</small></div></article>)}{conflicts.length > 10 && <p className="caption">{conflicts.length - 10} more overlap pairs. Narrow the calendar or date to review them.</p>}</section>}

    {!entries.length && <div className="card calendar-empty"><CalendarDays size={32}/><h2>{lens === "all" ? "No events in this view" : "No matching insights"}</h2><p>{source || query || selectedDay || lens !== "all" ? "Try a different calendar, clear the search or day filter, or show all events." : "Select a calendar in Settings and open it in your paired browser. Include past events to see older captures."}</p></div>}
    {[...groups].sort(([left], [right]) => !left ? 1 : !right ? -1 : left.localeCompare(right)).map(([day, items]) =>
      <section key={day || "unplaced"} className="calendar-date-group" aria-label={day ? dateHeading(day) : "Date not confirmed"}>
        <div className="calendar-date-heading"><h2>{day ? dateHeading(day) : "Date not confirmed"}</h2>{day === today && <span className="badge teal">Today</span>}<span className="caption">{items.length} {items.length === 1 ? "entry" : "entries"}</span>{(counts.get(day) || 0) >= 5 && <span className="badge amber">Busy day</span>}</div>
        {!day && <p className="caption">These entries do not contain a complete, reliable date. They are kept separate instead of being assigned to today.</p>}
        <div className="calendar-event-list">{items.map(entry => {
          const accountIndex = data.accounts.findIndex(account => account.id === entry.accountId);
          const itemConflicts = workspace.conflicts.filter(conflict => conflict.entryKeys.includes(entry.key));
          const browserItem = "whenText" in entry.original ? entry.original : undefined;
          const apiEvent = "start" in entry.original ? entry.original : undefined;
          const canEdit = !!apiEvent && !apiEvent.recurring && apiEvent.writable !== false && editableSources.includes(apiEvent.sourceId);
          return <article key={entry.key} className="calendar-event-card card" data-tone={Math.max(accountIndex, 0) % 5}>
            <div className="calendar-event-clock"><Clock3 size={15}/><strong>{entry.allDay ? "All day" : entry.timeLabel || "Time not confirmed"}</strong><span>{entry.timing === "exact" ? entry.allDay ? "Date only" : zone : "Browser display"}</span></div>
            <div className="calendar-event-content"><div className="calendar-event-title"><h3>{entry.title}</h3>{entry.importance && <span className="badge rose"><Star size={11}/>Important suggestion</span>}{itemConflicts.length > 0 && <span className="badge amber">{itemConflicts.some(conflict => conflict.kind === "confirmed") ? "Conflict" : "Possible overlap"}</span>}</div>
              <p className="calendar-event-source"><span className="calendar-account-dot"/>{sourceLabel(entry.sourceId)}</p>
              <p className="calendar-event-when">{entry.whenLabel || "Open the original calendar to verify the date and time."}</p>
              {entry.importance && <p className="calendar-importance-reason"><Star size={12}/>{entry.importance.reason}</p>}
              {entry.location && <p className="calendar-event-location">{entry.location}</p>}
              {entry.timing !== "exact" && <p className="calendar-time-warning"><Clock3 size={12}/>{entry.timing === "display" ? "Date/time read from display text; calendar time zone is not verified." : "Exact date or time unavailable. Not used for confirmed conflict detection."}</p>}
              <div className="calendar-event-actions">{browserItem && <><button className="text-button" onClick={() => void run({ type: "browser.meeting", itemId: entry.id })}>{browserItem.meetingUrl ? "Open meeting" : "Open in Google Calendar"}<ExternalLink size={12}/></button>{browserItem.meetingUrl && <button className="text-button" onClick={() => void run({ type: "browser.open", kind: "calendar", accountId: entry.accountId })}>Open calendar</button>}</>}{apiEvent && <button className="text-button" disabled={busy || !canEdit} onClick={() => onEdit(apiEvent)}>Propose a change<ArrowRight size={12}/></button>}<details><summary>Event details</summary>{entry.description && <p className="plain-body">{entry.description}</p>}{apiEvent?.attendees.length ? <p className="plain-body">Attendees: {apiEvent.attendees.join(", ")}</p> : null}{apiEvent?.recurring && <p>Recurring event. Edit the occurrence or series in your original calendar.</p>}{apiEvent && <p>Event time zone: {apiEvent.timeZone}. {apiEvent.allDay ? "End date is exclusive." : ""}</p>}{browserItem && <><p className="caption">Original captured label</p><p className="plain-body calendar-original-label">{browserItem.whenText}</p><p className="caption">Captured {new Date(browserItem.capturedAt).toLocaleString()}. A capture may be stale or missing cancellations; verify at the source.</p></>}</details></div>
            </div>
          </article>;
        })}</div>
      </section>
    )}
    <aside className="calendar-footnote"><Check size={15}/><div>Insights are calculated locally from selected imported entries, not full attendee availability. Important-event flags are keyword suggestions, not AI judgments. All-day entries are not assumed to block your working hours.{workspace.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></aside>
  </section>;
}
