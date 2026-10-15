import { ArrowRight, CalendarDays, FileText, ListChecks } from "lucide-react";

type Fields = Record<string, unknown>;
function isFields(value: unknown): value is Fields { return !!value && typeof value === "object" && !Array.isArray(value); }
const labels: Record<string, string> = {
  type: "Operation", itemId: "Captured event ID", expectedRevision: "Expected revision", eventId: "Event ID",
  eventTitle: "Event", accountEmail: "Account", accountId: "Account ID", sourceId: "Source ID",
  currentWhen: "Current time", newDate: "New date", date: "Date", startTime: "Start time", endTime: "End time",
  start: "Start", end: "End", timeZone: "Time zone", timezone: "Time zone",
  attendeeEffect: "Attendee notification", attendees: "Attendees", recurring: "Recurring event",
  effect: "Calendar and attendee effect",
  to: "To", cc: "Cc", bcc: "Bcc", subject: "Subject", body: "Body", text: "Text",
  title: "Title", description: "Description", dueAt: "Due", dueDate: "Due date", priority: "Priority",
  messageId: "Source message ID", draftId: "Draft ID", taskId: "Task ID", status: "Status",
};
function label(key: string) { return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, character => character.toUpperCase()); }
function text(value: unknown): string {
  if (value === null) return "Not set";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === "") return "(empty)";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}
function FieldValue({ value, depth }: { value: unknown; depth: number }) {
  if (depth > 5) return <pre className="chat-field-raw">{text(value)}</pre>;
  if (Array.isArray(value)) return value.length ? <ul className="chat-field-list">{value.map((item, index) => <li key={index}><FieldValue value={item} depth={depth + 1}/></li>)}</ul> : <span>None</span>;
  if (isFields(value)) return Object.keys(value).length ? <FieldList fields={value} depth={depth + 1}/> : <span>None</span>;
  return <span>{text(value)}</span>;
}
function FieldList({ fields, depth = 0 }: { fields: Fields; depth?: number }) {
  return <dl className="chat-action-fields">{Object.entries(fields).map(([key, value]) => <div className="chat-action-field" key={key}>
    <dt title={key}>{label(key)}</dt><dd><FieldValue value={value} depth={depth}/></dd>
  </div>)}</dl>;
}

export function ActionPreview({ preview }: { preview: string }) {
  let parsed: unknown;
  try { parsed = JSON.parse(preview); } catch { /* Older saved previews are plain text. */ }
  if (!isFields(parsed)) return <><div className="chat-preview-label">Exact action preview</div><pre className="chat-action-preview">{preview}</pre></>;
  const command = isFields(parsed.command) ? parsed.command : parsed;
  const review = isFields(parsed.review) ? parsed.review : undefined;
  const operation = typeof command.type === "string" ? command.type : "";
  const calendar = operation.includes("calendar");
  const draft = operation.includes("draft");
  const Icon = calendar ? CalendarDays : draft ? FileText : ListChecks;
  const before = review?.currentWhen;
  const after = [command.newDate ?? command.date, command.startTime, command.endTime].filter(value => typeof value === "string").join(" · ");
  return <div className="chat-preview">
    <div className="chat-preview-kind"><Icon size={15}/><span>{calendar ? "Calendar change" : draft ? "Draft · not sent" : operation.startsWith("task.") ? "Task update" : "Action details"}</span><code>{operation}</code></div>
    {calendar && (before || after) ? <div className="chat-calendar-change">
      <div><span>Before</span><strong>{typeof before === "string" ? before : "See review context"}</strong></div><ArrowRight size={17} aria-label="changes to"/>
      <div><span>After</span><strong>{after || "See requested change"}</strong></div>
    </div> : null}
    {isFields(parsed.command) ? <>
      <h4>Requested change</h4><FieldList fields={command}/>
      {Object.entries(parsed).filter(([key]) => key !== "command").map(([key, value]) => <section className="chat-preview-section" key={key}><h4>{key === "review" ? "Review context" : label(key)}</h4><FieldValue value={value} depth={0}/></section>)}
    </> : <FieldList fields={command}/>}
    <details className="chat-payload"><summary>Exact action payload</summary><pre className="chat-action-preview">{preview}</pre></details>
  </div>;
}
