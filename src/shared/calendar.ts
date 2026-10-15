import type { BrowserCalendarItem } from "./browser";
import type { CalendarEvent, Snapshot } from "./contracts";

export interface CalendarEntry {
  key: string;
  id: string;
  kind: "api" | "browser";
  accountId: string;
  sourceId: string;
  title: string;
  description: string;
  location: string;
  dateKey?: string;
  endDateKey?: string;
  whenLabel: string;
  timeLabel: string;
  allDay: boolean;
  timeZone?: string;
  timing: "exact" | "display" | "unknown";
  capturedAt?: string;
  importance?: { label: string; reason: string };
  soon: boolean;
  conflictKeys: string[];
  original: CalendarEvent | BrowserCalendarItem;
}

interface CalendarConflict {
  id: string;
  kind: "confirmed" | "possible";
  entryKeys: string[];
  reason: string;
}

interface CalendarWorkspace {
  entries: CalendarEntry[];
  conflicts: CalendarConflict[];
  warnings: string[];
  busyDateKeys: string[];
  stats: { events: number; conflicts: number; important: number; uncertain: number; busyDays: number };
}

interface CalendarOptions {
  now?: Date;
  sourceId?: string;
  includePast?: boolean;
  search?: string;
}

interface Normalized {
  entry: CalendarEntry;
  start?: number;
  end?: number;
  wallStart?: number;
  wallEnd?: number;
}

const clean = (value: string) => value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/gu, " ").trim();
const fold = (value: string) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const pad = (value: number) => String(value).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

function validDate(year: number, month: number, day: number): string | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${pad(month)}-${pad(day)}` : undefined;
}

function dateOnly(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? validDate(+match[1], +match[2], +match[3]) : undefined;
}

// Only explicit offsets are instants; locale strings and unzoned wall times are not.
function instant(value: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match || !dateOnly(match[1]) || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59
    || +(match[6] || 0) > 23 || +(match[7] || 0) > 59) return;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

const monthNames = [
  ["january", "jan", "janvier", "janv"], ["february", "feb", "fevrier", "fevr"],
  ["march", "mar", "mars"], ["april", "apr", "avril", "avr"], ["may", "mai"],
  ["june", "jun", "juin"], ["july", "jul", "juillet", "juil"],
  ["august", "aug", "aout"], ["september", "sep", "sept", "septembre"],
  ["october", "oct", "octobre"], ["november", "nov", "novembre"], ["december", "dec", "decembre"],
];
const months = new Map(monthNames.flatMap((names, index) => names.map(name => [name, index + 1] as const)));
const monthPattern = [...months.keys()].sort((a, b) => b.length - a.length).join("|");
const datePattern = new RegExp(`\\b(?:(\\d{4})-(\\d{2})-(\\d{2})|(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})|(\\d{1,2})(?:er)?\\s+(${monthPattern})\\.?\\s*,?\\s+(\\d{4}))\\b`, "g");

function displayedDates(value: string): Array<{ key: string; index: number; length: number }> {
  const result: Array<{ key: string; index: number; length: number }> = [];
  for (const match of fold(value).matchAll(datePattern)) {
    const key = match[1] ? validDate(+match[1], +match[2], +match[3])
      : match[4] ? validDate(+match[6], months.get(match[4])!, +match[5])
        : validDate(+match[9], months.get(match[8])!, +match[7]);
    if (key) result.push({ key, index: match.index!, length: match[0].length });
  }
  return result;
}

const timeToken = "(?:\\d{1,2}(?::\\d{2}|h\\d{2}|h)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?)";
const leadingTime = new RegExp(`^(${timeToken})(?:\\s*(?:to|à|a|au|[-–—])\\s*(${timeToken}))?(?=\\s*[,\\n]|$)`, "i");

function minutes(value: string): number | undefined {
  const match = /^(\d{1,2})(?:(?::|h)(\d{2})|h)?\s*([ap])\.?m\.?$/i.exec(value)
    || /^(\d{1,2})(?:(?::|h)(\d{2})|h)?$/.exec(value.trim());
  if (!match || +(match[2] || 0) > 59) return;
  let hour = +match[1];
  if (match[3]) {
    if (hour < 1 || hour > 12) return;
    hour = hour % 12 + (match[3].toLowerCase() === "p" ? 12 : 0);
  } else if (hour > 23) return;
  return hour * 60 + +(match[2] || 0);
}

function timePrefix(value: string): { text: string; start: number; end?: number; length: number } | undefined {
  const match = leadingTime.exec(value);
  if (!match) return;
  // A bare number is too ambiguous to be a time in a captured title.
  if (!/[:hmap]/i.test(match[1]) && !match[2]) return;
  const start = minutes(match[1].trim());
  const end = match[2] ? minutes(match[2].trim()) : undefined;
  if (start === undefined || (match[2] && end === undefined)) return;
  const mixedMeridiem = !!match[2] && /[ap]\.?m/i.test(match[1]) !== /[ap]\.?m/i.test(match[2]);
  return { text: clean(match[0]), start, end: !mixedMeridiem && end !== undefined && end > start ? end : undefined, length: match[0].length };
}

function base(original: CalendarEvent | BrowserCalendarItem, kind: CalendarEntry["kind"]): CalendarEntry {
  return {
    key: `${kind}:${original.accountId}:${original.sourceId}:${original.id}`,
    id: original.id, kind, accountId: original.accountId, sourceId: original.sourceId,
    title: clean(original.title) || "Untitled event", description: clean(original.description),
    location: clean(original.location), whenLabel: "Date and time need confirmation",
    timeLabel: "Time unverified", allDay: false, timing: "unknown", soon: false,
    conflictKeys: [], original,
  };
}

function normalizeApi(event: CalendarEvent): Normalized {
  const entry = base(event, "api");
  entry.allDay = event.allDay;
  entry.timeZone = event.timeZone || undefined;
  if (event.allDay) {
    entry.timeLabel = "All day";
    const start = dateOnly(event.start);
    const end = dateOnly(event.end);
    if (start && end && end > start) {
      entry.dateKey = start;
      entry.endDateKey = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      entry.whenLabel = `${start}${entry.endDateKey !== start ? ` – ${entry.endDateKey}` : ""} · All day`;
      entry.timing = "exact";
    }
    return { entry };
  }
  const start = instant(event.start);
  const end = instant(event.end);
  if (start !== undefined && end !== undefined && end > start) {
    entry.dateKey = localDate(new Date(start));
    entry.timeLabel = `${clock(new Date(start))} – ${localDate(new Date(end)) !== entry.dateKey ? `${localDate(new Date(end))} ` : ""}${clock(new Date(end))}`;
    entry.whenLabel = `${entry.dateKey} · ${entry.timeLabel}`;
    entry.timing = "exact";
    return { entry, start, end };
  }
  entry.whenLabel = clean(`${event.start} – ${event.end}`) || entry.whenLabel;
  return { entry };
}

function normalizeBrowser(item: BrowserCalendarItem): Normalized {
  const entry = base(item, "browser");
  entry.capturedAt = item.capturedAt;
  const rawTitle = item.title.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  const titlePrefix = timePrefix(rawTitle);
  let title = titlePrefix ? rawTitle.slice(titlePrefix.length).replace(/^[,\s]+/, "") : rawTitle;
  const dateMatches = [...displayedDates(item.whenText), ...displayedDates(item.title)];
  const uniqueDates = [...new Set(dateMatches.map(date => date.key))];
  if (uniqueDates.length === 1) entry.dateKey = uniqueDates[0];
  const rawLines = rawTitle.split(/\r?\n/).map(clean).filter(Boolean);
  if (titlePrefix && rawLines.length > 1 && displayedDates(rawLines[0]).length) {
    const firstPrefix = timePrefix(rawLines[0]);
    const labelTitle = firstPrefix ? rawLines[0].slice(firstPrefix.length).replace(/^[,\s]+/, "") : "";
    // Grid chips sometimes append a visible title after the complete accessible label.
    // Its exact prefix match supplies a title boundary without guessing which commas are metadata.
    const repeatedTitle = rawLines.slice(1).filter(line => line !== "," && labelTitle.startsWith(`${line},`))
      .sort((a, b) => b.length - a.length)[0];
    if (repeatedTitle) title = repeatedTitle;
  }
  const titleLines = title.split(/\r?\n/).map(clean).filter(Boolean);
  const lastLine = titleLines.at(-1) || "";
  const lastLineDates = displayedDates(lastLine);
  const finalDate = lastLineDates.length === 1 ? lastLineDates[0] : undefined;
  if (titleLines.length > 1 && finalDate && finalDate.index + finalDate.length === lastLine.length
    && /^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche),?\s*)?$/i
      .test(lastLine.slice(0, finalDate.index))) {
    titleLines.pop();
    title = titleLines.join(" ");
  }
  const titleDates = displayedDates(clean(title));
  const trailingDate = titleDates.at(-1);
  // Only remove a complete, comma-delimited date suffix, preserving commas in event names.
  if (trailingDate && trailingDate.index + trailingDate.length === clean(title).length
    && /,\s*$/.test(clean(title).slice(0, trailingDate.index))) {
    title = clean(title).slice(0, trailingDate.index).replace(/,\s*$/, "");
  }
  entry.title = clean(title) || "Untitled event";
  const prefix = timePrefix(clean(item.whenText)) || titlePrefix;
  const allDay = /^(?:all[- ]day|toute la journ[eé]e|journ[eé]e enti[eè]re)(?=[,\s]|$)/i.exec(clean(item.whenText || item.title));
  entry.allDay = !!allDay;
  if (allDay) {
    entry.timeLabel = "All day";
    entry.title = entry.title.replace(/^(?:all[- ]day|toute la journ[eé]e|journ[eé]e enti[eè]re)[,\s]+/i, "") || "Untitled event";
  } else if (prefix) entry.timeLabel = prefix.text;
  const isoRange = /^(\S+)\s+[-–/]\s+(\S+)$/.exec(clean(item.whenText));
  const start = isoRange ? instant(isoRange[1]) : undefined;
  const end = isoRange ? instant(isoRange[2]) : undefined;
  if (start !== undefined && end !== undefined && end > start) {
    entry.dateKey = localDate(new Date(start));
    entry.timeLabel = `${clock(new Date(start))} – ${localDate(new Date(end)) !== entry.dateKey ? `${localDate(new Date(end))} ` : ""}${clock(new Date(end))}`;
    entry.whenLabel = `${entry.dateKey} · ${entry.timeLabel}`;
    entry.timing = "exact";
    return { entry, start, end };
  }
  entry.timing = entry.dateKey ? "display" : "unknown";
  entry.whenLabel = entry.dateKey
    ? `${entry.dateKey} · ${entry.timeLabel}${entry.allDay ? "" : " · Time zone unverified"}`
    : `${entry.timeLabel} · Date needs confirmation`;
  return { entry, wallStart: prefix?.start, wallEnd: prefix?.end };
}

const importantWords = /\b(client|customer|board|interview|deadline|exam|medical|customers|clients|entretien|echeance|examen|medicale|medecin|conseil d'administration)\b/i;

function compare(a: Normalized, b: Normalized): number {
  const byDate = (a.entry.dateKey || "9999-99-99").localeCompare(b.entry.dateKey || "9999-99-99");
  if (byDate) return byDate;
  const order = (item: Normalized) => item.entry.allDay ? -1
    : item.start !== undefined ? new Date(item.start).getHours() * 60 + new Date(item.start).getMinutes()
      : item.wallStart ?? 1441;
  return order(a) - order(b) || a.entry.title.localeCompare(b.entry.title) || a.entry.key.localeCompare(b.entry.key);
}

/** Local-only presentation: no AI consent, date/year inference, or changes to stored captures. */
export function buildCalendarWorkspace(
  data: Pick<Snapshot, "accounts" | "sources" | "events" | "browserItems">,
  options: CalendarOptions = {},
): CalendarWorkspace {
  const now = options.now ?? new Date();
  const today = localDate(now);
  const accounts = new Set(data.accounts.filter(account => account.status === "connected" && account.consent).map(account => account.id));
  const sources = new Map(data.sources.filter(source => source.kind === "calendar" && source.selected
    && accounts.has(source.accountId) && (!options.sourceId || options.sourceId === "all" || source.id === options.sourceId))
    .map(source => [source.id, source.accountId]));
  const allowed = (item: CalendarEvent | BrowserCalendarItem) => sources.get(item.sourceId) === item.accountId;
  const query = fold(options.search || "");
  const items = [
    // Connectors encode cancellation with both this prefix and writable=false.
    // Read-only invitations alone are still active calendar events.
    ...data.events.filter(event => allowed(event) && !(event.writable === false && event.title.startsWith("(Cancelled) "))).map(normalizeApi),
    ...(data.browserItems || []).filter(allowed).map(normalizeBrowser),
  ].filter(item => {
    if (query && !fold(`${item.entry.title} ${item.entry.description} ${item.entry.location} ${item.entry.whenLabel}`).includes(query)) return false;
    if (options.includePast) return true;
    if (item.end !== undefined) return item.end > now.getTime();
    return !item.entry.dateKey || (item.entry.endDateKey || item.entry.dateKey) >= today;
  }).sort(compare);

  const conflicts: CalendarConflict[] = [];
  const addConflict = (a: Normalized, b: Normalized, kind: CalendarConflict["kind"]) => {
    const entryKeys = [a.entry.key, b.entry.key].sort();
    const id = `${kind}:${JSON.stringify(entryKeys)}`;
    conflicts.push({ id, kind, entryKeys, reason: kind === "confirmed"
      ? "Scheduled times overlap."
      : "Captured times overlap in the same account; time zones and availability are unverified." });
    a.entry.conflictKeys.push(id);
    b.entry.conflictKeys.push(id);
  };
  const groups = new Map<string, Array<{ item: Normalized; start: number; end: number }>>();
  for (const item of items) {
    const match = importantWords.exec(fold(item.entry.title));
    if (match) item.entry.importance = { label: "Important", reason: `Keyword suggestion: “${match[0]}” in the title (not an AI assessment).` };
    item.entry.soon = item.start !== undefined && item.start >= now.getTime() && item.start <= now.getTime() + 86_400_000;
    if (item.entry.allDay) continue;
    const group = item.start !== undefined && item.end !== undefined ? "exact"
      : item.entry.kind === "browser" && item.entry.dateKey && item.wallStart !== undefined && item.wallEnd !== undefined
        ? `display:${item.entry.accountId}:${item.entry.dateKey}` : undefined;
    if (group) {
      const list = groups.get(group) || [];
      list.push({ item, start: item.start ?? item.wallStart!, end: item.end ?? item.wallEnd! });
      groups.set(group, list);
    }
  }
  for (const [group, intervals] of groups) {
    intervals.sort((a, b) => a.start - b.start || a.item.entry.key.localeCompare(b.item.entry.key));
    let active: typeof intervals = [];
    for (const current of intervals) {
      active = active.filter(previous => previous.end > current.start);
      for (const previous of active) addConflict(previous.item, current.item, group === "exact" ? "confirmed" : "possible");
      active.push(current);
    }
  }
  const days = new Map<string, number>();
  for (const { entry } of items) if (entry.dateKey) days.set(entry.dateKey, (days.get(entry.dateKey) || 0) + 1);
  const busyDateKeys = [...days].filter(([, count]) => count >= 5).map(([date]) => date).sort();
  const entries = items.map(item => item.entry);
  const warnings: string[] = [];
  const browser = entries.filter(entry => entry.kind === "browser");
  if (browser.length) warnings.push("Browser captures cover only visible events, may be incomplete, and may duplicate API events. Refresh the calendar to verify.");
  if (browser.some(entry => {
    const captured = instant(entry.capturedAt || "");
    return captured === undefined || now.getTime() - captured > 86_400_000;
  })) warnings.push("Some browser captures are older than 24 hours or have an unverified capture time.");
  if (entries.some(entry => entry.timing !== "exact")) warnings.push("Some dates or time zones are unverified. Possible conflicts are suggestions, not confirmed scheduling conflicts.");
  if (busyDateKeys.length) warnings.push("Busy days have at least five visible events starting that day; this is not a complete availability assessment.");
  return {
    entries, conflicts, warnings, busyDateKeys,
    stats: { events: entries.length, conflicts: conflicts.length, important: entries.filter(entry => entry.importance).length,
      uncertain: entries.filter(entry => entry.timing !== "exact").length, busyDays: busyDateKeys.length },
  };
}
