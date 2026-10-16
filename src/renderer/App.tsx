import { Component, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Activity, ArrowDownToLine, ArrowRight, CalendarDays, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, Cloud, Database, ExternalLink, FileText, Inbox, LoaderCircle, LockKeyhole, Mail, MessageSquare, PanelLeftClose, Paperclip, Pause, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Sun, X } from "lucide-react";
import type { Account, Approval, Attachment, CalendarEvent, Citation, Command, CommandResult, Draft, EventChange, Message, Settings, Snapshot } from "../shared/contracts";
import { commandError, draftSignature, eventChange, fileSize, formatDate, localDateTime, nativeDraftSupport, splitAddresses, validateEvent } from "./utils";
import { BrowserAttachmentAction } from "./BrowserAttachmentAction";
import { ArchiveReviewPanel, Productivity } from "./Productivity";
import { compareRecentMessages, inboxConversations, inboxLabel, messageReceivedAt } from "../shared/inbox";
import { CalendarAgenda } from "./CalendarAgenda";
import { Chat } from "./Chat";
import { DocumentActions, DocumentWorkspace } from "./DocumentViewer";
import { EmailBody } from "./EmailBody";
import { useEmailThread } from "./useEmailThread";
import { SettingsPage } from "./SettingsPage";
import { FullMailArchive } from "./FullMailArchive";
import { activeAi } from "./ai";

type Page = "chat" | "today" | "inbox" | "productivity" | "archive" | "calendar" | "activity" | "settings";
type Run = (command: Command, success?: string, onError?: (text: string) => void) => Promise<CommandResult | undefined>;
type Shared = { data: Snapshot; run: Run; busy: boolean };
const nav = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "today", label: "Today", icon: Sun }, { id: "inbox", label: "Unified inbox", icon: Inbox },
  { id: "productivity", label: "Tasks & focus", icon: CheckCheck },
  { id: "archive", label: "Archive & ask", icon: Search }, { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "activity", label: "Activity", icon: Activity }, { id: "settings", label: "Settings", icon: Settings2 },
] as const;

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="standalone"><CircleAlert size={40}/><h1>Something interrupted your workspace.</h1><p>Your saved archive remains on this device. Reload to reconnect.</p><button onClick={() => window.location.reload()}>Reload workspace</button></div> : this.props.children;
  }
}

function Empty({ icon = <Inbox size={30}/>, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><div className="muted">{children}</div></div>;
}
function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function ModelSelect({ data, value, onChange, label = `${activeAi(data).name} model` }: { data: Snapshot; value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="model-select"><Sparkles size={15}/><span className="sr-only">{label}</span><select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={!data.models.length}>
    <option value="">{data.models.length ? "Choose a model" : `Connect ${activeAi(data).name} for models`}</option>
    {value && !data.models.some((m) => m.id === value) && <option value={value} disabled>Unavailable: {value}</option>}
    {data.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
  </select></label>;
}
function Citations({ items, run }: { items: Citation[]; run: Run }) {
  if (!items.length) return <p className="caption">No source citations available.</p>;
  return <details className="citations"><summary>{items.length} source{items.length === 1 ? "" : "s"} · inspect evidence</summary><div>{items.map((c) => <blockquote key={c.id}><p>{c.excerpt}</p><button className="text-button" onClick={() => void run({ type: "open.message", messageId: c.messageId })}>{c.title || "Source message"} <ExternalLink size={12}/></button>{c.location && <span className="caption"> · {c.location}</span>}{c.attachmentId && <DocumentActions attachmentId={c.attachmentId} viewOnly/>}</blockquote>)}</div></details>;
}

export function App() {
  const [data, setData] = useState<Snapshot>();
  const [page, setPage] = useState<Page>("chat");
  const [selectedMessage, setSelectedMessage] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean; command?: Command["type"] }>();
  const [busyCount, setBusyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [compact, setCompact] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const bridge = typeof window !== "undefined" ? window.relay : undefined;
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const request = ++sequence.current;
    try {
      const next = await bridge.snapshot();
      if (mounted.current && request === sequence.current) setData(next);
    } catch (error) {
      if (mounted.current) setNotice({ text: error instanceof Error ? error.message : "Could not load the local archive.", error: true });
    } finally { if (mounted.current) setLoading(false); }
  }, [bridge]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = bridge?.onChange(() => void refresh());
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; unsubscribe?.(); document.removeEventListener("visibilitychange", visible); };
  }, [bridge, refresh]);
  const run: Run = useCallback(async (command, success, onError) => {
    if (!bridge) { setNotice({ text: "This action requires the desktop application.", error: true }); return; }
    setBusyCount((n) => n + 1);
    try {
      const result = await bridge.command(command);
      if (result.message || success) setNotice({ text: result.message || success!, error: false });
      else if (command.type === "message.load") setNotice(previous => previous?.error && previous.command === "message.load" ? undefined : previous);
      await refresh();
      return result;
    } catch (error) {
      setNotice({ text: commandError(error), error: true, command: command.type });
      onError?.(commandError(error));
      return undefined;
    } finally { setBusyCount((n) => Math.max(0, n - 1)); }
  }, [bridge, refresh]);
  const openMessage = (id: string) => { setSelectedMessage(id); setPage("inbox"); };
  if (!bridge) return <div className="standalone"><div className="brand-mark"><Mail/></div><span className="eyebrow">RELAY DESK</span><h1>Your work, in one quiet place.</h1><p>Relay Desk needs its desktop app to securely access your local archive, connect accounts, and use your AI provider. This browser preview has no account access and does not simulate a connection.</p><div className="privacy-line"><LockKeyhole size={16}/> Local-first. Always in your control.</div></div>;
  if (loading || !data) return <div className="standalone"><div className="brand-mark"><Mail/></div><h1>Opening your workspace</h1>{loading ? <LoaderCircle className="spin"/> : <><p role="alert">{notice?.text || "The desktop archive could not be loaded."}</p><button onClick={() => { setLoading(true); void refresh(); }}>Try again</button></>}</div>;
  const busy = busyCount > 0;
  const shared = { data, run, busy };
  const pending = data.attachments.filter((a) => a.status === "awaiting-approval").length + data.approvals.filter((a) => a.status === "pending").length;
  return <DocumentWorkspace data={data} run={run}><div className={`app ${compact ? "compact-nav" : ""}`}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Mail size={22}/></div><div className="brand-copy"><strong>relay<span>desk</span></strong><small>A little more headspace.</small></div></div>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">{nav.map(({ id, label, icon: Icon }) => <button title={label} key={id} className={`nav-item ${page === id ? "active" : ""}`} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}><Icon size={19}/><span>{label}</span>{id === "activity" && pending > 0 && <b>{pending}</b>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="local-status"><span className={`status-dot ${data.settings.syncPaused ? "paused" : ""}`}/><div><strong>{data.settings.syncPaused ? "Sync is paused" : "Your local workspace"}</strong><small>{data.archive.messages.toLocaleString()} archived messages</small></div></div>
        <div className="sidebar-note"><ShieldCheck size={16}/><span>Nothing sent without you.<br/>Replies stay drafts.</span></div>
        <button className="collapse-button" onClick={() => setCompact(!compact)} aria-label={compact ? "Expand navigation" : "Collapse navigation"}><PanelLeftClose size={17}/><span>Collapse sidebar</span></button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={14}/><strong>{nav.find((n) => n.id === page)?.label}</strong>{data.demo && <Badge tone="amber">Synthetic demo</Badge>}</div><div className="topbar-actions">{busy && <span className="working" role="status"><LoaderCircle size={14} className="spin"/> Working</span>}<span className={`connection ${data.copilot.status === "ready" ? "ready" : ""}`} title={data.copilot.message}><span className="status-dot"/>{activeAi(data).name} {data.copilot.status}</span><button className="icon-button" title="Refresh workspace and connected channels" aria-label="Refresh workspace" disabled={busy} onClick={() => void run({ type: "refresh.request" })}><RefreshCw size={17}/></button></div></header>
      {notice && <div className={`notice ${notice.error ? "error" : "success"}`} role={notice.error ? "alert" : "status"}>{notice.error ? <CircleAlert size={18}/> : <Check size={18}/>}<span>{notice.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(undefined)}><X size={16}/></button></div>}
      <main id="main-content" tabIndex={-1} className={page === "chat" ? "chat-page" : undefined}>
        <div className="chat-view" hidden={page !== "chat"}><Chat data={data} run={run} navigate={setPage}/></div>
        {page === "today" && <Today {...shared} openMessage={openMessage} navigate={setPage}/>}
        {page === "inbox" && <InboxPage {...shared} selected={selectedMessage} select={setSelectedMessage}/>}
        {page === "productivity" && <Productivity {...shared}/>}
        {page === "archive" && <ArchivePage {...shared}/>}
        {page === "calendar" && <CalendarPage {...shared}/>}
        {page === "activity" && <ActivityPage {...shared}/>}
        {page === "settings" && <SettingsPage {...shared}/>}
      </main>
      <footer className="workspace-footer"><span><LockKeyhole size={12}/> Local archive · {data.archive.searchMode === "hybrid" ? "Hybrid retrieval" : "Keyword search"}</span><span>Made for focus. Built for your control.</span></footer>
    </div>
  </div></DocumentWorkspace>;
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="title-action">{action}</div>}</div>;
}
function Today({ data, run, busy, openMessage, navigate }: Shared & { openMessage: (id: string) => void; navigate: (page: Page) => void }) {
  const actions = data.actions.filter((a) => a.status === "open").sort((a, b) => ({ urgent: 0, important: 1, normal: 2 }[a.priority] - { urgent: 0, important: 1, normal: 2 }[b.priority]));
  const upcoming = data.events.filter((e) => Date.parse(e.end) >= Date.now()).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
  const waiting = data.actions.filter((a) => a.status === "waiting" || a.status === "snoozed");
  return <div className="page"><PageTitle eyebrow={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} title="A clearer view of your day." description="The conversations that matter. The context to move them forward." action={<div className="button-row"><button onClick={() => navigate("settings")}>{data.browser?.paired ? "Browser sources" : "Connect your browser"}</button><button className="secondary" disabled={busy || !data.accounts.some(account => account.connection !== "browser")} onClick={() => void run({ type: "sync" }, "Sync requested.")}><RefreshCw size={16}/> Sync accounts</button></div>}/>
    {!data.accounts.length && <section className="onboarding card"><div><Badge tone="teal">YOUR CALM STARTS HERE</Badge><h2>Less switching.<br/>More moving things forward.</h2><p>Bring your email, Slack, and calendar into a private workspace. Choose exactly which sources to import, then let AI help only when you opt in.</p><div className="button-row"><button onClick={() => navigate("settings")}>Connect your first account <ArrowRight size={16}/></button><button className="secondary" disabled={busy} onClick={() => void run({ type: "demo.load" }, "Synthetic sample workspace loaded.")}>Explore synthetic demo</button></div></div><div className="onboarding-points"><div><Database/><section><strong>History stays on your device</strong><p>Encrypted local archive. Source controls. Clear deletion choices.</p></section></div><div><Cloud/><section><strong>Copilot is a cloud service</strong><p>Only authorized context is shared after AI opt-in. Your subscription and model access apply.</p></section></div><div><ShieldCheck/><section><strong>You're always the final step</strong><p>No email sending or Slack posting. Calendar changes require separate approval.</p></section></div></div></section>}
    <div className="stats-grid"><Stat label="Needs your attention" value={actions.length} note="Evidence-backed next steps" icon={<Inbox/>}/><Stat label="Local drafts" value={data.drafts.length} note="Prepared, never sent" icon={<FileText/>}/><Stat label="Upcoming meetings" value={upcoming.length} note="From imported calendars" icon={<CalendarDays/>}/><Stat label="Archive coverage" value={data.archive.messages.toLocaleString()} note={`${data.archive.indexed.toLocaleString()} indexed · progressive import`} icon={<Database/>}/></div>
    <ArchiveReviewPanel data={data} run={run} busy={busy}/>
    <div className="today-grid"><section><div className="section-heading"><h2>Your next moves <span>{actions.length}</span></h2><span className="caption">Ranked by priority</span></div>{!actions.length ? <div className="card"><Empty icon={<CheckCheck size={32}/>} title="Room to focus"><p>No open priorities yet. Connect and select your sources in Settings. AI recommendations require account opt-in and an available AI model.</p></Empty></div> : <div className="action-stack">{actions.map((a) => <article key={a.id} className={`card action-card ${a.priority}`}><div className="action-top"><Badge tone={a.priority === "urgent" ? "rose" : a.priority === "important" ? "amber" : "teal"}>{a.priority}</Badge><span className="caption">{data.accounts.find((x) => x.id === a.accountId)?.name}{a.dueAt ? ` · Due ${formatDate(a.dueAt, true)}` : ""}</span></div><button className="action-title" onClick={() => openMessage(a.messageId)}>{a.title}<ArrowRight size={18}/></button><p>{a.reason}</p><Citations items={a.citations} run={run}/><div className="action-footer"><span className="caption">{Math.round(a.confidence * 100)}% confidence · review the evidence</span><div className="button-row"><button className="quiet small" disabled={busy} onClick={() => void run({ type: "action.update", actionId: a.id, status: "waiting" }, "Marked as waiting.")}>Waiting</button><button className="quiet small" disabled={busy} onClick={() => void run({ type: "action.update", actionId: a.id, status: "snoozed", snoozedUntil: new Date(Date.now() + 86400000).toISOString() }, "Snoozed for one day.")}><Clock3 size={14}/>1 day</button><button className="secondary small" disabled={busy} onClick={() => void run({ type: "action.update", actionId: a.id, status: "done" }, "Marked complete locally.")}><Check size={14}/>Done</button></div></div></article>)}</div>}</section>
      <aside className="right-column"><section className="card"><div className="section-heading"><h2>On the horizon</h2><CalendarDays size={18}/></div>{upcoming.length ? upcoming.map((e) => <div className="mini-event" key={e.id}><div className="event-date">{new Date(e.start).toLocaleDateString(undefined, { day: "numeric" })}<small>{new Date(e.start).toLocaleDateString(undefined, { month: "short" })}</small></div><div><strong>{e.title}</strong><p>{e.allDay ? "All day" : formatDate(e.start, true)}</p><small>{e.location || e.timeZone}</small></div></div>) : <p className="muted">No upcoming events in your imported calendars.</p>}<button className="text-button" onClick={() => navigate("calendar")}>View calendar <ArrowRight size={14}/></button></section><section className="card"><div className="section-heading"><h2>Waiting & snoozed</h2><Clock3 size={18}/></div>{waiting.length ? waiting.map((a) => <div className="waiting-item" key={a.id}><strong>{a.title}</strong><p>{a.status}{a.snoozedUntil ? ` until ${formatDate(a.snoozedUntil, true)}` : ""}</p><button className="text-button" disabled={busy} onClick={() => void run({ type: "action.update", actionId: a.id, status: "open" })}>Bring back</button></div>) : <p className="muted">Follow-ups you set aside will appear here.</p>}</section><div className="quiet-note"><ShieldCheck size={20}/><p>Your inbox stays yours. Completing an action here never changes or archives a message at its source.</p></div></aside></div>
  </div>;
}
function Stat({ label, value, note, icon }: { label: string; value: string | number; note: string; icon: ReactNode }) {
  return <div className="card stat"><div><span>{label}</span>{icon}</div><strong>{value}</strong><small>{note}</small></div>;
}

function InboxPage({ data, run, busy, selected, select }: Shared & { selected: string; select: (id: string) => void }) {
  const [account, setAccount] = useState("");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const selection = useRef<Message | undefined>(undefined);
  const inboxes = data.accounts.filter(item => data.sources.some(channel => channel.accountId === item.id && channel.kind !== "calendar"));
  const chooseInbox = (id: string) => { setAccount(id); setSource(""); select(""); };
  const filtered = data.messages.filter((m) => (!account || m.accountId === account) && (!source || m.sourceId === source) && `${m.subject} ${m.sender} ${m.body}`.toLowerCase().includes(query.toLowerCase())).sort(compareRecentMessages);
  const found = filtered.find((m) => m.id === selected);
  useEffect(() => { if (found) selection.current = found; else if (!selected) selection.current = undefined; }, [found, selected]);
  const retained = selection.current;
  const current = found || (retained?.id === selected && !data.messages.some(item => item.id === selected)
    && (!account || retained.accountId === account) && (!source || retained.sourceId === source)
    && `${retained.subject} ${retained.sender} ${retained.body}`.toLowerCase().includes(query.toLowerCase()) ? retained : undefined);
  const draftMessages = new Set(data.drafts.map(draft => draft.messageId));
  const messages = inboxConversations(filtered, selected, draftMessages, data.messages);
  const email = useEmailThread(data, current, run);
  const { thread } = email;
  return <div className="page inbox-page"><PageTitle eyebrow="CONVERSATIONS, CONNECTED" title="Unified inbox"
    description="Full Gmail conversations download automatically into your encrypted local archive for search and AI retrieval. Opening a conversation prioritizes its full content."
    action={<button disabled={busy} onClick={() => void run({ type: "refresh.request" })}><RefreshCw size={16}/>Refresh inboxes</button>}/>
    <FullMailArchive {...{ data, run, busy }}/>
    <div className="button-row wrap" role="group" aria-label="Choose an inbox">
      <button className={account ? "secondary" : ""} aria-pressed={!account} onClick={() => chooseInbox("")}>All inboxes</button>
      {inboxes.map(item => <button key={item.id} className={account === item.id ? "" : "secondary"}
        aria-label={`Show inbox ${inboxLabel(item)}`} aria-pressed={account === item.id} onClick={() => chooseInbox(item.id)}>
        {inboxLabel(item)} <span>({data.messages.filter(message => message.accountId === item.id).length})</span>
      </button>)}
    </div>
    <div className="filter-bar"><label className="search-input"><Search size={17}/><input aria-label="Filter recent messages" placeholder="Filter recent messages…" value={query} onChange={(e) => setQuery(e.target.value)}/></label>
      <select aria-label="Inbox account" value={account} onChange={e => chooseInbox(e.target.value)}><option value="">All inboxes</option>{inboxes.map(item => <option key={item.id} value={item.id}>{inboxLabel(item)}</option>)}</select>
      <select aria-label="Inbox source" value={source} onChange={e => { setSource(e.target.value); select(""); }}><option value="">All sources</option>{data.sources.filter(item => item.kind !== "calendar" && (!account || item.accountId === account)).map(item => <option value={item.id} key={item.id}>{data.accounts.find(owner => owner.id === item.accountId)?.email} - {item.name}</option>)}</select>
    </div>
    <div aria-label="Inbox freshness">{inboxes.filter(item => !account || item.id === account).map(item => {
      const sources = data.sources.filter(channel => channel.accountId === item.id && channel.kind !== "calendar");
      const last = item.connection === "browser"
        ? sources.map(channel => channel.lastSync || "").sort().at(-1)
        : item.lastSync;
      return <p className="caption" key={item.id}><strong>{inboxLabel(item)}</strong> — {item.connection === "browser" ? "Last capture" : "Last sync"}: {last ? formatDate(last, true) : "Not yet recorded"}.
        {!sources.some(channel => channel.selected) && " No source selected; enable this inbox in Settings."}
        {item.connection === "browser" && !data.settings.browserBackgroundCapture && " Background refresh is off; keep its Google tab visible or enable background browser refresh in Settings."}
      </p>;
    })}</div>
    <p className="caption">Newest mailbox date first. Download and capture times do not affect this order. Unknown dates appear last.</p>
    <div className="inbox-layout card"><section className="message-list" aria-label="Messages"><div className="list-heading">{messages.length} recent conversations</div>{messages.length ? messages.map(({ message: m, latest }) => {
      const owner = data.accounts.find(item => item.id === m.accountId);
      const receivedAt = messageReceivedAt(latest);
      const selectedThread = current?.accountId === m.accountId && current.sourceId === m.sourceId && current.threadId === m.threadId;
      return <button key={m.id} data-message-id={m.id} className={`message-row ${selectedThread ? "selected" : ""}`} onClick={() => select(m.id)} aria-pressed={selectedThread}>
        <div className="message-row-top"><span className={`avatar ${owner?.provider === "slack" ? "purple" : ""}`}>{m.sender.slice(0, 1).toUpperCase()}</span><strong>{m.sender}</strong><time dateTime={receivedAt || undefined} title={receivedAt ? formatDate(receivedAt, true) : "Mailbox date unavailable"}>{receivedAt ? formatDate(receivedAt) : latest.browser?.dateText || "Date unknown"}</time></div>
        <h3>{m.unread && <span className="unread-dot"/>}{m.subject || "Untitled conversation"}</h3><p>{m.body.slice(0, 130)}</p>
        <span className="caption">{owner ? inboxLabel(owner) : "Disconnected inbox"} · {data.sources.find(item => item.id === m.sourceId)?.name || "Archived source"}</span>
        {m.browser && <span className="caption">Captured {formatDate(m.browser.capturedAt, true)} · {m.browser.completeness === "preview" ? "Inbox preview" : "Loaded message"}</span>}
      </button>;
    }) : <Empty title="No messages here"><p>Choose a different inbox, or select sources and refresh. Hidden browser pages need background refresh enabled.</p></Empty>}</section>
    <section className="conversation" aria-label="Conversation reader">{current ? <><div className="conversation-header"><div><span className="eyebrow">CONVERSATION</span><h2>{current.subject || "Untitled conversation"}</h2></div><div className="button-row">{email.canLoad && <button className="secondary small" disabled={email.loading} onClick={email.reload}><RefreshCw size={15}/>{email.error ? "Retry full email" : "Reload full conversation"}</button>}<button className="icon-button" aria-label="Open original message" title="Open original message" onClick={() => void run({ type: "open.message", messageId: current.id })}><ExternalLink size={18}/></button></div></div>
      {email.loading && <p className="quiet-note" role="status"><LoaderCircle size={18} className="spin"/>Loading the complete conversation from your paired browser...</p>}
      {email.error && <p role="alert" className="quiet-note">{email.error} Previously captured content is shown below.</p>}
      {email.loadedAt && <p className="caption" role="status">{thread.length} complete message{thread.length === 1 ? "" : "s"} · Loaded {formatDate(email.loadedAt, true)} · Formatting preserved, remote images blocked</p>}
      <div className="thread">{thread.map((m) => <article className="thread-message" key={m.id}><div className="thread-meta"><div><strong>{m.sender}</strong><p>To: {m.recipients.join(", ") || "Not available"}</p></div><time>{formatDate(m.receivedAt, true)}</time></div>{m.browser?.completeness === "preview" && <Badge tone="amber">Inbox preview - full message not loaded yet</Badge>}<EmailBody body={m.body} html={m.html}/>{email.attachments.filter((a) => a.messageId === m.id).map((a) => <AttachmentRow key={a.id} attachment={a} run={run} busy={busy}/>)}</article>)}</div>{!email.loading && email.replyMessage && <DraftEditor key={email.replyMessage.id} {...{ data, run, busy }} message={email.replyMessage}/>}</> : <Empty icon={<MessageSquare size={36}/>} title="Give a conversation your attention"><p>Select a message to see its thread, files, and editable reply. Remote images and embedded content are never loaded.</p></Empty>}</section></div>
  </div>;
}

function DraftEditor({ data, run, busy, message }: Shared & { message: Message }) {
  const versions = data.drafts.filter((d) => d.messageId === message.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [draftId, setDraftId] = useState(versions[0]?.id || "");
  const draft = versions.find((d) => d.id === draftId) || versions[0];
  const [edit, setEdit] = useState({ body: draft?.body || "", subject: draft?.subject || `Re: ${message.subject}`, recipients: draft?.recipients.join(", ") || message.sender });
  const savedSignature = useRef(draft ? draftSignature(draft) : "");
  const [dirty, setDirty] = useState(false);
  const editVersion = useRef(0);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState(data.settings.model);
  const account = data.accounts.find((a) => a.id === message.accountId);
  const nativeDraft = nativeDraftSupport(message, data.accounts);
  const eligible = account?.aiEnabled && account.consent && data.sources.some((s) => s.id === message.sourceId && s.selected);
  const available = data.copilot.status === "ready" && data.models.some((m) => m.id === model) && eligible;
  useEffect(() => {
    if (draft && !draftId) setDraftId(draft.id);
    if (draft && !dirty) {
      const signature = draftSignature(draft);
      if (signature !== savedSignature.current) { setEdit({ body: draft.body, subject: draft.subject, recipients: draft.recipients.join(", ") }); savedSignature.current = signature; }
    }
  }, [draft, draftId, dirty]);
  const update = (field: keyof typeof edit, value: string) => { editVersion.current++; setEdit((old) => ({ ...old, [field]: value })); setDirty(true); };
  const saveLocal = async (): Promise<boolean> => {
    if (!draft) return false;
    const versionAtSave = editVersion.current;
    const recipients = splitAddresses(edit.recipients);
    const result = await run({ type: "draft.edit", draftId: draft.id, body: edit.body, subject: edit.subject, recipients }, "Local draft saved.");
    if (result) {
      savedSignature.current = draftSignature({ ...edit, recipients });
      if (editVersion.current === versionAtSave) { setDirty(false); return true; }
    }
    return false;
  };
  const generate = async () => {
    if (dirty && !(await saveLocal())) return;
    const versionAtGenerate = editVersion.current;
    const result = await run({ type: "draft.generate", messageId: message.id, instruction: instruction || undefined, model }, "Draft generated locally. Review before saving to your provider.");
    if (result?.draftId && editVersion.current === versionAtGenerate) setDraftId(result.draftId);
  };
  return <section className="draft-editor"><div className="section-heading"><h2><Sparkles size={17}/> Your reply, your words</h2>{draft && <Badge tone={draft.status === "stale" || draft.status === "uncertain" ? "amber" : "teal"}>{dirty ? "Unsaved edits" : draft.status}</Badge>}</div>
    <p className="caption">{activeAi(data).name} receives authorized thread context. Nothing is sent. {nativeDraft.note}</p>
    {message.browser && <p className="inline-warning">Browser {message.browser.completeness === "preview" ? "draft source is an earlier inbox preview; complete captured messages appear above when available" : "loaded conversation text"}.
      {message.browser.dateText && ` Date shown by Gmail: ${message.browser.dateText}.`} Captured {formatDate(message.browser.capturedAt, true)}. This is not a full-mailbox sync.
      {account?.connection === "browser" && nativeDraft.enabled && " When you generate manually, Relay Desk uses the same-email Gmail API authorization to verify the thread before any native draft save."}</p>}
    {versions.length > 1 && <label>Saved local versions<select aria-label="Saved local draft versions" value={draft?.id || ""} disabled={dirty || busy} onChange={(e) => { setDraftId(e.target.value); savedSignature.current = ""; }}>{versions.map((d) => <option key={d.id} value={d.id}>{formatDate(d.updatedAt, true)} · {d.model || "Local draft"} · {d.status}</option>)}</select>{dirty && <span className="caption">Save your edits before switching versions.</span>}</label>}
    <div className="draft-controls"><ModelSelect data={data} value={model} onChange={setModel} label="Draft model"/><input aria-label="Draft instructions" value={instruction} placeholder="Optional: a warmer tone, a shorter reply…" onChange={(e) => setInstruction(e.target.value)}/></div>
    {!eligible && <p className="inline-warning">Enable this account's AI consent and select this source in Settings to generate replies.</p>}
    {draft ? <><div className="form-grid"><label>Recipients<input value={edit.recipients} onChange={(e) => update("recipients", e.target.value)}/></label><label>Subject<input value={edit.subject} onChange={(e) => update("subject", e.target.value)}/></label></div><label className="sr-only" htmlFor={`draft-${message.id}`}>Reply draft</label><textarea id={`draft-${message.id}`} className="draft-body" rows={8} value={edit.body} onChange={(e) => update("body", e.target.value)}/>{dirty && draftSignature(draft) !== savedSignature.current && <p className="inline-warning">A newer stored version exists. Your edits have been preserved; review before saving.</p>}{(draft.status === "stale" || draft.status === "uncertain") && <p className="inline-warning">This draft is {draft.status}. Review the latest thread and provider state before retrying any native save.</p>}<Citations items={draft.citations} run={run}/><p className="caption">Generated with {draft.model || "model not recorded"} · {formatDate(draft.updatedAt, true)}</p></> : <div className="draft-placeholder">A thoughtful first draft starts here. Select an available model, then generate a reply you can make your own.</div>}
    {draft && account?.provider === "gmail" && nativeDraft.enabled && <button disabled={busy || draft.status === "uncertain" || draft.status === "stale"} onClick={async () => {
      const version = editVersion.current, reviewed = { ...edit, recipients: splitAddresses(edit.recipients) };
      const result = await run({ type: "draft.handoff", draftId: draft.id, ...reviewed });
      if (result) {
        savedSignature.current = draftSignature(reviewed);
        if (version === editVersion.current) setDirty(false);
      }
    }}><ArrowRight size={15}/>Save &amp; open in Gmail</button>}
    <div className="button-row wrap"><button disabled={busy || !available || (dirty && !draft)} onClick={() => void generate()}><Sparkles size={15}/>{draft ? dirty ? "Save edits & generate another" : "Generate another draft" : "Generate a reply"}</button>{draft && <><button className="secondary" disabled={busy || !dirty} onClick={() => void saveLocal()}><Check size={15}/>Save locally</button><button className="secondary" disabled={busy} onClick={() => void run({ type: "clipboard.copy", text: edit.body }, "Copied to clipboard.")}>Copy reply</button>{account?.provider !== "slack" && nativeDraft.enabled && <button className="secondary" disabled={busy || draft.status === "uncertain"} onClick={async () => { if (await saveLocal()) await run({ type: "draft.save", draftId: draft.id }, "Native draft saved. Open your email application to review and send."); }}><ArrowDownToLine size={15}/>Save draft to {account?.provider === "gmail" ? "Gmail" : "Outlook"}</button>}</>}</div>
  </section>;
}

function AttachmentRow({ attachment: a, run, busy }: { attachment: Attachment; run: Run; busy: boolean }) {
  const actionable = ["pending", "awaiting-approval", "failed", "cancelled"].includes(a.status);
  return <div className="attachment"><Paperclip size={18}/><div className="attachment-details"><strong>{a.name}</strong><small>{fileSize(a.size)} · {a.mimeType} · {a.status}</small>{a.reason && <p>{a.reason}</p>}</div><DocumentActions attachmentId={a.id}/>{a.browser ? <BrowserAttachmentAction attachment={a} run={run} busy={busy}/> : actionable && <button className="secondary small" disabled={busy} onClick={() => void run({ type: "attachment.process", attachmentId: a.id, approved: true }, "Attachment processing requested.")}>{a.status === "awaiting-approval" ? "Approve processing" : a.status === "failed" ? "Retry" : "Process"}</button>}</div>;
}

function ArchivePage({ data, run, busy }: Shared) {
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const [model, setModel] = useState(data.settings.model);
  const [result, setResult] = useState<CommandResult>();
  const [lastQuery, setLastQuery] = useState("");
  const [mode, setMode] = useState<"search" | "ask">("search");
  const execute = async (type: "search" | "ask") => {
    if (!query.trim()) return;
    setMode(type); setResult(undefined);
    const response = await run(type === "ask" ? { type, query: query.trim(), accountId: account || undefined, model } : { type, query: query.trim(), accountId: account || undefined });
    if (response) { setResult(response); setLastQuery(query.trim()); }
  };
  return <div className="page"><PageTitle eyebrow="YOUR HISTORY, WITH CONTEXT" title="Find the thread that connects it." description="Search your local archive, or ask your AI assistant a question grounded in permitted sources."/>
    <section className="card archive-search"><div className="archive-heading"><div className="empty-icon"><Search size={26}/></div><div><h2>Good answers start with your sources.</h2><p>{data.archive.messages.toLocaleString()} messages · {data.archive.attachments.toLocaleString()} attachments · {data.archive.indexed.toLocaleString()} indexed</p></div><Badge tone="teal">{data.archive.searchMode === "hybrid" ? "Hybrid search" : "Keyword-only search"}</Badge></div><form onSubmit={(e) => { e.preventDefault(); void execute("search"); }}><label className="sr-only" htmlFor="archive-query">Search query or question</label><textarea id="archive-query" rows={3} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What did we decide about the launch timeline?"/><div className="archive-toolbar"><select aria-label="Archive account" value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All permitted accounts</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><ModelSelect data={data} value={model} onChange={setModel} label="Answer model"/><div className="button-row"><button type="submit" className="secondary" disabled={busy || !query.trim()}><Search size={16}/>Search locally</button><button type="button" disabled={busy || !query.trim() || data.copilot.status !== "ready" || !data.models.some((m) => m.id === model)} onClick={() => void execute("ask")}><Sparkles size={16}/>Ask Copilot</button></div></div></form><p className="caption"><LockKeyhole size={12}/> Search stays local. Ask shares relevant AI-authorized excerpts with Copilot. Imports and extraction may be incomplete; excluded sources are never searched.</p></section>
    {result ? <section className="card search-results"><span className="eyebrow">{mode === "ask" ? "GROUNDED ANSWER" : "LOCAL RESULTS"}</span><h2>{lastQuery}</h2>{result.answer && <div className="plain-body answer">{result.answer}</div>}{result.citations?.length ? result.citations.map((c, i) => <article className="search-result" key={`${c.id}-${i}`}><span className="result-number">{i + 1}</span><div><h3>{c.title}</h3><p className="plain-body">{c.excerpt}</p>{c.location && <small>{c.location}</small>}<button className="text-button" onClick={() => void run({ type: "open.message", messageId: c.messageId })}>Open source <ExternalLink size={13}/></button></div></article>) : <Empty title="No supporting sources found"><p>Try a name, a phrase, or a different account. Check selected sources and import progress.</p></Empty>}</section> : <div className="archive-empty"><Database size={32}/><h3>It’s in there somewhere.</h3><p>Bring older decisions, details, and documents back into focus.<br/>Every supported answer links back to the evidence.</p></div>}
  </div>;
}

function CalendarPage({ data, run, busy }: Shared) {
  const calendars = data.sources.filter((s) => s.kind === "calendar" && s.selected && data.accounts.some((a) => a.id === s.accountId && a.status === "connected" && a.connection !== "browser"));
  const blank = (): EventChange => ({ accountId: calendars[0]?.accountId || "", sourceId: calendars[0]?.id || "", title: "", start: "", end: "", allDay: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, attendees: [], location: "", description: "" });
  const [change, setChange] = useState<EventChange>(blank);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [proposalId, setProposalId] = useState("");
  const preview = data.approvals.find((a) => a.id === proposalId);
  const patch = (value: Partial<EventChange>) => { setChange((old) => ({ ...old, ...value })); setProposalId(""); };
  const propose = async (e: FormEvent) => {
    e.preventDefault();
    const exactChange = { ...change, attendees: change.attendees.map((a) => a.trim()).filter(Boolean) };
    const validation = validateEvent(exactChange);
    if (validation) { setError(validation); return; }
    setError("");
    const result = await run({ type: "calendar.propose", change: exactChange });
    if (result?.approvalId) setProposalId(result.approvalId);
  };
  const editEvent = (event: CalendarEvent) => { setChange(eventChange(event)); setEditing(true); setProposalId(""); setError(""); };
  return <div className="page"><PageTitle eyebrow="MAKE SPACE FOR WHAT MATTERS" title="Your calendar, considered." description="A clear agenda across your accounts, with overlaps, important events, and times that need another look." action={<button disabled={!calendars.length || busy} onClick={() => { setChange(blank()); setEditing(true); setProposalId(""); }}><Plus size={16}/>Propose an event</button>}/>
    <div className={`calendar-layout ${editing ? "editing" : ""}`}><CalendarAgenda {...{ data, run, busy }} onEdit={editEvent} editableSources={calendars.map(calendar => calendar.id)}/>
    {editing && <section className="card event-form"><div className="section-heading"><h2>{change.eventId ? "Propose a change" : "New event proposal"}</h2><button className="icon-button" aria-label="Close event form" onClick={() => setEditing(false)}><X size={17}/></button></div><form onSubmit={(e) => void propose(e)}><label>Calendar<select required value={change.sourceId} disabled={Boolean(change.eventId)} onChange={(e) => patch({ sourceId: e.target.value, accountId: calendars.find((s) => s.id === e.target.value)?.accountId || "" })}><option value="">Choose calendar</option>{calendars.map((s) => <option key={s.id} value={s.id}>{data.accounts.find((a) => a.id === s.accountId)?.name} · {s.name}</option>)}</select></label><label>Event title<input required value={change.title} onChange={(e) => patch({ title: e.target.value })}/></label><label className="checkbox-label"><input type="checkbox" checked={change.allDay} onChange={(e) => patch({ allDay: e.target.checked, start: "", end: "" })}/>All-day event</label><div className="form-grid">{(["start", "end"] as const).map((key) => <label key={key}>{key === "start" ? "Starts" : change.allDay ? "Ends (exclusive date)" : "Ends"}<input required type={change.allDay ? "date" : "datetime-local"} value={change.allDay ? change[key] : localDateTime(change[key])} onChange={(e) => patch({ [key]: !e.target.value ? "" : change.allDay ? e.target.value : new Date(e.target.value).toISOString() })}/></label>)}</div><p className="caption">Timed inputs use your device zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}); the preview shows exact UTC instants. For all-day events, the end date is exclusive.</p><label>Event time zone<input required value={change.timeZone} onChange={(e) => patch({ timeZone: e.target.value })}/></label><label>Attendees (comma-separated email addresses)<input value={change.attendees.join(", ")} onChange={(e) => patch({ attendees: e.target.value.split(",").map((v) => v.trim()) })}/></label><label>Location<input value={change.location} onChange={(e) => patch({ location: e.target.value })}/></label><label>Description<textarea rows={3} value={change.description} onChange={(e) => patch({ description: e.target.value })}/></label><div className="inline-warning"><CircleAlert size={16}/>Calendar providers may send invitations or update notices to attendees. No change is made until you approve the exact preview.</div>{error && <p className="inline-error" role="alert">{error}</p>}<button disabled={busy} type="submit"><CalendarDays size={16}/>Preview exact changes</button></form>{preview && <ApprovalCard approval={preview} data={data} run={run} busy={busy}/>}</section>}</div>
  </div>;
}

function ApprovalCard({ approval: a, data, run, busy }: { approval: Approval; data: Snapshot; run: Run; busy: boolean }) {
  const c = a.change;
  const previous = c.eventId ? data.events.find((e) => e.id === c.eventId) : undefined;
  return <article className="approval-card"><div className="section-heading"><h3>{c.eventId ? "Update event" : "Create event"} · exact preview</h3><Badge tone={a.status === "done" ? "teal" : "amber"}>{a.status}</Badge></div><dl className="preview-fields"><dt>Account</dt><dd>{data.accounts.find((x) => x.id === c.accountId)?.name || c.accountId}</dd><dt>Calendar</dt><dd>{data.sources.find((s) => s.id === c.sourceId)?.name || c.sourceId}</dd><dt>Title</dt><dd>{c.title}</dd><dt>Start</dt><dd>{c.start}</dd><dt>End</dt><dd>{c.end}{c.allDay && " (exclusive)"}</dd><dt>Time zone</dt><dd>{c.timeZone}</dd><dt>All-day</dt><dd>{c.allDay ? "Yes" : "No"}</dd><dt>Attendees</dt><dd>{c.attendees.filter(Boolean).join(", ") || "None"}</dd><dt>Location</dt><dd>{c.location || "None"}</dd><dt>Description</dt><dd className="plain-body">{c.description || "None"}</dd>{c.expectedRevision && <><dt>Expected revision</dt><dd>{c.expectedRevision}</dd></>}</dl>{previous && <details><summary>Current event before change</summary><p className="plain-body">{previous.title}{"\n"}{previous.start} → {previous.end}{"\n"}{previous.timeZone}{"\n"}{previous.attendees.join(", ")}{"\n"}{previous.location}{"\n"}{previous.description}</p></details>}<div className="inline-warning"><CircleAlert size={17}/><span>{a.effect} Calendar invitations or update notices may be sent to attendees by your provider.</span></div>{a.error && <p className="inline-error" role="alert">{a.error}</p>}{a.status === "pending" && <button disabled={busy} onClick={() => void run({ type: "calendar.approve", approvalId: a.id, hash: a.hash }, "Calendar approval processed.")}><Check size={16}/>Approve this exact change</button>}{a.status === "uncertain" && <p className="caption">Outcome uncertain. Check your original calendar before creating another proposal.</p>}</article>;
}

function ActivityPage({ data, run, busy }: Shared) {
  const files = data.attachments.filter((a) => a.status === "awaiting-approval");
  const approvals = [...data.approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <div className="page"><PageTitle eyebrow="NOTHING HAPPENS IN THE DARK" title="Activity & approvals" description="See what is importing, what needs your permission, and what needs another look." action={<button className="secondary" disabled={busy} onClick={() => void run({ type: "settings.update", patch: { syncPaused: !data.settings.syncPaused } }, data.settings.syncPaused ? "Sync resumed." : "Sync paused.")}>{data.settings.syncPaused ? <Play size={15}/> : <Pause size={15}/>} {data.settings.syncPaused ? "Resume sync" : "Pause sync"}</button>}/>
    <div className="activity-grid"><section><div className="section-heading"><h2>Needs your permission</h2><Badge tone="amber">{files.length + approvals.filter((a) => a.status === "pending").length}</Badge></div><div className="card"><div className="setting-row compact"><div><strong>Approve automatically</strong><p>{data.settings.autoApprove
        ? `On: files above ${data.settings.attachmentThresholdMb} MB, unknown-size downloads, costly extraction and calendar changes without attendees go ahead without asking. Changes that would notify attendees still wait here.`
        : `Off: files above ${data.settings.attachmentThresholdMb} MB, unknown-size downloads, costly extraction and every calendar change wait for your approval.`} Safety and resource limits always apply.</p></div>
        <button type="button" role="switch" aria-checked={data.settings.autoApprove} aria-label="Approve automatically" className={`toggle ${data.settings.autoApprove ? "on" : ""}`} disabled={busy}
          onClick={() => void run({ type: "settings.update", patch: { autoApprove: !data.settings.autoApprove } }, data.settings.autoApprove ? "Approvals will wait for you." : "Approvals are now automatic.")}><span/></button></div>{files.map((a) => <AttachmentRow key={a.id} attachment={a} run={run} busy={busy}/>)}{!files.length && <p className="caption">No files waiting for approval.</p>}</div>{approvals.map((a) => <ApprovalCard key={a.id} approval={a} {...{ data, run, busy }}/>)}</section>
    <section><div className="section-heading"><h2>Background work</h2><Activity size={18}/></div><div className="card">{data.jobs.length ? [...data.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((j) => <div className="job" key={j.id}><div className="section-heading"><strong>{j.label}</strong><Badge tone={j.status === "failed" ? "rose" : j.status === "done" ? "teal" : ""}>{j.status}</Badge></div><p>{j.detail || j.kind}</p>{j.status === "running" && <progress aria-label={`${j.label} progress`} value={j.progress} max={j.progress > 1 ? 100 : 1}/>}<div className="section-heading"><small>{formatDate(j.updatedAt, true)}</small>{j.status === "failed" && <button className="text-button" disabled={busy} onClick={() => void run({ type: "job.retry", jobId: j.id }, "Retry requested.")}><RefreshCw size={13}/>Retry job</button>}</div></div>) : <Empty icon={<Activity size={28}/>} title="Nothing in the queue"><p>Import, extraction, and AI activity will appear here.</p></Empty>}</div></section></div>
    <section className="card all-files"><div className="section-heading"><h2>Attachment library</h2><span className="caption">{data.attachments.length} discovered files</span></div>{data.attachments.length ? data.attachments.map((a) => <AttachmentRow key={a.id} attachment={a} run={run} busy={busy}/>) : <p className="muted">Files appear as your selected sources import. Unsupported or unsafe files remain visible with an explanation.</p>}</section>
  </div>;
}

