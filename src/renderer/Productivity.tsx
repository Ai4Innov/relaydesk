import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CalendarDays, Check, CheckCheck, CircleAlert, Clock3, ExternalLink, Plus, Sparkles } from "lucide-react";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";
import { DEFAULT_TASK_REMINDER_MINUTES, type TaskItem, type TaskPriority, type TaskStatus } from "../shared/productivity";
import { formatDate } from "./utils";

type ProductivityProps = {
  data: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
};

type TaskDraft = {
  title: string;
  notes: string;
  priority: TaskPriority;
  dueAt: string;
  status: TaskStatus;
};

type ScheduleDraft = {
  accountId: string;
  sourceId: string;
  title: string;
  description: string;
  location: string;
  timeZone: string;
  allDay: boolean;
  start: string;
  end: string;
  durationMinutes: string;
  reminderMinutes: string;
  privateConfirmed: boolean;
};

const commonTimeZones = ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];

function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="card"><div className="empty"><div className="empty-icon"><CheckCheck size={30}/></div><h3>{title}</h3><div className="muted">{children}</div></div></div>;
}

function citationButtons(task: TaskItem, run: ProductivityProps["run"]): ReactNode {
  if (!task.citations.length) return <p className="caption">Local-only task.</p>;
  return <div className="button-row">{task.citations.map((citation) =>
    <button key={citation.id} className="text-button" onClick={() => void run({ type: "open.message", messageId: citation.messageId })}>
      {citation.title || "Open source"} <ExternalLink size={12}/>
    </button>
  )}</div>;
}

function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timeZoneOptions(selected: string): string[] {
  const supported = (Intl as typeof Intl & { supportedValuesOf?: (kind: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([selected, currentZone(), ...commonTimeZones, ...supported.filter(zone => zone === selected || zone === currentZone())])].filter(Boolean);
}

function formatZonedInput(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function timeZoneOffsetAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value ?? "0");
  const zonedAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return zonedAsUtc - date.getTime();
}

function zonedLocalToIso(local: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const utcGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
  let candidate = new Date(utcGuess);
  let offset = timeZoneOffsetAt(candidate, timeZone);
  candidate = new Date(utcGuess - offset);
  const revisedOffset = timeZoneOffsetAt(candidate, timeZone);
  if (revisedOffset !== offset) {
    offset = revisedOffset;
    candidate = new Date(utcGuess - offset);
  }
  const check = formatZonedInput(candidate.toISOString(), timeZone);
  if (check !== local) return undefined;
  const totalMinutes = offset / 60_000;
  const sign = totalMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(totalMinutes);
  const hours = String(Math.trunc(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${local}:00${sign}${hours}:${minutes}`;
}

function addMinutes(local: string, minutes: number, timeZone: string): string {
  const iso = zonedLocalToIso(local, timeZone);
  if (!iso) return local;
  const date = new Date(Date.parse(iso) + minutes * 60_000);
  return formatZonedInput(date.toISOString(), timeZone);
}

function dueInput(task?: TaskItem): string {
  if (!task?.dueAt) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(task.dueAt) ? task.dueAt : task.dueAt.slice(0, 10);
}

function scheduleTemplate(task: TaskItem | undefined, data: Snapshot): ScheduleDraft {
  const timeZone = task?.schedule?.change.timeZone || currentZone();
  const defaultSource = data.sources.find(source =>
    source.kind === "calendar"
    && data.accounts.some(account => account.id === source.accountId && account.status === "connected" && account.consent && account.connection !== "browser" && !account.demo)
  );
  const sourceId = task?.schedule?.change.sourceId || defaultSource?.id || "";
  const accountId = task?.schedule?.change.accountId || defaultSource?.accountId || "";
  const start = task?.schedule?.change.allDay
    ? task.schedule.change.start
    : task?.schedule?.change.start
      ? formatZonedInput(task.schedule.change.start, timeZone)
      : formatZonedInput(new Date(Date.now() + 60 * 60_000).toISOString(), timeZone);
  const end = task?.schedule?.change.allDay
    ? task.schedule.change.end
    : task?.schedule?.change.end
      ? formatZonedInput(task.schedule.change.end, timeZone)
      : addMinutes(start, 60, timeZone);
  return {
    accountId,
    sourceId,
    title: task?.schedule?.change.title || task?.title || "",
    description: task?.schedule?.change.description || [task?.notes, task?.sourceReason].filter(Boolean).join("\n\n"),
    location: task?.schedule?.change.location || "",
    timeZone,
    allDay: task?.schedule?.change.allDay || false,
    start,
    end,
    durationMinutes: "60",
    reminderMinutes: String(task?.schedule?.reminderMinutes ?? DEFAULT_TASK_REMINDER_MINUTES),
    privateConfirmed: false
  };
}

export function ArchiveReviewPanel({ data, busy, run }: ProductivityProps) {
  const review = data.aiReview;
  const [maxBatches, setMaxBatches] = useState(5);
  const running = review?.status === "running";
  const budget = Math.max(0, data.settings.dailyAiLimit - data.settings.aiRunsToday);
  return <section className="card" aria-label="All local email AI review">
    <div className="section-heading"><h2>Review all local email</h2><Badge tone={review?.remaining ? "amber" : "teal"}>{review?.status ?? "not started"}</Badge></div>
    <p>Scan every eligible email in the local archive, including older and read messages, not just the latest inbox snapshot. Your AI provider proposes editable tasks and batch reports; nothing is sent or scheduled.</p>
    <p className="caption">Only selected mail sources on accounts with explicit AI consent are included. Browser capture cannot see unloaded email; previews cover only captured text. Attachment contents are not part of this scan.</p>
    <div className="button-row" role="status" aria-live="polite">
      <Badge>{review?.totalAvailable ?? data.archive.messages} locally available</Badge>
      <Badge>{review?.totalEligible ?? 0} eligible</Badge>
      <Badge>{review?.reviewed ?? 0} reviewed</Badge>
      <Badge tone="amber">{review?.remaining ?? 0} remaining</Badge>
      <Badge>{review?.excluded ?? 0} excluded</Badge>
      <Badge tone={review?.failures ? "rose" : ""}>{review?.failures ?? 0} failed attempts / {review?.failedMessages ?? 0} unresolved emails</Badge>
    </div>
    <p className="caption">{review?.reviewedChunks ?? 0} / {review?.totalChunks ?? 0} text segments reviewed. Long emails are split without dropping their tail. {review?.previewMessages ?? 0} eligible emails have preview-only coverage.</p>
    {review?.detail && <p role="status">{review.detail}</p>}
    <div className="button-row">
      <label><span className="caption">Maximum sequential batches this start</span><select aria-label="Archive review batch limit" disabled={running || busy} value={maxBatches} onChange={event => setMaxBatches(Number(event.target.value))}>
        {[1, 5, 10, 20].map(value => <option key={value} value={value}>{value} {value === 1 ? "batch" : "batches"}</option>)}
      </select></label>
      <button disabled={busy || running || !review?.totalEligible || !data.settings.model || !budget} onClick={() => void run({ type: "review.start", maxBatches })}>
        <Sparkles size={16}/>{review?.reviewedChunks ? "Resume / scan remaining email" : "Start archive review"}
      </button>
      {running && <><button className="secondary" disabled={busy} onClick={() => void run({ type: "review.pause" })}>Pause review</button><button className="quiet" disabled={busy} onClick={() => void run({ type: "review.cancel" })}>Cancel run</button></>}
    </div>
    <p className="caption">Each batch uses one existing AI run, up to 4 text segments. {budget} local AI runs remain today. Current model: {data.settings.model || "choose in Settings"}. {review?.batchesCompleted ?? 0} / {review?.batchLimit ?? 0} batches completed this start. Pausing cannot refund an in-flight request.</p>
    {review?.updatedAt && <p className="caption">Persisted coverage updated {formatDate(review.updatedAt, true)}. New or changed messages need review again.</p>}
    {!!review?.exclusions.length && <details><summary>Why messages are excluded</summary>{review.exclusions.map(item => <p key={item.reason}>{item.count}: {item.reason}</p>)}</details>}
    <div className="section-heading"><h3>Archive review reports</h3><Badge>{review?.reports.length ?? 0} saved batch reports</Badge></div>
    <p className="caption">Reports describe reviewed segments only, not the unreviewed remainder. Suggestions appear in Tasks &amp; focus and the dashboard. Review evidence before acting; older requests may be resolved.</p>
    {data.focusReport && <div>
      <p><strong>{data.focusReport.metrics.openTasks + data.focusReport.metrics.inProgressTasks} active tasks</strong>, {data.focusReport.metrics.waitingTasks} waiting, {data.focusReport.metrics.completedTasks} completed. Workload: {data.focusReport.metrics.workloadLabel}. Tasks &amp; focus lets you edit every suggestion.</p>
      {data.focusReport.nextActions.map(action => <div className="waiting-item" key={action.taskId}>
        <strong>{action.title}</strong><p>{action.reason}</p>
        <div className="button-row"><Badge>{action.priority}</Badge>
          {action.sourceMessageId && <button className="text-button" onClick={() => void run({ type: "open.message", messageId: action.sourceMessageId! })}>Inspect source <ExternalLink size={12}/></button>}
          <button className="quiet small" disabled={busy} onClick={() => void run({ type: "task.status", taskId: action.taskId, status: "done" })}>Mark task done locally</button>
        </div>
      </div>)}
    </div>}
    {!!review?.reports.length && <details><summary>Read saved reports and source evidence</summary>{review.reports.map(report => <article className="waiting-item" key={report.id}>
      <strong>{formatDate(report.generatedAt, true)}</strong><p className="plain-body">{report.narrative}</p>
      <details><summary>{report.citations.length} source segments</summary>{report.citations.map(citation => <blockquote key={citation.id}>
        <p>{citation.excerpt}</p><button className="text-button" onClick={() => void run({ type: "open.message", messageId: citation.messageId })}>{citation.title || "Open source"} <ExternalLink size={12}/></button>
        <p className="caption">{citation.location}</p>
      </blockquote>)}</details>
    </article>)}</details>}
  </section>;
}

export function Productivity({ data, busy, run }: ProductivityProps) {
  const tasks = data.tasks ?? [];
  const report = data.focusReport;
  const [createDraft, setCreateDraft] = useState<TaskDraft>({ title: "", notes: "", priority: "medium", dueAt: "", status: "open" });
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState<TaskDraft>({ title: "", notes: "", priority: "medium", dueAt: "", status: "open" });
  const [schedulingId, setSchedulingId] = useState("");
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleTemplate(undefined, data));
  const [reportPrompt, setReportPrompt] = useState("");
  const [scheduleError, setScheduleError] = useState("");

  const activeTask = useMemo(() => tasks.find((task) => task.id === editingId), [editingId, tasks]);
  const schedulingTask = useMemo(() => tasks.find((task) => task.id === schedulingId), [schedulingId, tasks]);
  const calendarSources = useMemo(() =>
    data.sources.filter(source =>
      source.kind === "calendar"
      && data.accounts.some(account => account.id === source.accountId && account.status === "connected" && account.consent && account.connection !== "browser" && !account.demo)
    ),
  [data.accounts, data.sources]);

  useEffect(() => {
    if (editingId && !activeTask) setEditingId("");
  }, [editingId, activeTask]);

  useEffect(() => {
    if (schedulingId && !schedulingTask) setSchedulingId("");
  }, [schedulingId, schedulingTask]);

  const beginEdit = (task: TaskItem) => {
    if (editingId === task.id) {
      setEditingId("");
      return;
    }
    setEditingId(task.id);
    setEditDraft({
      title: task.title,
      notes: task.notes,
      priority: task.priority,
      dueAt: dueInput(task),
      status: task.status
    });
  };

  const beginSchedule = (task: TaskItem) => {
    setScheduleError("");
    if (schedulingId === task.id) {
      setSchedulingId("");
      return;
    }
    setSchedulingId(task.id);
    setScheduleDraft(scheduleTemplate(task, data));
  };

  const updateScheduleSource = (sourceId: string) => {
    const source = calendarSources.find(item => item.id === sourceId);
    setScheduleDraft((current) => ({ ...current, sourceId, accountId: source?.accountId || "" }));
  };

  const saveCreatedTask = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run({
      type: "task.create",
      title: createDraft.title,
      notes: createDraft.notes || undefined,
      priority: createDraft.priority,
      dueAt: createDraft.dueAt || undefined,
      status: createDraft.status
    });
    if (result) setCreateDraft({ title: "", notes: "", priority: "medium", dueAt: "", status: "open" });
  };

  const saveEditedTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeTask) return;
    const result = await run({
      type: "task.edit",
      taskId: activeTask.id,
      title: editDraft.title,
      notes: editDraft.notes,
      priority: editDraft.priority,
      dueAt: editDraft.dueAt || null,
      status: editDraft.status
    });
    if (result) setEditingId("");
  };

  const submitSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!schedulingTask) return;
    const reminderMinutes = Number(scheduleDraft.reminderMinutes || DEFAULT_TASK_REMINDER_MINUTES);
    const start = scheduleDraft.allDay ? scheduleDraft.start : zonedLocalToIso(scheduleDraft.start, scheduleDraft.timeZone);
    const end = scheduleDraft.allDay ? scheduleDraft.end : zonedLocalToIso(scheduleDraft.end, scheduleDraft.timeZone);
    if (!start || !end) {
      setScheduleError("Choose valid start and end times in the selected time zone. A daylight-saving transition may make this local time unavailable.");
      return;
    }
    if (Date.parse(end) <= Date.parse(start)) {
      setScheduleError("End must be after start. All-day events use an exclusive end date.");
      return;
    }
    setScheduleError("");
    const result = await run({
      type: "task.schedule",
      taskId: schedulingTask.id,
      confirmed: true,
      change: {
        accountId: scheduleDraft.accountId,
        sourceId: scheduleDraft.sourceId,
        eventId: schedulingTask.schedule?.eventId,
        title: scheduleDraft.title,
        start,
        end,
        timeZone: scheduleDraft.timeZone,
        allDay: scheduleDraft.allDay,
        attendees: [],
        location: scheduleDraft.location,
        description: scheduleDraft.description,
        reminderMinutes,
        expectedRevision: data.events.find(eventItem => eventItem.id === schedulingTask.schedule?.eventId)?.revision
      }
    });
    if (result) setSchedulingId("");
  };

  const reportActions = report?.nextActions ?? [];

  return <div className="page">
    <div className="page-title">
      <div>
        <div className="eyebrow">PRODUCTIVITY</div>
        <h1>Tasks, focus, and scheduling</h1>
        <p>Editable local tasks backed by selected email evidence, plus explicit calendar scheduling and focus reporting.</p>
      </div>
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={() => void run({ type: "report.generate", ...(reportPrompt.trim() ? { prompt: reportPrompt.trim() } : {}) })}>
          <Sparkles size={16}/> Generate focus report
        </button>
      </div>
    </div>

    <div className="stats-grid">
      <div className="card stat"><div><span>Open tasks</span><CheckCheck size={18}/></div><strong>{tasks.filter(task => task.status !== "done").length}</strong><small>Manual and auto-derived</small></div>
      <div className="card stat"><div><span>Due soon</span><Clock3 size={18}/></div><strong>{report?.metrics.dueSoonTasks ?? 0}</strong><small>Next {report?.coverage.dueSoonWindowHours ?? 72} hours</small></div>
      <div className="card stat"><div><span>Urgent</span><CircleAlert size={18}/></div><strong>{report?.metrics.urgentTasks ?? 0}</strong><small>Urgent or high priority</small></div>
      <div className="card stat"><div><span>Upcoming meetings</span><CalendarDays size={18}/></div><strong>{report?.metrics.upcomingMeetings ?? 0}</strong><small>Visible imported calendars</small></div>
    </div>

    <ArchiveReviewPanel data={data} busy={busy} run={run}/>
    <div className="today-grid">
      <section>
        <div className="card">
          <div className="section-heading"><h2>Create a task</h2><Badge tone="teal">offline-ready</Badge></div>
          <form onSubmit={saveCreatedTask}>
            <div className="filter-bar">
              <label><span className="caption">Title</span><input aria-label="New task title" value={createDraft.title} onChange={(event) => setCreateDraft({ ...createDraft, title: event.target.value })} required maxLength={240}/></label>
              <label><span className="caption">Priority</span><select aria-label="New task priority" value={createDraft.priority} onChange={(event) => setCreateDraft({ ...createDraft, priority: event.target.value as TaskPriority })}>
                <option value="urgent">Urgent</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select></label>
              <label><span className="caption">Due date</span><input aria-label="New task due date" type="date" value={createDraft.dueAt} onChange={(event) => setCreateDraft({ ...createDraft, dueAt: event.target.value })}/></label>
              <label><span className="caption">Status</span><select aria-label="New task status" value={createDraft.status} onChange={(event) => setCreateDraft({ ...createDraft, status: event.target.value as TaskStatus })}>
                <option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="done">Done</option>
              </select></label>
            </div>
            <label><span className="caption">Notes</span><textarea aria-label="New task notes" value={createDraft.notes} onChange={(event) => setCreateDraft({ ...createDraft, notes: event.target.value })} rows={3} maxLength={4000}/></label>
            <div className="button-row"><button type="submit" disabled={busy || !createDraft.title.trim()}><Plus size={15}/> Add task</button></div>
          </form>
        </div>

        <div className="section-heading"><h2>Your tasks <span>{tasks.length}</span></h2><span className="caption">Editable local list with preserved manual changes</span></div>
        {!tasks.length ? <Empty title="No tasks yet"><p>Add a manual task above, or selected email action items will appear here automatically.</p></Empty> : <div className="action-stack">
          {tasks.map((task) => <article key={task.id} className="card action-card">
            <div className="action-top">
              <div className="button-row">
                <Badge tone={task.priority === "urgent" ? "rose" : task.priority === "high" ? "amber" : "teal"}>{task.priority}</Badge>
                <Badge>{task.status.replace("_", " ")}</Badge>
                {task.origin === "manual" ? <Badge>manual</Badge> : <Badge>email-backed</Badge>}
                {task.schedule?.state === "scheduled" && <Badge tone="teal">scheduled</Badge>}
                {task.schedule?.state === "out_of_date" && <Badge tone="amber">calendar out of date</Badge>}
                {task.schedule?.state === "uncertain" && <Badge tone="rose">calendar uncertain</Badge>}
              </div>
              <span className="caption">
                #{task.focusRank ?? "–"}{task.dueAt ? ` · Due ${formatDate(task.dueAt, !/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt))}` : ""}{task.sourceReason ? " · review source context" : ""}
              </span>
            </div>
            <h3>{task.title}</h3>
            {task.sourceReason && <p>{task.sourceReason}</p>}
            {task.notes && <p className="muted">{task.notes}</p>}
            {task.schedule?.note && <p className="caption">{task.schedule.note}</p>}
            {citationButtons(task, run)}
            <div className="button-row">
              <button className="quiet small" disabled={busy} onClick={() => void run({ type: "task.status", taskId: task.id, status: "open" })}>Open</button>
              <button className="quiet small" disabled={busy} onClick={() => void run({ type: "task.status", taskId: task.id, status: "in_progress" })}>In progress</button>
              <button className="quiet small" disabled={busy} onClick={() => void run({ type: "task.status", taskId: task.id, status: "waiting" })}>Waiting</button>
              <button className="secondary small" disabled={busy} onClick={() => void run({ type: "task.status", taskId: task.id, status: task.status === "done" ? "open" : "done" })}>
                <Check size={14}/>{task.status === "done" ? "Reopen" : "Done"}
              </button>
              <button className="text-button" disabled={busy} onClick={() => beginEdit(task)}>Edit</button>
              <button className="text-button" disabled={busy || !calendarSources.length} onClick={() => beginSchedule(task)}>Schedule</button>
            </div>
            {editingId === task.id && <form onSubmit={saveEditedTask}>
              <div className="filter-bar">
                <label><span className="caption">Title</span><input aria-label={`Edit title ${task.title}`} value={editDraft.title} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} required maxLength={240}/></label>
                <label><span className="caption">Priority</span><select aria-label={`Edit priority ${task.title}`} value={editDraft.priority} onChange={(event) => setEditDraft({ ...editDraft, priority: event.target.value as TaskPriority })}>
                  <option value="urgent">Urgent</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                </select></label>
                <label><span className="caption">Due date</span><input aria-label={`Edit due date ${task.title}`} type="date" value={editDraft.dueAt} onChange={(event) => setEditDraft({ ...editDraft, dueAt: event.target.value })}/></label>
                <label><span className="caption">Status</span><select aria-label={`Edit status ${task.title}`} value={editDraft.status} onChange={(event) => setEditDraft({ ...editDraft, status: event.target.value as TaskStatus })}>
                  <option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting</option><option value="done">Done</option>
                </select></label>
              </div>
              <label><span className="caption">Notes</span><textarea aria-label={`Edit notes ${task.title}`} rows={3} value={editDraft.notes} onChange={(event) => setEditDraft({ ...editDraft, notes: event.target.value })} maxLength={4000}/></label>
              <div className="button-row"><button type="submit" disabled={busy || !editDraft.title.trim()}>Save task</button><button type="button" className="secondary" onClick={() => setEditingId("")}>Cancel</button></div>
            </form>}
            {schedulingId === task.id && <form onSubmit={submitSchedule}>
              <div className="section-heading"><h2>Schedule on calendar</h2><Badge tone="amber">explicit approval</Badge></div>
              <div className="filter-bar">
                <label><span className="caption">Calendar</span><select aria-label={`Schedule calendar ${task.title}`} value={scheduleDraft.sourceId} onChange={(event) => updateScheduleSource(event.target.value)} required>
                  <option value="">Choose a calendar</option>
                  {calendarSources.map(source => <option key={source.id} value={source.id}>{data.accounts.find(account => account.id === source.accountId)?.email} · {source.name}{source.selected ? "" : " · currently unselected"}</option>)}
                </select></label>
                <label><span className="caption">Time zone</span><select aria-label={`Schedule time zone ${task.title}`} value={scheduleDraft.timeZone} onChange={(event) => setScheduleDraft({ ...scheduleDraft, timeZone: event.target.value })}>
                  {timeZoneOptions(scheduleDraft.timeZone).map(zone => <option key={zone} value={zone}>{zone}</option>)}
                </select></label>
                <label><span className="caption">Reminder</span><select aria-label={`Schedule reminder ${task.title}`} value={scheduleDraft.reminderMinutes} onChange={(event) => setScheduleDraft({ ...scheduleDraft, reminderMinutes: event.target.value })}>
                  {[0, 5, 15, 30, 60, 120, 1_440, 10_080].map(value => <option key={value} value={String(value)}>{value === 0 ? "At start" : `${value} min before`}</option>)}
                </select></label>
              </div>
              <div className="filter-bar">
                <label><span className="caption">Event title</span><input aria-label={`Schedule title ${task.title}`} value={scheduleDraft.title} onChange={(event) => setScheduleDraft({ ...scheduleDraft, title: event.target.value })} required maxLength={1000}/></label>
                <label><span className="caption">Location</span><input aria-label={`Schedule location ${task.title}`} value={scheduleDraft.location} onChange={(event) => setScheduleDraft({ ...scheduleDraft, location: event.target.value })} maxLength={2000}/></label>
                <label><span className="caption">All day</span><input aria-label={`Schedule all day ${task.title}`} type="checkbox" checked={scheduleDraft.allDay} onChange={(event) => setScheduleDraft({ ...scheduleDraft, allDay: event.target.checked })}/></label>
              </div>
              <div className="filter-bar">
                <label><span className="caption">{scheduleDraft.allDay ? "Start date" : "Start"}</span><input aria-label={`Schedule start ${task.title}`} type={scheduleDraft.allDay ? "date" : "datetime-local"} value={scheduleDraft.start} onChange={(event) => setScheduleDraft({ ...scheduleDraft, start: event.target.value, end: !scheduleDraft.allDay ? addMinutes(event.target.value, Number(scheduleDraft.durationMinutes || 60), scheduleDraft.timeZone) : scheduleDraft.end })} required/></label>
                <label><span className="caption">{scheduleDraft.allDay ? "End date" : "End"}</span><input aria-label={`Schedule end ${task.title}`} type={scheduleDraft.allDay ? "date" : "datetime-local"} value={scheduleDraft.end} onChange={(event) => setScheduleDraft({ ...scheduleDraft, end: event.target.value })} required/></label>
                {!scheduleDraft.allDay && <label><span className="caption">Duration</span><select aria-label={`Schedule duration ${task.title}`} value={scheduleDraft.durationMinutes} onChange={(event) => setScheduleDraft({ ...scheduleDraft, durationMinutes: event.target.value, end: addMinutes(scheduleDraft.start, Number(event.target.value), scheduleDraft.timeZone) })}>
                  {[30, 45, 60, 90, 120].map(value => <option key={value} value={String(value)}>{value} min</option>)}
                </select></label>}
              </div>
              <label><span className="caption">Description</span><textarea aria-label={`Schedule description ${task.title}`} rows={3} value={scheduleDraft.description} onChange={(event) => setScheduleDraft({ ...scheduleDraft, description: event.target.value })} maxLength={4000}/></label>
              <label className="caption">
                <input aria-label={`Confirm private schedule ${task.title}`} type="checkbox" checked={scheduleDraft.privateConfirmed} onChange={(event) => setScheduleDraft({ ...scheduleDraft, privateConfirmed: event.target.checked })}/>
                {" "}I approve this exact focus block with no attendees, on the selected calendar, at the selected time and reminder.
              </label>
              <p className="caption">Your calendar’s existing visibility and sharing rules still apply.</p>
              {!calendarSources.length && <p className="caption">Connect an API calendar first. Browser calendars stay read-only.</p>}
              {scheduleDraft.sourceId && !calendarSources.find(source => source.id === scheduleDraft.sourceId)?.selected && <p className="caption">Scheduling also selects this calendar for ongoing sync under your refresh settings.</p>}
              {scheduleError && <p className="inline-error" role="alert">{scheduleError}</p>}
              <div className="button-row"><button type="submit" disabled={busy || !scheduleDraft.privateConfirmed || !scheduleDraft.sourceId || !scheduleDraft.title.trim()}>Save calendar block</button><button type="button" className="secondary" onClick={() => setSchedulingId("")}>Cancel</button></div>
            </form>}
          </article>)}
        </div>}
      </section>

      <aside className="right-column">
        <section className="card">
          <div className="section-heading"><h2>Focus report</h2><Badge tone="teal">{report?.metrics.workloadLabel ?? "live"}</Badge></div>
          <p className="caption">Snapshot {report ? formatDate(report.snapshotAt, true) : "now"}{report ? ` · narrative ${formatDate(report.generatedAt, true)}` : ""}</p>
          <label><span className="caption">What should the assistant emphasize?</span><textarea aria-label="Focus report prompt" rows={3} value={reportPrompt} onChange={(event) => setReportPrompt(event.target.value)} maxLength={2000} placeholder="Example: highlight blockers, overdue requests, and what can wait."/></label>
          {report?.warnings.length ? <ul>{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="muted">No warnings right now.</p>}
          {report?.narrative ? <p className="plain-body">{report.narrative}</p> : <p className="muted">Generate a narrative grounded in selected email citations. Local metrics below stay available offline.</p>}
          {report?.citations.length ? <div className="button-row">{report.citations.map((citation) =>
            <button key={citation.id} className="text-button" onClick={() => void run({ type: "open.message", messageId: citation.messageId })}>
              {citation.title || citation.id} <ExternalLink size={12}/>
            </button>)}
          </div> : null}
        </section>

        <section className="card">
          <div className="section-heading"><h2>Prioritized next actions</h2><Clock3 size={18}/></div>
          {reportActions.length ? reportActions.map((action) => <div key={action.taskId} className="waiting-item">
            <strong>{action.title}</strong>
            <p>{action.reason}</p>
            <small>{action.priority}{action.dueAt ? ` · ${formatDate(action.dueAt, !/^\d{4}-\d{2}-\d{2}$/.test(action.dueAt))}` : ""}</small>
          </div>) : <p className="muted">Create or sync tasks to build a ranked action list.</p>}
        </section>

        <section className="card">
          <div className="section-heading"><h2>Coverage</h2><Badge>{report?.coverage.aiEligibleCitationCount ?? 0} AI-ready citations</Badge></div>
          <ul>
            <li>{report?.coverage.connectedAccounts ?? 0} connected, consented accounts</li>
            <li>{report?.coverage.selectedMailSources ?? 0} selected mail sources</li>
            <li>{report?.coverage.selectedCalendarSources ?? 0} selected calendar sources</li>
            <li>{report?.coverage.impreciseBrowserTasks ?? 0} tasks with imprecise browser-only timing</li>
            <li>{report?.coverage.exactDueDateTasks ?? 0} tasks with exact local due dates</li>
          </ul>
        </section>

        <section className="card">
          <div className="section-heading"><h2>Upcoming meetings</h2><CalendarDays size={18}/></div>
          {report?.upcomingMeetings.length ? report.upcomingMeetings.map((meeting) => <div key={meeting.id} className="mini-event">
            <div className="event-date">{new Date(meeting.start).toLocaleDateString(undefined, { day: "numeric" })}<small>{new Date(meeting.start).toLocaleDateString(undefined, { month: "short" })}</small></div>
            <div><strong>{meeting.title}</strong><p>{meeting.allDay ? "All day" : formatDate(meeting.start, true)}</p><small>{meeting.location || meeting.timeZone}</small></div>
          </div>) : <p className="muted">No upcoming imported meetings in the current focus window.</p>}
        </section>
      </aside>
    </div>
  </div>;
}
