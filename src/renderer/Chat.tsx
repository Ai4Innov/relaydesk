import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Activity, ArrowDown, ArrowUp, CalendarDays, Check, CheckCheck, CircleAlert, Download, ExternalLink, FileText, Inbox, LoaderCircle, MessageSquare, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { FullAccessButton } from "./FullAccessButton";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";
import { chatFileOpenable, skipsChatMailRefresh, type ChatAction, type ChatConversation, type ChatFile, type ChatMailRefresh, type ChatPermission, type ChatTurn } from "../shared/chat";
import { RichMessage } from "./RichMessage";
import { ActionPreview } from "./ActionPreview";
import { CalendarAccessCard } from "./CalendarAccessCard";
import { SetupGuide, useSetupGuide } from "./SetupGuide";
import { accessibleDocument, DocumentActions } from "./DocumentViewer";
import "./chat.css";
import { activeAi } from "./ai";

const CONNECT_TITLES = { copilot: "Bring your Copilot subscription.", claude: "Bring your Anthropic API key.", codex: "Bring your ChatGPT plan through Codex." } as const;

type Run = (command: Command, success?: string) => Promise<CommandResult | undefined>;
type ToolPage = "inbox" | "productivity" | "calendar" | "activity" | "settings" | "archive";
interface ChatProps { data: Snapshot; run: Run; navigate: (page: ToolPage) => void }
interface PendingQuestion { draft: string; selectedId: string; conversationId?: string; model: string; scope: string }
const starters = [
  { title: "What needs my attention?", detail: "Find urgent mail and next steps", text: "Which of my authorized messages need attention? Cite the evidence and suggest next steps.", icon: Inbox },
  { title: "Make room for today", detail: "Summarize my schedule", text: "Summarize my available calendar and flag any scheduling gaps or conflicts. Be clear about missing coverage.", icon: CalendarDays },
  { title: "Help me draft a reply", detail: "Find the context, then draft", text: "Help me draft a reply. Ask me which conversation to use, and keep the reply as a draft.", icon: FileText },
  { title: "Turn a thought into a task", detail: "Create a practical next step", text: "Help me create a task. Ask me for the title, priority, and any due date before proposing it.", icon: CheckCheck },
  { title: "Catch up on my archive", detail: "Review authorized sources", text: "Review my authorized archive for important follow-ups. Explain what has and has not been covered.", icon: Search },
] as const;
const quickTools = [
  { page: "inbox", title: "Inbox", icon: Inbox }, { page: "productivity", title: "Tasks", icon: CheckCheck },
  { page: "calendar", title: "Calendar", icon: CalendarDays }, { page: "activity", title: "Activity", icon: Activity },
  { page: "settings", title: "Settings", icon: Settings2 },
] as const;

export function shouldSendChat(event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "shiftKey" | "nativeEvent">) {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

function ActionCard({ action, turn, conversation, run, blocked }: {
  action: ChatAction; turn: ChatTurn; conversation: ChatConversation; run: Run; blocked: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const confirmationLock = useRef(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (confirmationLock.current || blocked || action.status !== "pending") return;
    confirmationLock.current = true;
    setSubmitting(true); setError("");
    try {
      const result = await run({ type: "chat.confirm", conversationId: conversation.id, turnId: turn.id, actionId: action.id });
      if (!result) {
        confirmationLock.current = false; setSubmitting(false);
        setError("The action was not confirmed. Check Activity or try again.");
      }
    } catch {
      confirmationLock.current = false; setSubmitting(false);
      setError("The action could not be confirmed. Check Activity before retrying.");
    }
  };
  return <section className={`chat-action chat-action-${action.status}`} aria-label={`Action: ${action.title}`}>
    <div className="chat-action-heading">{action.status === "completed" ? <CheckCheck size={17}/> : action.status === "uncertain" ? <TriangleAlert size={18}/> : action.status === "failed" || action.status === "needs-user" ? <CircleAlert size={18}/> : action.status === "running" ? <LoaderCircle size={17} className="spin"/> : <ShieldCheck size={17}/>}<h3>{action.title}</h3><span className="badge" role="status">{action.status === "pending" ? "Awaiting confirmation" : action.status === "needs-user" ? "Browser review required" : action.status === "uncertain" ? "Save not verified" : action.status}</span></div>
    <p>{action.description}</p>
    {action.status === "needs-user" && <div className="chat-action-outcome" role="status"><strong>Continue in the original browser</strong><p>Additional confirmation or an unsupported state needs your attention in Google Calendar. Relay Desk has not confirmed a save. Review the event there; this card cannot be confirmed again.</p></div>}
    {action.status === "uncertain" && <div className="chat-action-outcome" role="status"><strong>Save attempted · outcome unknown</strong><p>The change may or may not have been saved. Check the event in the original browser before taking another action. Do not retry this action.</p></div>}
    <ActionPreview preview={action.preview}/>
    {action.status === "pending" && <><p className="caption">Confirm only after reviewing this preview. Native writes still use their existing approval flow. Messages are never sent.</p><button className="small" disabled={submitting || blocked} onClick={() => void confirm()}>{submitting ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>}Confirm action</button></>}
    {action.status === "running" && <p className="chat-progress" role="status"><LoaderCircle size={14} className="spin"/>Action in progress…</p>}
    {action.result && <p className={action.status === "failed" ? "chat-action-result inline-error" : "chat-action-result"}>{action.result}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </section>;
}

function PermissionCard({ permission, turn, conversation, run }: {
  permission: ChatPermission; turn: ChatTurn; conversation: ChatConversation; run: Run;
}) {
  const [sending, setSending] = useState(false);
  const decide = async (decision: "once" | "chat" | "deny") => {
    if (sending) return;
    setSending(true);
    try { await run({ type: "chat.permission", conversationId: conversation.id, turnId: turn.id, requestId: permission.id, decision }); }
    finally { setSending(false); }
  };
  const label = permission.status === "pending" ? (permission.risk ? "Sensitive: needs your approval" : "Needs your approval") : permission.status === "approved" ? "Allowed once"
    : permission.status === "approved-chat" ? "Allowed for this response" : permission.status === "denied" ? "Denied" : "Expired";
  return <section className={`chat-permission chat-permission-${permission.status}`} aria-label={`Permission request: ${permission.title}`}>
    <div className="chat-action-heading"><ShieldCheck size={17}/><h3>{permission.title}</h3><span className="badge" role="status">{label}</span></div>
    {permission.risk && <p className="chat-permission-risk" role="note"><strong>Safety check:</strong> this action {permission.risk}. It needs your decision before it runs.</p>}
    {permission.intention && <p>{permission.intention}</p>}
    <pre className="chat-permission-detail">{permission.detail}</pre>
    {permission.status === "pending" && <div className="button-row wrap">
      <button className="small" disabled={sending} onClick={() => void decide("once")}><Check size={14}/>Allow once</button>
      {!permission.risk && (permission.kind === "shell" || permission.kind === "url") && <button className="small secondary" disabled={sending} onClick={() => void decide("chat")}>Allow for this response</button>}
      <button className="small quiet" disabled={sending} onClick={() => void decide("deny")}><X size={14}/>Deny</button>
    </div>}
  </section>;
}

function AutoActions({ permissions }: { permissions: ChatPermission[] }) {
  if (!permissions.length) return null;
  return <details className="chat-auto-actions">
    <summary><ShieldCheck size={14}/>{permissions.length} action{permissions.length === 1 ? "" : "s"} ran automatically (passed the safety check)</summary>
    <ul>{permissions.map(permission => <li key={permission.id}><strong>{permission.title}</strong><pre className="chat-permission-detail">{permission.detail}</pre></li>)}</ul>
  </details>;
}

function FileCard({ file, turn, conversation, run }: { file: ChatFile; turn: ChatTurn; conversation: ChatConversation; run: Run }) {
  const open = (reveal: boolean) => void run({ type: "chat.openFile", conversationId: conversation.id, turnId: turn.id, path: file.path, reveal });
  const openable = chatFileOpenable(file.name);
  return <div className="chat-document-reference chat-file"><FileText size={18}/><span>{file.name}<small>{fileSizeLabel(file.size)} · {file.path}
    {!openable && " · Not opened directly: this file type can run code. Inspect it first."}</small></span>
    <div className="button-row">{openable && <button className="small secondary" onClick={() => open(false)}>Open</button>}<button className="small quiet" onClick={() => open(true)}>Show in folder</button></div></div>;
}
function fileSizeLabel(size: number): string {
  return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`;
}

export function Chat({ data, run, navigate }: ChatProps) {
  const conversations = data.chat?.conversations ?? [];
  const [selected, setSelected] = useState(data.chat?.activeConversationId ?? conversations[0]?.id ?? "");
  const conversation = conversations.find(item => item.id === selected);
  const transcriptVersion = JSON.stringify(conversation?.turns ?? []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[selected] ?? "";
  const [model, setModel] = useState(data.settings.model);
  const [requestPending, setRequestPending] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const pendingQuestionRef = useRef<PendingQuestion | null>(null);
  const localChoice = useRef<HTMLButtonElement>(null);
  const [deleteId, setDeleteId] = useState("");
  const [error, setError] = useState("");
  const [newMessages, setNewMessages] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const requestLock = useRef(false);
  const reconnectAttempted = useRef(false);
  const chatBusy = data.chat?.busy ?? false;
  const guide = useSetupGuide(data);
  const onboarding = guide.visible && !conversation?.turns.length;
  const blocked = chatBusy || requestPending;
  const ready = data.copilot.status === "ready";
  const ai = activeAi(data);
  const availableModel = data.models.some(item => item.id === model);
  const eligibleAccounts = data.accounts.filter(account => account.aiEnabled && account.consent && account.status === "connected");
  const eligibleSources = data.sources.filter(source => source.selected && eligibleAccounts.some(account => account.id === source.accountId));
  const scopedAccounts = eligibleAccounts.filter(account => eligibleSources.some(source => source.accountId === account.id));
  const mailScope = JSON.stringify(eligibleSources.filter(source => source.kind === "mail").map(source => [source.accountId, source.id]).sort());
  const hasMailSources = mailScope !== "[]";
  const calendarAccessAccounts = data.accounts.filter(account => account.connection === "browser" && account.status === "connected" && !account.aiEnabled && data.sources.some(source => source.accountId === account.id && source.kind === "calendar" && source.selected));
  const canSend = ready && availableModel && !!draft.trim() && !blocked;

  useEffect(() => {
    if (!reconnectAttempted.current && !data.demo && data.settings.model && data.copilot.status === "disconnected") {
      reconnectAttempted.current = true;
      void run({ type: "copilot.connect" });
    }
  }, [data.demo, data.settings.model, data.copilot.status, run]);
  useEffect(() => {
    if (!model && data.models.length) setModel(data.models.some(item => item.id === data.settings.model) ? data.settings.model : data.models[0].id);
  }, [model, data.models, data.settings.model]);
  useLayoutEffect(() => {
    // An empty conversation shows the welcome and setup guide, which must be read from the top.
    if (!conversation?.turns.length) { if (scroller.current) scroller.current.scrollTop = 0; }
    else if (nearBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    else setNewMessages(true);
  }, [selected, transcriptVersion]);
  useEffect(() => {
    if (pendingQuestion && (pendingQuestion.selectedId !== selected || pendingQuestion.conversationId !== conversation?.id || pendingQuestion.draft !== draft || pendingQuestion.model !== model || pendingQuestion.scope !== mailScope || blocked || !ready || !availableModel)) {
      pendingQuestionRef.current = null;
      setPendingQuestion(null);
    }
  }, [pendingQuestion, selected, conversation?.id, draft, model, mailScope, blocked, ready, availableModel]);
  useEffect(() => { if (pendingQuestion) localChoice.current?.focus(); }, [pendingQuestion]);
  const dismissRefresh = () => {
    pendingQuestionRef.current = null; setPendingQuestion(null);
  };
  const cancelRefresh = () => { dismissRefresh(); composer.current?.focus(); };
  const choose = (id: string) => {
    dismissRefresh();
    nearBottom.current = true; setNewMessages(false); setSelected(id); setDeleteId(""); setError("");
  };
  const scrollToLatest = () => {
    nearBottom.current = true; setNewMessages(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  const setDraft = (value: string) => {
    dismissRefresh();
    setDrafts(previous => ({ ...previous, [selected]: value }));
  };
  const submitQuestion = async (question: PendingQuestion, mailRefresh: ChatMailRefresh) => {
    if (!canSend || requestLock.current) return;
    if (question.selectedId !== selected || question.conversationId !== conversation?.id || question.draft !== draft || question.model !== model || question.scope !== mailScope) return;
    requestLock.current = true; setRequestPending(true); setError("");
    dismissRefresh();
    const text = question.draft.trim();
    const submittedDraft = question.draft;
    const submittedId = question.selectedId;
    nearBottom.current = true; setNewMessages(false);
    try {
      const result = await run({ type: "chat.send", conversationId: question.conversationId, text, model: question.model, mailRefresh });
      if (result) {
        setDrafts(previous => {
          const remaining = previous[submittedId] === submittedDraft ? "" : previous[submittedId] ?? "";
          const id = result.conversationId ?? submittedId;
          return { ...previous, [submittedId]: "", [id]: remaining };
        });
        if (result.conversationId) {
          const id = result.conversationId;
          setSelected(current => current === submittedId ? id : current);
        }
      } else setError("Your message was not accepted. Your text is still here; check the connection and try again.");
    } catch { setError("Could not send your message. Your text is still here."); }
    finally { requestLock.current = false; setRequestPending(false); composer.current?.focus(); }
  };
  const send = () => {
    if (!canSend || requestLock.current || pendingQuestionRef.current) return;
    const question = { draft, selectedId: selected, conversationId: conversation?.id, model, scope: mailScope };
    if (!data.settings.chatAskMailRefresh || !hasMailSources || skipsChatMailRefresh(question.draft)) {
      void submitQuestion(question, "local");
      return;
    }
    setError("");
    pendingQuestionRef.current = question;
    setPendingQuestion(question);
  };
  const chooseRefresh = (mailRefresh: ChatMailRefresh) => {
    if (!pendingQuestion || pendingQuestionRef.current !== pendingQuestion) return;
    void submitQuestion(pendingQuestion, mailRefresh);
  };
  const newChat = async () => {
    if (blocked || requestLock.current) return;
    dismissRefresh();
    requestLock.current = true; setRequestPending(true); setError("");
    try {
      const result = await run({ type: "chat.new" });
      if (result?.conversationId) choose(result.conversationId);
      else setError("Could not start a new conversation. Please try again.");
    } catch { setError("Could not start a new conversation. Please try again."); }
    finally { requestLock.current = false; setRequestPending(false); composer.current?.focus(); }
  };
  const deleteChat = async () => {
    if (!deleteId || blocked || requestLock.current) return;
    dismissRefresh();
    const id = deleteId;
    requestLock.current = true; setRequestPending(true); setError("");
    try {
      const result = await run({ type: "chat.delete", conversationId: id });
      if (result) {
        if (selected === id) choose(conversations.find(item => item.id !== id)?.id ?? "");
        setDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
        setDeleteId("");
      } else setError("The conversation could not be deleted. Please try again.");
    } catch { setError("The conversation could not be deleted. Please try again."); }
    finally { requestLock.current = false; setRequestPending(false); }
  };

  return <section className="chat-shell" aria-label="Assistant chat workspace">
    <aside className="chat-history" aria-label="Conversation history">
      <div className="chat-history-heading"><span className="eyebrow">YOUR CONVERSATIONS</span><button className="icon-button" aria-label="New chat" title="New chat" disabled={blocked} onClick={() => void newChat()}><Plus size={19}/></button></div>
      <div className="chat-history-list">
        {!conversations.length && <p className="chat-history-empty">A little less searching.<br/>A little more doing.<br/><span>Your conversations will live here.</span></p>}
        {[...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => <div className={`chat-history-item ${selected === item.id ? "selected" : ""}`} key={item.id}>
          <button className="chat-history-select" title={item.title} aria-current={selected === item.id ? "true" : undefined} onClick={() => choose(item.id)}><MessageSquare size={15}/><span>{item.title || "New conversation"}</span></button>
          <button className="icon-button" aria-label={`Delete conversation ${item.title || "New conversation"}`} disabled={blocked} onClick={() => setDeleteId(item.id)}><Trash2 size={14}/></button>
        </div>)}
      </div>
      {deleteId && <div className="chat-delete-confirm" role="group" aria-label="Confirm conversation deletion"><strong>Delete this conversation?</strong><p>Its saved messages and previews will be removed. Completed actions are not undone.</p><div className="button-row"><button className="small secondary" disabled={requestPending} onClick={() => setDeleteId("")}>Keep chat</button><button className="small" disabled={blocked} onClick={() => void deleteChat()}>Delete chat</button></div></div>}
      <div className="chat-history-footer"><ShieldCheck size={15}/><span>Saved in your encrypted local archive.</span></div>
    </aside>
    <div className="chat-main">
      <header className="chat-header"><div><div className="eyebrow">YOUR ASSISTANT, IN CONTEXT</div><h1>{conversation?.title || "Let's move work forward."}</h1></div><div className="chat-header-actions"><FullAccessButton data={data} run={run}/><span className={`chat-connection ${ready ? "ready" : ""}`}><span className="status-dot"/>{ready ? `${ai.name} connected` : data.copilot.status === "connecting" ? "Connecting…" : "Connect to begin"}</span></div></header>
      <div className="chat-scope"><ShieldCheck size={14}/><div><strong>AI scope: </strong>{scopedAccounts.length ? `${scopedAccounts.length} opted-in account${scopedAccounts.length === 1 ? "" : "s"} · ${eligibleSources.length} selected source${eligibleSources.length === 1 ? "" : "s"}` : "No connected, opted-in sources"}<span> · Only authorized imported context; browser captures may be partial.</span><details><summary>View coverage</summary><p>{scopedAccounts.length ? scopedAccounts.map(account => account.email || account.name).join(" · ") : "Choose sources and enable account AI consent in Settings. Chat does not grant source access."}</p>{data.aiReview && <p>Archive review: {data.aiReview.reviewed} of {data.aiReview.totalEligible} eligible messages reviewed; {data.aiReview.remaining} remaining. Excluded sources are not available to {ai.name}.</p>}<p>Selected sources are not a guarantee of full mailbox or calendar coverage. {ai.name} is a cloud service; your plan and model access apply.</p></details></div><button className="text-button" onClick={() => navigate("settings")}>Manage scope</button></div>
      {!ready && !onboarding && <div className="chat-connect-panel"><Sparkles size={21}/><div><strong>{CONNECT_TITLES[ai.id]}</strong><p>{data.copilot.message || `Connect ${ai.name} to ask questions and work with your authorized sources.`}</p></div><div className="button-row wrap"><button className="small" disabled={data.copilot.status === "connecting" || requestPending} onClick={() => void run({ type: "copilot.connect" })}>Connect {ai.name}</button>{ai.id === "claude" ? <button className="secondary small" onClick={() => navigate("settings")}>Add API key</button> : <button className="secondary small" disabled={data.copilot.status === "connecting" || requestPending} onClick={() => void run({ type: "copilot.login" })}>Sign in</button>}</div></div>}
      <div className="chat-transcript" ref={scroller} onScroll={() => {
        const element = scroller.current;
        if (element) { nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; if (nearBottom.current) setNewMessages(false); }
      }}>
        {calendarAccessAccounts.map(account => <CalendarAccessCard key={account.id} aiName={ai.name} account={account} sources={data.sources.filter(source => source.accountId === account.id && source.selected)} run={run} blocked={blocked} manageSources={() => navigate("settings")}/>)}
        {!conversation?.turns.length ? <div className={`chat-welcome${onboarding ? " onboarding" : ""}`}>{!onboarding && <div className="chat-welcome-icon"><Sparkles size={30}/></div>}<span className="eyebrow">LESS SWITCHING. MORE HEADSPACE.</span><h2>What can we take off your mind?</h2><p>Ask a question, find the context, or turn a conversation into a next step. You stay in control of every action.</p><SetupGuide data={data} guide={guide} run={run} openSettings={() => navigate("settings")} ask={text => { setDraft(text); composer.current?.focus(); }}/><div className="chat-starters">{starters.map(({ title, detail, text, icon: Icon }) => <button key={title} className="chat-starter" onClick={() => { setDraft(text); composer.current?.focus(); }}><Icon size={19}/><span><strong>{title}</strong><small>{detail}</small></span><ArrowUp size={14}/></button>)}</div><div className="chat-welcome-note"><ShieldCheck size={14}/> Review before acting. Replies stay drafts. Nothing is sent.</div></div> : null}
        <div role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions text" className="chat-turns">
          {conversation?.turns.map(turn => <article key={turn.id} className={`chat-turn chat-turn-${turn.role}`} aria-label={`${turn.role === "user" ? "You" : "Assistant"} message`}>
            <div className="chat-turn-meta"><span className="chat-avatar">{turn.role === "user" ? "Y" : <Sparkles size={15}/>}</span><strong>{turn.role === "user" ? "You" : "Assistant"}</strong>{turn.model && <span>{data.models.find(item => item.id === turn.model)?.name ?? turn.model}</span>}<time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></div>
            {turn.role === "assistant" && turn.mailRefresh === "local" && data.settings.chatAskMailRefresh && <p className="chat-mail-provenance"><Inbox size={14}/><span>Using saved messages · No download requested for this answer. Newer mail may not be included.</span></p>}
            {turn.mailRefresh !== "local" && !!turn.mailFreshness?.length && <details className="citations" aria-label="Inbox freshness">
              <summary>{turn.mailFreshness.every(result => result.status === "fresh") ? "Inbox refreshed before this answer" : "Inbox refresh incomplete - cached evidence may be stale"}</summary>
              {turn.mailFreshness.flatMap(result => result.sources.map(source => <div key={source.sourceId}>
                <strong>{data.accounts.find(account => account.id === source.accountId)?.email || "Selected inbox"}</strong>
                <p>{source.status === "fresh" ? "Confirmed refresh" : source.status === "partial" ? "Partial refresh" : "Refresh unavailable"}
                  {" · "}{source.downloaded} conversations downloaded{" · "}{source.pending} pending
                  {source.checkedAt && <>{" · "}<time dateTime={source.checkedAt}>{new Date(source.checkedAt).toLocaleString()}</time></>}</p>
                {source.reason && <p className="caption">{source.reason}</p>}
              </div>))}
              <p className="caption">Coverage is limited to the selected inbox view and downloaded messages, not the entire mailbox history.</p>
            </details>}
            {turn.text && (turn.role === "assistant" ? <RichMessage text={turn.text} copy={async text => !!(await run({ type: "clipboard.copy", text }))}/> : <div className="chat-turn-text">{turn.text}</div>)}
            {turn.status === "working" && <p className="chat-progress" role="status"><LoaderCircle size={15} className="spin"/>{turn.progress || "Thinking through your request…"}</p>}
            {turn.status === "error" && <p className="chat-turn-status inline-error" role="status"><CircleAlert size={14}/>This response could not be completed. {turn.progress || "Send your message again, or start a new conversation if it keeps failing."}</p>}
            {turn.status === "cancelled" && <p className="chat-turn-status"><Square size={12}/>Stopped. Completed actions are not undone.</p>}
            {!!turn.citations.length && <details className="citations chat-citations"><summary>{turn.citations.length} source{turn.citations.length === 1 ? "" : "s"} · inspect evidence</summary>{turn.citations.map(citation => <blockquote key={citation.id}><p>{citation.excerpt}</p>{citation.location && <p className="caption">{citation.location}</p>}<button className="text-button" onClick={() => void run({ type: "open.message", messageId: citation.messageId })}>{citation.title || "Source message"} <ExternalLink size={12}/><span className="sr-only">Open original</span></button></blockquote>)}</details>}
            {turn.citations.some(citation => citation.attachmentId && accessibleDocument(data, citation.attachmentId)?.messageId === citation.messageId) && <div className="chat-document-citations" aria-label="Documents referenced">{turn.citations.filter((citation, index, citations) => citation.attachmentId && accessibleDocument(data, citation.attachmentId)?.messageId === citation.messageId && citations.findIndex(item => item.attachmentId === citation.attachmentId) === index).map(citation => <div className="chat-document-reference" key={citation.attachmentId}><FileText size={18}/><span>{data.attachments.find(attachment => attachment.id === citation.attachmentId)?.name}<small>{citation.location || "Local source document"}</small></span><DocumentActions attachmentId={citation.attachmentId!} viewOnly/></div>)}</div>}
            {turn.permissions?.filter(permission => permission.status !== "auto").map(permission => <PermissionCard key={permission.id} permission={permission} turn={turn} conversation={conversation} run={run}/>)}
              <AutoActions permissions={turn.permissions?.filter(permission => permission.status === "auto") ?? []}/>
            {!!turn.files?.length && <div className="chat-document-citations" aria-label="Files created">{turn.files.map(file => <FileCard key={file.path} file={file} turn={turn} conversation={conversation} run={run}/>)}</div>}
            {turn.actions.map(action => <ActionCard key={action.id} action={action} turn={turn} conversation={conversation} run={run} blocked={blocked}/>)}
          </article>)}
        </div>
      </div>
      {newMessages && <button className="chat-latest secondary small" onClick={scrollToLatest}><ArrowDown size={14}/>Jump to latest</button>}
      <div className="chat-composer-area">
        {chatBusy && !conversation?.turns.some(turn => turn.status === "working") && <p className="chat-progress" role="status"><LoaderCircle size={14} className="spin"/>{ai.name} is working in another conversation.</p>}
        {error && <div className="chat-local-error" role="alert"><CircleAlert size={15}/><span>{error}</span><button className="icon-button" aria-label="Dismiss chat error" onClick={() => setError("")}><X size={14}/></button></div>}
        {pendingQuestion && <section className="chat-refresh-choice" role="group" aria-labelledby="chat-refresh-title" aria-describedby="chat-refresh-description" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelRefresh(); } }}>
          <div className="chat-refresh-heading"><span className="chat-refresh-icon"><Download size={19}/></span><div><span className="eyebrow">YOUR CHOICE · THIS QUESTION ONLY</span><h2 id="chat-refresh-title">Do you want to download latest messages before I answer?</h2></div></div>
          <p id="chat-refresh-description">Download from your authorized, selected mail sources, or answer now using messages already saved. Downloading may take a moment; coverage can be partial.</p>
          <div className="chat-refresh-buttons">
            <button type="button" className="small" disabled={!canSend} onClick={() => chooseRefresh("download")}><Download size={15}/>Yes, download latest</button>
            <button type="button" className="small secondary" ref={localChoice} disabled={!canSend} onClick={() => chooseRefresh("local")}><Inbox size={15}/>No, use saved messages</button>
            <button type="button" className="text-button" onClick={cancelRefresh}>Back to editing</button>
          </div>
        </section>}
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label htmlFor="chat-message" className="sr-only">Message {ai.name}</label>
          <textarea id="chat-message" ref={composer} rows={3} maxLength={12000} placeholder="Ask, plan, or tell me what you'd like to get done…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (shouldSendChat(event)) { event.preventDefault(); void send(); } }} aria-describedby="chat-composer-help"/>
          <div className="chat-composer-toolbar">
            <label className="model-select"><Sparkles size={14}/><span className="sr-only">Chat model</span><select aria-label="Chat model" value={model} disabled={!data.models.length} onChange={event => { dismissRefresh(); setModel(event.target.value); }}><option value="">{data.models.length ? "Choose a model" : "Connect for available models"}</option>{model && !availableModel && <option value={model} disabled>Unavailable: {model}</option>}{data.models.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <div className="button-row">{chatBusy
              ? <button key="stop" type="button" className="secondary small" disabled={requestPending} onClick={event => { event.preventDefault(); void run({ type: "chat.cancel" }); }}><Square size={13}/>Stop response</button>
              : <button key="send" type="submit" aria-label="Send message" className="chat-send" disabled={!canSend || !!pendingQuestion}>{requestPending ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={18}/>}</button>}
            </div>
          </div>
        </form>
        <div id="chat-composer-help" className="chat-composer-help"><span>{ready && !availableModel ? `Choose an available ${ai.name} model to send.` : "Enter to send · Shift + Enter for a new line"}</span><span>Review previews before confirming actions.</span></div>
        <nav className="chat-quick-tools" aria-label="Chat quick tools"><span>Open a tool</span>{quickTools.map(({ page, title, icon: Icon }) => <button key={page} className="quiet small" onClick={() => navigate(page)} aria-label={`Open ${title}`}><Icon size={13}/>{title}</button>)}</nav>
      </div>
    </div>
  </section>;
}
