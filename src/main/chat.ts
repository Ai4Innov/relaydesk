import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { host } from "./platform";
import type { AppTool as Tool, WorkspacePermissionRequest as PermissionRequest } from "./ai/agent";
import { z } from "zod";
import type { Account, Approval, Attachment, CalendarEvent, Citation, Collection, Command, CommandResult, Draft, Message, Settings, Snapshot, Source } from "../shared/contracts";
import { CHAT_MESSAGE_MAX, CHAT_PROMPT_MAX, ChatLimitError, chatFileOpenable, ChatTimeoutError, skipsChatMailRefresh, type ChatAction, type ChatCommand, type ChatConversation, type ChatPermission, type ChatState, type ChatTurn } from "../shared/chat";
import { CHAT_TOOL_CALL_MAX, ToolOutputBudget, toolErrorResult } from "./chat-tool-budget";
import { createDocument, DOCUMENT_FORMATS } from "./documents";
import { insidePath } from "./copilot/workspace-fs";
import type { TaskItem } from "../shared/productivity";
import type { BrowserCalendarItem } from "../shared/browser";
import type { Vault } from "./storage/vault";
import type { KnowledgeLibrary } from "./knowledge";
import type { AgentResponse, ChatAgentRequest } from "./copilot";
import { commandSchema } from "./ipc/schema";
import { payloadHash, validateApproval, validateChange } from "./approvals";
import { compareRecentMessages, messageReceivedAt } from "../shared/inbox";
import { fullThreadMessages, isMailPreview, mailboxThreadKey, mailEvidenceLocation, mailThreadKey, preferredMailEvidence } from "../shared/mail-evidence";
import { buildCalendarWorkspace } from "../shared/calendar";
import { browserCalendarRevision } from "./browser/calendar-revision";
import type { MailFreshnessRequest, MailFreshnessResult } from "../shared/mail-freshness";
import { mailOriginAllowed } from "../shared/mail-transport";

const KEY = "chat:v1";
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "missing").digest("hex");
const idSchema = z.string().min(1).max(2048);
const empty = z.object({}).strict();
export function chatFailureMessage(error: unknown): string {
  if (error instanceof ChatTimeoutError)
    return error.reason === "idle"
      ? "The AI provider stopped responding for three minutes. Retry this request or reconnect it in Settings. No pending action was executed."
      : "The AI provider reached the ten-minute request deadline. No pending action was executed. Retry for a fresh overview or split a large review into smaller parts.";
  if (error instanceof SyntaxError) return "The AI provider returned invalid response JSON. Try a shorter request; no pending action was executed.";
  if (error instanceof z.ZodError) return "The AI provider returned an unsupported response format. Regenerate the response; no pending action was executed.";
  const message = error instanceof Error ? error.message : "";
  if (/Source permissions changed|Evidence is no longer permitted/i.test(message))
    return "AI access to an account or source used in this conversation changed. Check Settings → Connections, then start a new conversation. No pending action was executed.";
  if (/Evidence changed/i.test(message))
    return "Calendar or message evidence changed while the assistant was working. Please retry with the refreshed sources. No pending action was executed.";
  if (/cited evidence it did not read/i.test(message))
    return "The AI provider returned an unverified citation. Regenerate the response; no pending action was executed.";
  if (/Another .*running|already running|AI is busy/i.test(message))
    return "Another AI request is running. Wait for it to finish, then try again. No pending action was executed.";
  if (/budget|daily.*limit|quota/i.test(message))
    return "The AI request limit or subscription quota was reached. Review usage in Settings before retrying.";
  if (/selected model is not available|Choose an? [A-Za-z ]+ model|No entitled|reported no available models/i.test(message))
    return "The selected model is unavailable. Choose an entitled model; Relay Desk will not switch models automatically.";
  if (/timeout|timed out/i.test(message))
    return "The AI provider did not respond before the connection timed out. Retry this request or reconnect it in Settings. No pending action was executed.";
  if (/returned no answer/i.test(message))
    return "The AI provider returned no final answer. Retry this request; no pending action was executed.";
  return "The AI provider could not complete this request. Check the selected model, connection, AI budget and source permissions, or ask a narrower question. No pending action was executed.";
}
// The installed SDK accepts JSON Schema or Zod 4; IPC uses Zod 3. Keep validation
// in the IPC schemas and translate only the small set of shapes used by app tools.
export function toolParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) {
    const inner = toolParameters(schema._def.innerType);
    return schema instanceof z.ZodNullable ? { anyOf: [inner, { type: "null" }] } : inner;
  }
  if (schema instanceof z.ZodEffects) return toolParameters(schema.innerType());
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return { type: "object", additionalProperties: false,
      properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, toolParameters(value)])),
      required: Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key) };
  }
  if (schema instanceof z.ZodString) {
    return { type: "string", ...(schema.minLength !== null ? { minLength: schema.minLength } : {}),
      ...(schema.maxLength !== null ? { maxLength: schema.maxLength } : {}) };
  }
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? "integer" : "number",
    ...(schema.minValue !== null ? { minimum: schema.minValue } : {}), ...(schema.maxValue !== null ? { maximum: schema.maxValue } : {}) };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodArray) return { type: "array", items: toolParameters(schema.element),
    ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}) };
  throw new Error("Unsupported app tool schema.");
}
const allowedActions = ["refresh.request", "task.create", "task.edit", "task.status", "task.schedule",
  "draft.generate", "draft.save", "draft.handoff", "report.generate", "review.start", "calendar.propose", "calendar.approve",
  "browser.calendar.move"] as const;
const actionTitles: Record<typeof allowedActions[number], string> = {
  "refresh.request": "Refresh inboxes", "task.create": "Create a local task", "task.edit": "Edit a local task",
  "task.status": "Update task status", "draft.generate": "Generate a local reply draft",
  "report.generate": "Generate a focus report", "review.start": "Start archive review",
  "calendar.propose": "Prepare a calendar approval", "calendar.approve": "Save the reviewed calendar change",
  "draft.save": "Save the reviewed mailbox draft", "draft.handoff": "Save the reviewed Gmail draft and open Gmail",
  "task.schedule": "Schedule a private task event", "browser.calendar.move": "Move meeting in Google Calendar"
};
type ProposedCommand = Extract<Command, { type: typeof allowedActions[number] }>;
interface Evidence {
  collection: Collection;
  id: string;
  accountId?: string;
  sourceId?: string;
  revision?: string;
  gmailApi?: Message["gmailApi"];
}
interface StoredAction extends ChatAction { command: ProposedCommand; guards: Evidence[]; review?: Record<string, unknown> }
interface StoredTurn extends Omit<ChatTurn, "actions"> { actions: StoredAction[]; evidence: Evidence[] }
interface StoredConversation extends Omit<ChatConversation, "turns"> { turns: StoredTurn[] }
interface StoredState { conversations: StoredConversation[]; activeConversationId?: string }
interface Hooks {
  changed(): void;
  settings(): Settings;
  workspace(): Snapshot;
  search(query: string, accountId: string): Promise<Citation[]>;
  generate(request: ChatAgentRequest): Promise<AgentResponse>;
  execute(command: ProposedCommand, beforeWrite?: () => void): Promise<CommandResult>;
  refreshMail?(request: MailFreshnessRequest): Promise<MailFreshnessResult>;
  workspaceDirectory?(): string;
  knowledge?: Pick<KnowledgeLibrary, "list" | "search" | "read">;
  openPath?(path: string, reveal: boolean): Promise<void>;
  attention?(title: string, body: string): void;
}
async function scanWorkspace(directory: string): Promise<Map<string, { mtime: number; size: number }>> {
  const found = new Map<string, { mtime: number; size: number }>();
  const walk = async (folder: string, depth: number) => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.size >= 2000) return;
      const path = host.path.join(folder, entry.name);
      if (entry.isDirectory()) { if (depth < 3 && !entry.name.startsWith(".")) await walk(path, depth + 1); }
      else if (entry.isFile()) {
        try { const info = await stat(path); found.set(path, { mtime: info.mtimeMs, size: info.size }); } catch { /* removed meanwhile */ }
      }
    }
  };
  await walk(directory, 0);
  return found;
}

export class ChatService {
  private state: StoredState;
  private active?: { conversationId: string; turn: StoredTurn; controller: AbortController; promise?: Promise<void>; permissions: string };
  private confirming = false;
  private confirmation?: Promise<CommandResult>;
  private stopped = false;
  private pendingPermissions = new Map<string, { turnId: string; conversationId: string; kind: ChatPermission["kind"]; finish(status: ChatPermission["status"]): void }>();

  constructor(private vault: Vault, private hooks: Hooks) {
    this.state = vault.get<StoredState>("checkpoints", KEY) ?? { conversations: [] };
    this.recover();
  }
  private persist(): void { this.vault.put("checkpoints", KEY, this.state); this.hooks.changed(); }
  /** Gmail connections (relay, API, browser) of the same address are one mailbox for evidence selection. */
  private readonly mailbox = (accountId: string): string | undefined => {
    const account = this.vault.get<Account>("accounts", accountId);
    return account?.provider === "gmail" && account.email.includes("@") ? account.email.trim().toLowerCase() : undefined;
  };
  private sameMailbox(a: string, requested: string): boolean {
    // Widen an account scope to sibling connections only when the requested account itself permits AI.
    const target = this.vault.get<Account>("accounts", requested);
    if (!target?.aiEnabled || !target.consent || target.status !== "connected") return false;
    const left = this.mailbox(a);
    return !!left && left === this.mailbox(requested);
  }
  recover(restored = false): void {
    this.state = this.vault.get<StoredState>("checkpoints", KEY) ?? { conversations: [] };
    for (const conversation of this.state.conversations) for (const turn of conversation.turns) {
      if (turn.status === "working") {
        turn.status = "cancelled"; turn.text = "Interrupted by application shutdown. Send a new message to continue."; turn.progress = undefined;
      }
      for (const permission of turn.permissions ?? []) if (permission.status === "pending") permission.status = "expired";
      for (const action of turn.actions) if (action.status === "running" || ((restored || turn.status === "cancelled") && action.status === "pending")) {
        action.status = "failed"; action.result = "Interrupted. Inspect the workspace before proposing this action again; it will not be retried automatically.";
      }
    }
    this.redact();
    this.persist();
  }
  private permitted(accountId: string, sourceId?: string): boolean {
    const account = this.vault.get<Account>("accounts", accountId);
    if (!account?.aiEnabled || !account.consent || account.status !== "connected") return false;
    if (!sourceId) return true;
    const source = this.vault.get<Source>("sources", sourceId);
    return !!source?.selected && source.accountId === accountId;
  }
  private permissions(): string {
    return hash({
      accounts: this.vault.all<Account>("accounts").map(a => [a.id, a.status, a.consent, a.aiEnabled, a.email, a.provider, a.connection]).sort(),
      sources: this.vault.all<Source>("sources").map(s => [s.id, s.accountId, s.selected]).sort()
    });
  }
  private valid(ref: Evidence, revisions = false): boolean {
    if (ref.accountId && !this.permitted(ref.accountId, ref.sourceId)) return false;
    if (ref.gmailApi && (!ref.accountId || !mailOriginAllowed(this.vault, { accountId: ref.accountId, gmailApi: ref.gmailApi }, true))) return false;
    const item = this.vault.get<Record<string, unknown>>(ref.collection, ref.id);
    if (ref.collection === "tasks" && ref.revision === hash(undefined)) return !revisions || item === undefined;
    if (!item || item.deleted) return false;
    if (ref.collection === "messages" && !this.messageAllowed(item as unknown as Message)) return false;
    if (ref.collection === "attachments") {
      const message = this.vault.get<Message>("messages", item.messageId as string);
      if (!message || !this.messageAllowed(message) || item.accountId !== message.accountId
        || !mailOriginAllowed(this.vault, { ...message, gmailApi: (item as unknown as Attachment).gmailApi }, true)) return false;
    }
    if (ref.accountId && item.accountId !== undefined && item.accountId !== ref.accountId) return false;
    if (ref.sourceId && item.sourceId !== undefined && item.sourceId !== ref.sourceId) return false;
    return !revisions || !ref.revision || ref.revision === this.revision(ref.collection, ref.id);
  }
  private revision(collection: Collection, id: string): string {
    if (collection === "browserItems") {
      const item = this.vault.get<BrowserCalendarItem>("browserItems", id);
      return item ? browserCalendarRevision(item) : hash(undefined);
    }
    if (collection === "messages") {
      const message = this.vault.get<Message>("messages", id);
      if (message?.browser) {
        const { capturedAt: _capturedAt, ...browser } = message.browser;
        return hash({ ...message, browser });
      }
    }
    const item = this.vault.get<Record<string, unknown>>(collection, id);
    // Refresh timestamps are not evidence or authority; background capture must
    // not invalidate an otherwise unchanged status/refresh proposal.
    if (item && (collection === "sources" || collection === "accounts")) {
      const { lastSync: _lastSync, ...stable } = item;
      return hash(stable);
    }
    return hash(item);
  }
  private track(turn: StoredTurn, collection: Collection, id: string, accountId?: string, sourceId?: string): Evidence {
    const origin = collection === "messages" || collection === "attachments"
      ? this.vault.get<Message | Attachment>(collection, id)?.gmailApi : undefined;
    const ref = { collection, id, accountId, sourceId, revision: this.revision(collection, id), gmailApi: origin };
    if (!this.valid(ref)) throw new Error("This source is unavailable or not permitted for AI.");
    if (!turn.evidence.some(e => e.collection === collection && e.id === id)) {
      if (turn.evidence.length >= 1000) this.limit("Chat evidence limit (1,000 dependencies) reached. Start a narrower conversation.");
      turn.evidence.push(ref);
    } else {
      const existing = turn.evidence.find(e => e.collection === collection && e.id === id)!;
      // Prior turns carry permission dependencies, not a claim that old evidence is current.
      if (!existing.revision) existing.revision = ref.revision;
    }
    if (origin) {
      this.track(turn, "accounts", origin.accountId, origin.accountId);
      this.track(turn, "sources", origin.sourceId, origin.accountId, origin.sourceId);
    }
    return ref;
  }
  private messageAllowed(message: Message): boolean {
    return !message.deleted && this.permitted(message.accountId, message.sourceId) && mailOriginAllowed(this.vault, message, true);
  }
  private message(id: string, turn: StoredTurn): Message {
    const message = this.vault.get<Message>("messages", id);
    if (!message || !this.messageAllowed(message))
      throw new Error("Message unavailable or not permitted for AI.");
    this.track(turn, "messages", id, message.accountId, message.sourceId);
    return message;
  }
  private addCitation(turn: StoredTurn, citation: Citation): void {
    const message = this.message(citation.messageId, turn);
    if (citation.attachmentId) {
      const attachment = this.vault.get<Attachment>("attachments", citation.attachmentId);
      if (!attachment || attachment.accountId !== message.accountId || attachment.messageId !== message.id ||
          !["indexed", "partial"].includes(attachment.status)) throw new Error("Attachment evidence is unavailable.");
      this.track(turn, "attachments", attachment.id, message.accountId, message.sourceId);
    }
    if (!turn.citations.some(c => c.id === citation.id)) turn.citations.push(citation);
  }
  private citationAllowed(citation: Citation): boolean {
    const message = this.vault.get<Message>("messages", citation.messageId);
    if (!message || !this.messageAllowed(message)) return false;
    if (!citation.attachmentId) return true;
    const attachment = this.vault.get<Attachment>("attachments", citation.attachmentId);
    return !!attachment && attachment.messageId === message.id && attachment.accountId === message.accountId &&
      mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi }, true) &&
      ["indexed", "partial"].includes(attachment.status);
  }
  private guard(turn: StoredTurn): void {
    this.active?.controller.signal.throwIfAborted();
    if (this.stopped) throw new Error("Chat is stopped.");
    if (this.active && this.permissions() !== this.active.permissions) throw new Error("Source permissions changed during this chat. Start a new request.");
    // Content updates (new mail, attachment processing, background review replacing suggested
    // tasks) do not invalidate a read-only answer; only consent/permission loss does. Every
    // write re-checks exact revisions and existence in its own action guards.
    if (!turn.evidence.every(ref => this.disclosable(ref))) throw new Error("Evidence is no longer permitted.");
  }
  permissionsChanged(): void {
    if (this.active && this.permissions() !== this.active.permissions) this.active.controller.abort();
    this.redact();
  }
  forgetAccount(accountId: string): void {
    this.purge(conversation => conversation.turns.some(turn => turn.evidence.some(ref =>
      ref.accountId === accountId || (ref.collection === "accounts" && ref.id === accountId))));
  }
  forgetSource(sourceId: string): void {
    this.purge(conversation => conversation.turns.some(turn => turn.evidence.some(ref =>
      ref.sourceId === sourceId || (ref.collection === "sources" && ref.id === sourceId))));
  }
  private purge(matches: (conversation: StoredConversation) => boolean): void {
    const removed = new Set(this.state.conversations.filter(conversation => matches(conversation) ||
      (conversation.title === "Conversation unavailable" && conversation.turns.length === 1 &&
        conversation.turns[0].status === "cancelled" && !conversation.turns[0].evidence.length)).map(conversation => conversation.id));
    if (!removed.size) return;
    if (this.active && removed.has(this.active.conversationId)) this.active.controller.abort();
    this.state.conversations = this.state.conversations.filter(conversation => !removed.has(conversation.id));
    if (this.state.activeConversationId && removed.has(this.state.activeConversationId))
      this.state.activeConversationId = this.state.conversations[0]?.id;
    this.persist();
  }
  private limit(message: string): never {
    const error = new ChatLimitError(message);
    this.active?.controller.abort(error);
    throw error;
  }
  private trackScope(turn: StoredTurn, accountId?: string, sourceId?: string): void {
    if (!accountId) return;
    if (sourceId) this.track(turn, "sources", sourceId, accountId, sourceId);
    else this.track(turn, "accounts", accountId, accountId);
  }
  private citationScope(turn: StoredTurn, citations: Citation[]): void {
    for (const citation of citations) {
      const message = this.vault.get<Message>("messages", citation.messageId);
      if (!message || !this.citationAllowed(citation)) throw new Error("Evidence is no longer permitted.");
      this.trackScope(turn, message.accountId, message.sourceId);
      this.track(turn, "messages", message.id, message.accountId, message.sourceId);
      if (citation.attachmentId) this.track(turn, "attachments", citation.attachmentId, message.accountId, message.sourceId);
    }
  }
  // Conversation-level redaction follows consent/permission loss only. Routine
  // provider churn (a message archived from a label, a review replacing its
  // suggested actions) must not erase an answer the user already saw; explicit
  // Forget operations purge affected conversations separately.
  private disclosable(ref: Evidence): boolean {
    if (ref.accountId && !this.permitted(ref.accountId, ref.sourceId)) return false;
    if (ref.gmailApi && (!ref.accountId || !mailOriginAllowed(this.vault, { accountId: ref.accountId, gmailApi: ref.gmailApi }, true))) return false;
    const item = this.vault.get<Record<string, unknown>>(ref.collection, ref.id);
    if (!item || item.deleted) return true;
    if (ref.collection === "messages") return this.permitted((item as unknown as Message).accountId, (item as unknown as Message).sourceId) &&
      mailOriginAllowed(this.vault, item as unknown as Message, true);
    if (ref.collection === "attachments") {
      const message = this.vault.get<Message>("messages", item.messageId as string);
      return !message || (this.permitted(message.accountId, message.sourceId) &&
        mailOriginAllowed(this.vault, { ...message, gmailApi: (item as unknown as Attachment).gmailApi }, true));
    }
    return true;
  }
  private redact(): void {
    let changed = false;
    for (const conversation of this.state.conversations) {
      if (!conversation.turns.some(turn => turn.evidence.some(ref => !this.disclosable(ref)))) continue;
      if (this.active?.conversationId === conversation.id) this.active.controller.abort();
      conversation.title = "Conversation unavailable";
      conversation.turns = [{
        id: randomUUID(), role: "assistant", createdAt: now(), status: "cancelled",
        text: "Earlier messages, results and previews were removed because their source is no longer permitted. Start a new conversation.",
        citations: [], actions: [], evidence: []
      }];
      changed = true;
    }
    if (changed) this.persist();
  }
  snapshot(): ChatState {
    this.permissionsChanged();
    return {
      activeConversationId: this.state.activeConversationId, busy: !!this.active || this.confirming,
      conversations: this.state.conversations.map(conversation => ({
        ...conversation, turns: conversation.turns.map(({ evidence: _evidence, actions, ...turn }) => ({
          ...turn, actions: actions.map(({ command: _command, guards: _guards, review: _review, ...action }) => action)
        }))
      }))
    };
  }
  async command(input: ChatCommand): Promise<CommandResult> {
    const command = commandSchema.parse(input) as ChatCommand;
    if (this.stopped) throw new Error("Application shutdown is in progress.");
    this.permissionsChanged();
    if (command.type === "chat.cancel") {
      this.active?.controller.abort();
      if (this.active) {
        this.active.turn.status = "cancelled"; this.active.turn.text = "Chat cancelled."; this.active.turn.progress = undefined;
        this.failPending(this.active.turn, "Chat cancelled; this proposal was not executed.");
        this.persist();
      }
      return { message: this.confirming ? "An approved action is already executing and cannot be undone by cancelling chat." : "Chat cancellation requested." };
    }
    if (command.type === "chat.permission") return this.decidePermission(command);
    if (command.type === "chat.openFile") return this.openFile(command);
    if (command.type === "chat.delete") {
      if (this.confirming || this.active?.conversationId === command.conversationId) throw new Error("Wait for this chat to stop before deleting it.");
      this.state.conversations = this.state.conversations.filter(c => c.id !== command.conversationId);
      if (this.state.activeConversationId === command.conversationId) this.state.activeConversationId = this.state.conversations[0]?.id;
      this.persist(); return { message: "Conversation deleted from the encrypted archive." };
    }
    if (this.active || this.confirming) throw new Error("Another chat request or confirmation is running.");
    if (command.type === "chat.new") return { conversationId: this.newConversation().id };
    if (command.type === "chat.confirm") {
      this.confirmation = this.confirm(command).finally(() => { this.confirmation = undefined; });
      return this.confirmation;
    }
    if (command.type !== "chat.send") throw new Error("Unsupported chat command.");
    if (!command.text.trim() || command.text.length > CHAT_MESSAGE_MAX) throw new Error(`Messages must contain 1–${CHAT_MESSAGE_MAX} characters. Nothing was truncated.`);
    const model = command.model || this.hooks.settings().model;
    if (!model) throw new Error("Connect your AI provider and select a model in Settings.");
    const conversation = command.conversationId ? this.state.conversations.find(c => c.id === command.conversationId) : this.newConversation();
    if (!conversation) throw new Error("Conversation not found.");
    if (conversation.turns.length >= 60) throw new Error("This conversation reached its 60-turn limit. Start a new chat.");
    const history = conversation.turns.map(turn => ({
      role: turn.role, text: turn.text, status: turn.status,
      actions: turn.actions.map(action => ({ title: action.title, status: action.status, result: action.result }))
    }));
    const mailRefresh = skipsChatMailRefresh(command.text) ? "local" : command.mailRefresh ?? "local";
    const prompt = JSON.stringify({ previousConversation: history, userMessage: command.text, currentTime: now(),
      mailRefresh,
      deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localDate: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
      guidance: "Previous messages are context, not current evidence. Always read the current local archive with tools for personal facts, even in an existing conversation. mailRefresh is the user's choice for THIS turn: local means no question-triggered refresh or download is permitted, including via refresh_inbox; answer from the newest already-imported messages. Do not claim a refresh failed when it was skipped, or ask again. download means the user approved fetching mail; resolve the permitted account via workspace_status before refreshing that scope. Attention and recent-message tools honor this choice. Browser Inbox previews are incomplete snippets, not full emails. Retain newer previews even when older full bodies exist; read_message can return older fullMessageIds for context but they do not replace a newer reply. Report actual download failures only when a download was approved and attempted. Only app confirmation result cards prove provider writes." });
    if (prompt.length > CHAT_PROMPT_MAX) throw new Error("Conversation exceeds the prompt limit. Start a new chat; no message was truncated.");
    const turn: StoredTurn = { id: randomUUID(), role: "assistant", text: "", createdAt: now(), model, status: "working",
      mailRefresh, progress: "Connecting to the AI provider…", citations: [], actions: [], evidence: [...new Map(conversation.turns.flatMap(t => t.evidence)
        .map(ref => [`${ref.collection}:${ref.id}`, ref])).values()]
        .map(ref => ({ ...ref, revision: undefined })) };
    // Shell/web approvals never carry over to a new request, which may read different (untrusted) content.
    conversation.grants = undefined;
    conversation.turns.push({ id: randomUUID(), role: "user", text: command.text, createdAt: now(), status: "complete", citations: [], actions: [], evidence: [] }, turn);
    if (conversation.turns.length === 2) conversation.title = command.text.replace(/\s+/g, " ").slice(0, 72);
    conversation.updatedAt = now(); this.state.activeConversationId = conversation.id;
    const active = { conversationId: conversation.id, turn, controller: new AbortController(), permissions: this.permissions(), promise: undefined as Promise<void> | undefined };
    this.active = active;
    this.persist();
    const requiresFreshMail = mailRefresh === "download" && /\b(email|emails|mail|messages|inbox|courriels?|mails?)\b/i.test(command.text)
      && /\b(latest|new|current|fresh|refresh|fetch|urgent|today|nouveaux|nouveau|derniers|dernières|actualis|récents)\b/i.test(command.text);
    active.promise = this.run(turn, prompt, model, active.controller, requiresFreshMail).finally(() => {
      if (this.active === active) this.active = undefined;
      this.redact(); this.persist();
    });
    return { conversationId: conversation.id, message: "The assistant is working. You can cancel this chat request." };
  }
  private newConversation(): StoredConversation {
    if (this.state.conversations.length >= 20) throw new Error("Delete an old conversation before creating more (20 maximum).");
    const conversation: StoredConversation = { id: randomUUID(), title: "New conversation", updatedAt: now(), turns: [] };
    this.state.conversations.unshift(conversation); this.state.activeConversationId = conversation.id;
    this.persist(); return conversation;
  }
  private failPending(turn: StoredTurn, message: string): void {
    for (const action of turn.actions) if (action.status === "pending") { action.status = "failed"; action.result = message; }
  }
  private async run(turn: StoredTurn, prompt: string, model: string, controller: AbortController, requiresFreshMail = false): Promise<void> {
    const settings = this.hooks.settings();
    const directory = settings.assistantTools ? this.hooks.workspaceDirectory?.() : undefined;
    const conversationId = this.active?.conversationId ?? "";
    let before: Map<string, { mtime: number; size: number }> | undefined;
    try {
      this.guard(turn);
      let toolActivity: (() => void) | undefined;
      const approvedReads = new Set<string>();
      if (directory) before = await scanWorkspace(directory).catch(() => undefined);
      controller.signal.throwIfAborted();
      this.guard(turn);
      const result = await this.hooks.generate({ prompt, model, signal: controller.signal, tools: this.tools(turn, () => toolActivity?.()),
        onToolActivity: listener => { toolActivity = listener; return () => { toolActivity = undefined; }; },
        progress: text => { if (turn.status === "working") { turn.progress = text; this.persist(); } },
        workspace: directory ? {
          directory, shell: settings.assistantShell === "ask", web: settings.assistantWeb === "ask",
          readApproved: path => [...approvedReads].some(root => insidePath(root, path)),
          permission: request => this.permissionRequest(turn, conversationId, request, directory, approvedReads)
        } : undefined });
      this.guard(turn);
      if (result.citationIds.some(id => !turn.citations.some(c => c.id === id))) throw new Error("The AI provider cited evidence it did not read.");
      if (requiresFreshMail && !turn.mailFreshness?.length) {
        turn.text = "Latest emails were not verified: no permitted inbox refresh completed during this request. I cannot provide a current inbox assessment from the older conversation alone. Check the account's selected sources and AI access, then retry.";
        turn.status = "complete";
        this.failPending(turn, "Latest mail was not verified. Refresh the inbox before proposing this action again.");
        return;
      }
      const incomplete = turn.mailFreshness?.filter(result => result.status !== "fresh") ?? [];
      const sourcesChanged = turn.evidence.some(ref => ref.revision !== undefined && !this.valid(ref, true));
      if (sourcesChanged) this.failPending(turn, "Sources changed while this answer was prepared. Ask again to propose this action from the current version.");
      const warning = (sourcesChanged
        ? "**Some sources were updated while I was answering** (for example new mail or a finished attachment). The answer below reflects what I read; ask again for the very latest.\n\n" : "")
        + (incomplete.length
        ? "**Live inbox refresh is incomplete.** The answer below may use older or partially downloaded emails; it is not a verified latest-inbox summary.\n\n"
          + [...new Set(incomplete.flatMap(result => result.sources.filter(source => source.status !== "fresh")
            .map(source => source.reason).filter((reason): reason is string => !!reason)))].slice(0, 3).join(" ") + "\n\n"
        : "");
      turn.text = warning + result.answer; turn.status = "complete";
    } catch (error) {
      // Never persist SDK errors or tool arguments: they can contain private source text.
      const limit = controller.signal.reason instanceof ChatLimitError ? controller.signal.reason :
        error instanceof ChatLimitError ? error : undefined;
      turn.status = limit ? "error" : controller.signal.aborted ? "cancelled" : "error";
      turn.text = limit ? limit.message : controller.signal.aborted ? "Chat cancelled or source permissions changed." : chatFailureMessage(error);
      this.failPending(turn, "This chat did not complete. Propose the action again.");
    } finally {
      turn.progress = undefined;
      for (const [id, pending] of [...this.pendingPermissions]) if (pending.turnId === turn.id) { pending.finish("expired"); this.pendingPermissions.delete(id); }
      if (directory && before) {
        const after = await scanWorkspace(directory).catch(() => new Map<string, { mtime: number; size: number }>());
        for (const [path, info] of after) {
          const previous = before.get(path);
          if (!previous || previous.mtime !== info.mtime || previous.size !== info.size) this.addFile(turn, path, info.size);
        }
      }
    }
  }
  private taskAllowed(task: TaskItem): boolean {
    return (!task.sourceAccountId || this.permitted(task.sourceAccountId, task.sourceSourceId)) &&
      (!task.sourceMessageId || this.citationAllowed({ id: "", messageId: task.sourceMessageId, title: "", excerpt: "" })) &&
      task.citations.every(c => this.citationAllowed(c));
  }
  private draftAllowed(draft: Draft): boolean {
    return this.citationAllowed({ id: "", messageId: draft.messageId, title: "", excerpt: "" }) &&
      this.permitted(draft.accountId) && draft.citations.every(c => this.citationAllowed(c));
  }
  private readDraft(id: string, turn: StoredTurn): Draft {
    const draft = this.vault.get<Draft>("drafts", id);
    if (!draft || !this.draftAllowed(draft)) throw new Error("Draft unavailable or not permitted for AI.");
    const message = this.message(draft.messageId, turn);
    if (draft.accountId !== message.accountId) throw new Error("Draft scope mismatch.");
    this.track(turn, "drafts", id, message.accountId, message.sourceId);
    for (const citation of draft.citations) this.addCitation(turn, citation);
    return draft;
  }
  private trackTask(turn: StoredTurn, task: TaskItem): void {
    if (!this.taskAllowed(task)) throw new Error("Task is unavailable or not permitted for AI.");
    this.track(turn, "tasks", task.id, task.sourceAccountId, task.sourceSourceId);
    if (task.sourceActionId) this.track(turn, "actions", task.sourceActionId, task.sourceAccountId, task.sourceSourceId);
    if (task.sourceMessageId) this.message(task.sourceMessageId, turn);
    for (const citation of task.citations) this.addCitation(turn, citation);
  }
  private tools(turn: StoredTurn, activity: () => void = () => {}): Tool[] {
    let calls = 0;
    const outputBudget = new ToolOutputBudget();
    const freshness = new Map<string, Promise<MailFreshnessResult>>();
    const refresh = async (args: { accountId?: string; sourceId?: string }, force: boolean) => {
      if (turn.mailRefresh !== "download") return {
        status: "local" as const, requested: false,
        limitation: "Using the current local archive by user choice. No refresh or download was attempted for this question. Read the newest saved messages; this is not a refresh failure or a live mailbox verification."
      };
      const sources = this.vault.all<Source>("sources").filter(source => source.kind === "mail"
        && this.permitted(source.accountId, source.id) && (!args.accountId || source.accountId === args.accountId)
        && (!args.sourceId || source.id === args.sourceId));
      if (!sources.length) return { status: "unavailable", checkedAt: now(), sources: [],
        limitation: "No selected, AI-permitted mail source matches this scope. No refresh was attempted." };
      const results: MailFreshnessResult[] = [];
      for (const source of sources) {
        this.guard(turn);
        let pending = freshness.get(source.id);
        if (!pending) {
          pending = (async () => {
            const unavailable: MailFreshnessResult = { status: "unavailable", checkedAt: now(),
              sources: [{ accountId: source.accountId, sourceId: source.id, status: "unavailable", downloaded: 0, pending: 0,
                reason: "The inbox could not be refreshed. Keep the provider connection and paired browser available, then retry." }],
              limitation: "Cached evidence only; latest mail has not been verified." };
            let result: MailFreshnessResult;
            try {
              result = this.hooks.refreshMail ? await this.hooks.refreshMail({
                accountId: source.accountId, sourceId: source.id, force, signal: this.active!.controller.signal,
                progress: text => {
                  this.guard(turn);
                  if (turn.progress !== text) activity();
                  turn.progress = text; this.persist();
                }
              }) : unavailable;
            } catch {
              this.guard(turn);
              activity();
              result = unavailable;
            }
            this.guard(turn);
            activity();
            this.trackScope(turn, source.accountId, source.id);
            (turn.mailFreshness ??= []).push(result);
            return result;
          })();
          freshness.set(source.id, pending);
        }
        results.push(await pending);
      }
      return { status: results.every(result => result.status === "fresh") ? "fresh"
        : results.every(result => result.status === "unavailable") ? "unavailable" : "partial",
        checkedAt: now(), sources: results.flatMap(result => result.sources),
        limitation: "Freshness covers the selected inbox view and reported downloaded messages, not invisible mailbox history. Partial or unavailable sources are not current evidence." };
    };
    const tool = <S extends z.ZodTypeAny>(name: string, description: string, schema: S, work: (args: z.output<S>) => Promise<unknown> | unknown, maxArgs = 16000): Tool => ({
      name, description, parameters: toolParameters(schema), skipPermission: true, defer: "never",
      handler: async args => {
        this.guard(turn);
        if (++calls > CHAT_TOOL_CALL_MAX) this.limit(`Chat tool-call limit (${CHAT_TOOL_CALL_MAX}) reached. Ask a narrower question; no pending action was executed.`);
        turn.progress = description; this.persist();
        try {
          if (JSON.stringify(args).length > maxArgs) this.limit(`Chat tool argument limit (${maxArgs.toLocaleString("en-US")} characters) exceeded. Ask for a smaller operation.`);
          const result = await work(schema.parse(args));
          this.guard(turn);
          const admission = outputBudget.admit(result);
          if (admission.kind === "withheld" && admission.result.budgetExhausted)
            turn.progress = "Evidence budget reached; writing the answer from evidence already gathered";
          if (admission.kind === "accepted" || admission.result.budgetExhausted) this.persist();
          return admission.result;
        } catch (error) {
          this.guard(turn);
          return toolErrorResult(error);
        }
      }
    });
    const tools: Tool[] = [
      tool("refresh_inbox", "Checking this turn's permission to download latest messages from selected inboxes", z.object({
        accountId: idSchema.optional(), sourceId: idSchema.optional()
      }).strict(), args => refresh(args, true)),
      tool("attention_overview", "Preparing an attention shortlist across permitted inboxes", z.object({
        accountId: idSchema.optional(), limit: z.number().int().min(1).max(12).default(8)
      }).strict(), async args => {
        const mailFreshness = await refresh(args, true);
        const messages = preferredMailEvidence(this.vault.all<Message>("messages").filter(message => !message.deleted &&
          this.messageAllowed(message) && (!args.accountId || message.accountId === args.accountId || this.sameMailbox(message.accountId, args.accountId))), this.mailbox);
        for (const message of messages) if (message.gmailApi) this.track(turn, "messages", message.id, message.accountId, message.sourceId);
        const tasks = (this.hooks.workspace().tasks ?? []).filter(task => this.taskAllowed(task) &&
          ["open", "in_progress"].includes(task.status));
        const attention = /\b(urgent|deadline|overdue|action required|please (?:review|confirm|approve|reply)|needs? (?:your|a) (?:review|approval|response)|rappel|relance|merci de|confirmer|valider)\b/i;
        const threads = new Map<string, Message[]>();
        for (const message of [...messages].sort(compareRecentMessages)) {
          const key = message.threadId ? mailboxThreadKey(message, this.mailbox) : message.id;
          const members = threads.get(key) ?? [];
          members.push(message); threads.set(key, members);
        }
        const ranked = [...threads.values()].map(members => {
          const message = members[0];
          const linked = tasks.filter(task => members.some(member => task.sourceMessageId === member.id));
          const match = attention.exec(`${message.subject}\n${message.body}`);
          const signals = [
            ...(linked.length ? ["Linked open local task"] : []),
            ...(match ? ["Possible request or deadline wording"] : []),
            ...(message.unread ? ["Unread in last mailbox capture"] : [])
          ];
          return { message, linked, signals, score: (linked.length ? 4 : 0) + (match ? 2 : 0) + (message.unread ? 1 : 0),
            excerptOffset: match ? Math.max(0, match.index - message.subject.length - 1 - 180) : 0 };
        }).sort((a, b) => b.score - a.score || compareRecentMessages(a.message, b.message));
        // Reserve room for newly received conversations, not repeated older urgent replies.
        const recent = [...ranked].sort((a, b) => compareRecentMessages(a.message, b.message));
        const selected: typeof ranked = [], accounts = new Set<string>();
        for (const item of recent) {
          if (selected.length >= args.limit) break;
          if (!accounts.has(item.message.accountId)) { selected.push(item); accounts.add(item.message.accountId); }
        }
        for (const item of recent) {
          if (selected.length >= Math.ceil(args.limit / 2)) break;
          if (!selected.includes(item)) selected.push(item);
        }
        for (const item of ranked) {
          if (selected.length >= args.limit) break;
          if (!selected.includes(item)) selected.push(item);
        }
        selected.sort((a, b) => b.score - a.score || compareRecentMessages(a.message, b.message));
        const shortlist = selected.map(({ message, linked, signals, excerptOffset }) => {
          const citation: Citation = { id: `chat:attention:${message.id}:${message.revision}:${excerptOffset}`,
            messageId: message.id, title: message.subject, excerpt: message.body.slice(excerptOffset, excerptOffset + 1200),
            location: `${mailEvidenceLocation(message)} · character ${excerptOffset + 1}, up to 1,200 characters` };
          this.addCitation(turn, citation);
          this.trackScope(turn, message.accountId, message.sourceId);
          // Tasks influence selection only; do not disclose unbounded task notes or execute changes.
          for (const task of linked) this.trackTask(turn, task);
          return { messageId: message.id, accountId: message.accountId, sender: message.sender, receivedAt: messageReceivedAt(message),
            capturedAt: message.browser?.capturedAt, providerDateText: message.browser?.dateText,
            completeness: isMailPreview(message) ? "preview" : "full", selectionSignals: signals, citation };
        });
        return { shortlist, freshness: mailFreshness, coverage: { permittedMessages: messages.length, selectedMessages: shortlist.length,
          permittedConversations: threads.size, newestLocalReceivedAt: recent[0] ? messageReceivedAt(recent[0].message) : undefined,
          permittedAccounts: new Set(messages.map(message => message.accountId)).size, selectedAccounts: accounts.size },
          limitation: "One newest message per conversation, balancing recent local arrivals and possible action signals across accounts. Older replies cannot occupy multiple shortlist slots. Heuristic shortlist, not an exhaustive review or confirmed urgency. Quotes are bounded excerpts. Verify relevant details with read_message; do not infer missing preview content. Nothing was executed." };
      }),
      tool("workspace_status", "Checking permitted workspace status", empty, () => {
        const settings = this.hooks.settings();
        const sources = this.vault.all<Source>("sources").filter(s => this.permitted(s.accountId, s.id));
        for (const source of sources) this.track(turn, "sources", source.id, source.accountId, source.id);
        return { model: settings.model, aiRunsRemaining: Math.max(0, settings.dailyAiLimit - settings.aiRunsToday),
          automationPaused: settings.syncPaused,
          accounts: this.vault.all<Account>("accounts").filter(account => sources.some(source => source.accountId === account.id))
            .map(account => ({ id: account.id, name: account.name, email: account.email, provider: account.provider, connection: account.connection })),
          sources: sources.map(s => ({ id: s.id, accountId: s.accountId, name: s.name, kind: s.kind })),
          mailRefresh: turn.mailRefresh ?? "local",
          limitations: "Only explicitly AI-enabled selected sources are visible. Read the current local archive, not old conversation summaries. Download is permitted only when this turn's mailRefresh is download; local means skip refresh entirely. Browser coverage remains partial. Native saves and calendar writes still require review." };
      }),
      tool("search_archive", "Searching permitted mail and indexed attachment excerpts", z.object({
        query: z.string().min(1).max(2000), accountId: idSchema.optional()
      }).strict(), async args => {
        const mailFreshness = await refresh(args, false);
        const accounts = this.vault.all<Account>("accounts").filter(a => this.permitted(a.id) && (!args.accountId || a.id === args.accountId));
        const citations: Citation[] = [];
        for (const account of accounts) {
          this.guard(turn);
          if (!this.permitted(account.id)) throw new Error("Permission changed.");
          const found = await this.hooks.search(args.query, account.id);
          this.guard(turn);
          for (const citation of found) {
            const message = this.vault.get<Message>("messages", citation.messageId);
            if (message?.accountId === account.id && this.citationAllowed(citation) && citations.length < 12) {
              const full = isMailPreview(message) ? fullThreadMessages(message, this.vault.all<Message>("messages"), this.mailbox)
                .filter(item => this.messageAllowed(item)).sort(compareRecentMessages)[0] : undefined;
              if (full && !citations.some(item => item.messageId === full.id)) {
                if (full.gmailApi) this.track(turn, "messages", full.id, full.accountId, full.sourceId);
                this.trackScope(turn, full.accountId, full.sourceId);
                const replacement: Citation = { id: `chat:search-full:${full.id}:${full.revision}`, messageId: full.id, title: full.subject,
                  excerpt: full.body.slice(0, 1500), location: `${mailEvidenceLocation(full)} · first 1,500 characters (replaces matching Inbox preview)` };
                this.addCitation(turn, replacement); citations.push(replacement);
                continue;
              }
              if (full) continue;
              this.addCitation(turn, citation); citations.push(citation);
            }
          }
          if (citations.length >= 12) break;
        }
        return { excerpts: citations, freshness: mailFreshness, scope: "At most 12 matching excerpts, not a full archive review. Browser Inbox previews are incomplete; use read_message and its fullMessageIds for downloaded bodies." };
      }),
      tool("list_recent_messages", "Reading recent permitted inbox messages", z.object({
        accountId: idSchema.optional(), sourceId: idSchema.optional(),
        offset: z.number().int().min(0).max(1000000).default(0),
        limit: z.number().int().min(1).max(12).default(8)
      }).strict(), async args => {
        const mailFreshness = await refresh(args, true);
        const messages = preferredMailEvidence(this.vault.all<Message>("messages").filter(message => !message.deleted &&
          this.messageAllowed(message) &&
          (!args.accountId || message.accountId === args.accountId || this.sameMailbox(message.accountId, args.accountId)) &&
          (!args.sourceId || message.sourceId === args.sourceId)), this.mailbox).sort(compareRecentMessages);
        for (const message of messages) if (message.gmailApi) this.track(turn, "messages", message.id, message.accountId, message.sourceId);
        for (const sourceId of new Set(messages.map(message => message.sourceId))) {
          const source = this.vault.get<Source>("sources", sourceId)!;
          this.trackScope(turn, source.accountId, sourceId);
        }
        const page = messages.slice(args.offset, args.offset + args.limit).map(message => {
          const citation: Citation = { id: `chat:recent:${message.id}:${message.revision}`, messageId: message.id,
            title: message.subject, excerpt: message.body.slice(0, 1000), location: `${mailEvidenceLocation(message)} · first 1,000 characters` };
          this.addCitation(turn, citation);
          return { id: message.id, accountId: message.accountId, sourceId: message.sourceId, citation,
            sender: message.sender, receivedAt: messageReceivedAt(message), unread: message.unread,
            capturedAt: message.browser?.capturedAt, providerDateText: message.browser?.dateText,
            completeness: isMailPreview(message) ? "preview" : "full" };
        });
        return { messages: page, total: messages.length, freshness: mailFreshness,
          nextOffset: args.offset + args.limit < messages.length ? args.offset + args.limit : undefined,
          limitation: "Current local messages sorted by the same mailbox receipt chronology as the unified Inbox, not full mailbox history. Newer reply previews are retained alongside older full bodies. Excerpts are limited to 1,000 characters; use read_message for more. Capture time is not a received date." };
      }),
      tool("read_message", "Reading a permitted message page", z.object({
        messageId: idSchema, offset: z.number().int().min(0).max(10000000).default(0),
        fullMessageOffset: z.number().int().min(0).max(1000000).default(0)
      }).strict(), async args => {
        const original = this.vault.get<Message>("messages", args.messageId);
        if (!original || !this.messageAllowed(original)) throw new Error("Message unavailable.");
        const mailFreshness = await refresh({ accountId: original.accountId, sourceId: original.sourceId }, false);
        const message = this.message(args.messageId, turn);
        const excerpt = message.body.slice(args.offset, args.offset + 10000);
        const citation: Citation = { id: `chat:${message.id}:${message.revision}:${args.offset}`, messageId: message.id,
          title: message.subject, excerpt, location: `${mailEvidenceLocation(message)} · character ${args.offset + 1}` };
        this.addCitation(turn, citation);
        const attachments = this.vault.all<Attachment>("attachments").filter(a => a.messageId === message.id && a.accountId === message.accountId
          && mailOriginAllowed(this.vault, { ...message, gmailApi: a.gmailApi }, true))
          .slice(0, 30).map(a => {
            this.track(turn, "attachments", a.id, message.accountId, message.sourceId);
            return { id: a.id, name: a.name, status: a.status };
          });
        const fullMessages = isMailPreview(message) ? fullThreadMessages(message, this.vault.all<Message>("messages"), this.mailbox)
          .filter(full => this.messageAllowed(full)).sort(compareRecentMessages) : [];
        for (const full of fullMessages) if (full.gmailApi) this.track(turn, "messages", full.id, full.accountId, full.sourceId);
        const fullMessageIds = fullMessages.slice(args.fullMessageOffset, args.fullMessageOffset + 6).map(full => {
          this.message(full.id, turn);
          return full.id;
        });
        return { citation, freshness: mailFreshness, sender: message.sender, recipients: message.recipients, receivedAt: messageReceivedAt(message),
          capturedAt: message.browser?.capturedAt,
          completeness: isMailPreview(message) ? "preview" : "full", attachments,
          ...(isMailPreview(message) ? { fullMessageIds, fullMessageCount: fullMessages.length,
            nextFullMessageOffset: args.fullMessageOffset + 6 < fullMessages.length ? args.fullMessageOffset + 6 : undefined,
            limitation: fullMessages.length
              ? "This is only the retained Inbox preview. Read the fullMessageIds for actual downloaded message bodies and their own citations/capture times; they may predate newer Inbox activity."
              : "This is only an incomplete Inbox preview. No full messages are downloaded locally for this account/source/thread; do not infer missing content." }
            : { limitation: "Locally stored full message body, paginated. Capture time does not prove current thread freshness or complete mailbox coverage." }),
          nextOffset: args.offset + 10000 < message.body.length ? args.offset + 10000 : undefined };
      }),
      tool("read_attachment", "Reading indexed attachment excerpts", z.object({
        attachmentId: idSchema, offset: z.number().int().min(0).max(100000).default(0)
      }).strict(), args => {
        const attachment = this.vault.get<Attachment>("attachments", args.attachmentId);
        if (!attachment || !["indexed", "partial"].includes(attachment.status)) throw new Error("Attachment not indexed.");
        const message = this.message(attachment.messageId, turn);
        if (attachment.accountId !== message.accountId) throw new Error("Attachment scope mismatch.");
        this.track(turn, "attachments", attachment.id, message.accountId, message.sourceId);
        const chunks = this.vault.documentChunks(`attachment:${attachment.id}`, args.offset, 6);
        const excerpts = chunks.map(chunk => ({ id: chunk.id, messageId: message.id, attachmentId: attachment.id,
          title: chunk.title, excerpt: chunk.text, location: chunk.location }));
        for (const citation of excerpts) this.addCitation(turn, citation);
        return { excerpts, partialExtraction: attachment.status === "partial", nextOffset: chunks.length === 6 ? args.offset + 6 : undefined };
      }),
      tool("list_drafts", "Reading permitted local draft summaries", z.object({
        offset: z.number().int().min(0).max(100000).default(0)
      }).strict(), args => {
        const drafts = this.vault.all<Draft>("drafts").filter(draft => this.draftAllowed(draft));
        for (const draft of drafts) {
          const message = this.vault.get<Message>("messages", draft.messageId)!;
          this.trackScope(turn, message.accountId, message.sourceId);
          this.citationScope(turn, draft.citations);
        }
        const page = drafts.slice(args.offset, args.offset + 10);
        for (const draft of page) this.readDraft(draft.id, turn);
        return { drafts: page.map(draft => ({ id: draft.id, messageId: draft.messageId, subject: draft.subject,
          status: draft.status, updatedAt: draft.updatedAt })), nextOffset: args.offset + 10 < drafts.length ? args.offset + 10 : undefined };
      }),
      tool("read_draft", "Reading the exact permitted reply draft", z.object({ draftId: idSchema }).strict(), args => {
        const draft = this.readDraft(args.draftId, turn);
        if (JSON.stringify(draft).length > 16000) return { error: "This draft is too large for a complete chat preview. Review and save it in Drafts." };
        return { id: draft.id, subject: draft.subject, body: draft.body, recipients: draft.recipients,
          status: draft.status, sourceRevision: draft.sourceRevision, updatedAt: draft.updatedAt, messageId: draft.messageId };
      }),
      tool("list_tasks", "Reading permitted local tasks", z.object({
        offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(20).default(10)
      }).strict(), args => {
        const tasks = (this.hooks.workspace().tasks ?? []).filter(task => this.taskAllowed(task));
        for (const task of tasks) {
          this.trackScope(turn, task.sourceAccountId, task.sourceSourceId);
          this.citationScope(turn, task.citations);
          if (task.sourceMessageId) this.citationScope(turn, [{ id: "", messageId: task.sourceMessageId, title: "", excerpt: "" }]);
        }
        const page = tasks.slice(args.offset, args.offset + args.limit);
        for (const task of page) this.trackTask(turn, task);
        return { tasks: page.map(t => ({ id: t.id, title: t.title, notes: t.notes, status: t.status, priority: t.priority,
          dueAt: t.dueAt, sourceMessageId: t.sourceMessageId })), total: tasks.length, nextOffset: args.offset + args.limit < tasks.length ? args.offset + args.limit : undefined };
      }),
      tool("list_calendar", "Reading permitted calendar events", z.object({ offset: z.number().int().min(0).max(100000).default(0) }).strict(), args => {
        const events = this.vault.all<CalendarEvent>("events").filter(e => this.permitted(e.accountId, e.sourceId))
          .sort((a, b) => a.start.localeCompare(b.start));
        for (const event of events) this.trackScope(turn, event.accountId, event.sourceId);
        const page = events.slice(args.offset, args.offset + 20);
        for (const event of page) this.track(turn, "events", event.id, event.accountId, event.sourceId);
        return { events: page.map(e => ({ id: e.id, accountId: e.accountId, sourceId: e.sourceId, title: e.title,
          start: e.start, end: e.end, timeZone: e.timeZone, location: e.location, revision: e.revision, writable: e.writable })),
          total: events.length, nextOffset: args.offset + 20 < events.length ? args.offset + 20 : undefined };
      }),
      tool("list_browser_calendar", "Reading permitted browser calendar captures", z.object({ offset: z.number().int().min(0).max(100000).default(0) }).strict(), args => {
        const items = this.vault.all<BrowserCalendarItem>("browserItems").filter(item => this.permitted(item.accountId, item.sourceId));
        for (const item of items) this.trackScope(turn, item.accountId, item.sourceId);
        const page = items.slice(args.offset, args.offset + 20);
        for (const item of page) this.track(turn, "browserItems", item.id, item.accountId, item.sourceId);
        return { items: page.map(item => ({ id: item.id, title: item.title, whenText: item.whenText,
          location: item.location, capturedAt: item.capturedAt, accountId: item.accountId, sourceId: item.sourceId })),
          total: items.length, nextOffset: args.offset + 20 < items.length ? args.offset + 20 : undefined,
          limitation: "Loaded browser captures only; times may be imprecise and captures stale. To reschedule use propose_browser_calendar_move, then the user confirms its card. Browser verification is required before saving." };
      }),
      tool("find_browser_calendar_events", "Finding an event across permitted browser calendars", z.object({
        query: z.string().trim().min(1).max(1000), accountId: idSchema.optional(),
        offset: z.number().int().min(0).max(100000).default(0)
      }).strict(), args => {
        const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLowerCase();
        const query = normalize(args.query);
        const candidates = this.vault.all<BrowserCalendarItem>("browserItems").filter(item =>
          this.permitted(item.accountId, item.sourceId) && (!args.accountId || item.accountId === args.accountId));
        const matches = candidates.filter(item => normalize(`${item.title} ${item.whenText}`).includes(query));
        const page = matches.slice(args.offset, args.offset + 12);
        for (const item of candidates) this.trackScope(turn, item.accountId, item.sourceId);
        for (const item of page) this.track(turn, "browserItems", item.id, item.accountId, item.sourceId);
        return { events: page.map(item => ({
          id: item.id, accountId: item.accountId, sourceId: item.sourceId, title: item.title,
          whenText: item.whenText, capturedAt: item.capturedAt
        })), total: matches.length, nextOffset: args.offset + 12 < matches.length ? args.offset + 12 : undefined,
        limitation: "Search covers all permitted local browser captures, not only the first calendar page. Missing results can mean missing AI consent: use Chat's Calendar access controls without changing consent automatically." };
      }),
      tool("calendar_insights", "Checking permitted calendar conflicts and important events", z.object({
        accountId: idSchema.optional(), sourceId: idSchema.optional()
      }).strict(), args => {
        const accounts = this.vault.all<Account>("accounts").filter(account => this.permitted(account.id) &&
          (!args.accountId || account.id === args.accountId));
        const sources = this.vault.all<Source>("sources").filter(source => source.kind === "calendar" &&
          accounts.some(account => account.id === source.accountId) && this.permitted(source.accountId, source.id) &&
          (!args.sourceId || source.id === args.sourceId));
        const allowed = new Set(sources.map(source => source.id));
        const events = this.vault.all<CalendarEvent>("events").filter(event => allowed.has(event.sourceId) &&
          this.permitted(event.accountId, event.sourceId));
        const browserItems = this.vault.all<BrowserCalendarItem>("browserItems").filter(item => allowed.has(item.sourceId) &&
          this.permitted(item.accountId, item.sourceId));
        for (const source of sources) this.trackScope(turn, source.accountId, source.id);
        const result = buildCalendarWorkspace({ accounts, sources, events, browserItems });
        for (const entry of result.entries)
          this.track(turn, entry.kind === "api" ? "events" : "browserItems", entry.id, entry.accountId, entry.sourceId);
        const summary = (entry: typeof result.entries[number]) => ({
          id: entry.key, title: entry.title, when: entry.whenLabel, date: entry.dateKey,
          accountId: entry.accountId, sourceId: entry.sourceId, timing: entry.timing, importance: entry.importance
        });
        return {
          upcoming: result.entries.slice(0, 12).map(summary),
          important: result.entries.filter(entry => entry.importance).slice(0, 12).map(summary),
          overlaps: result.conflicts.slice(0, 12).map(conflict => ({
            kind: conflict.kind, reason: conflict.reason,
            events: result.entries.filter(entry => conflict.entryKeys.includes(entry.key)).map(summary)
          })),
          totalEntries: result.entries.length, totalOverlapPairs: result.conflicts.length,
          uncertainTimes: result.entries.filter(entry => entry.timing !== "exact").length,
          warnings: result.warnings,
          limitation: "Local imported entries only. Importance is a keyword suggestion. Possible browser overlaps have unverified time zones; never call them confirmed conflicts."
        };
      }),
      tool("list_calendar_approvals", "Reading permitted pending calendar approvals", empty, () => {
        const approvals = this.vault.all<Approval>("approvals").filter(approval => approval.status === "pending" &&
          this.permitted(approval.change.accountId, approval.change.sourceId)).slice(0, 10);
        for (const approval of approvals) this.track(turn, "approvals", approval.id, approval.change.accountId, approval.change.sourceId);
        return { approvals: approvals.map(a => ({ id: a.id, change: a.change, hash: a.hash, effect: a.effect, createdAt: a.createdAt })) };
      }),
      tool("read_focus_report", "Reading the permitted focus report", empty, () => {
        const report = this.hooks.workspace().focusReport;
        if (!report || !report.accountIds.every(id => this.permitted(id)) || !report.sourceIds.every(id => {
          const source = this.vault.get<Source>("sources", id); return !!source && this.permitted(source.accountId, id);
        }) || !report.citations.every(c => this.citationAllowed(c)) || !report.rankedTasks.every(t => this.taskAllowed(t)) ||
            !report.upcomingMeetings.every(meeting => this.permitted(meeting.accountId, meeting.sourceId)))
          return { message: "No fully permitted report is available. Propose a new focus report." };
        for (const accountId of report.accountIds) this.track(turn, "accounts", accountId, accountId);
        for (const sourceId of report.sourceIds) this.track(turn, "sources", sourceId, this.vault.get<Source>("sources", sourceId)!.accountId, sourceId);
        for (const citation of report.citations) this.addCitation(turn, citation);
        for (const task of report.rankedTasks) this.trackTask(turn, task);
        for (const meeting of report.upcomingMeetings) this.trackScope(turn, meeting.accountId, meeting.sourceId);
        return { generatedAt: report.generatedAt, narrative: report.narrative, metrics: report.metrics,
          nextActions: report.nextActions.slice(0, 20), warnings: report.warnings, citations: report.citations };
      }),
      tool("review_coverage", "Checking AI review coverage for permitted messages", empty, () => {
        const messages = this.vault.all<Message>("messages").filter(m => this.messageAllowed(m));
        for (const message of messages) if (message.gmailApi) this.track(turn, "messages", message.id, message.accountId, message.sourceId);
        for (const source of this.vault.all<Source>("sources").filter(s => this.permitted(s.accountId, s.id)))
          this.track(turn, "sources", source.id, source.accountId, source.id);
        const selected = preferredMailEvidence(messages, this.mailbox);
        return { permittedMessages: selected.length, browserPreviewMessages: selected.filter(isMailPreview).length,
          fullMessages: selected.filter(message => !isMailPreview(message)).length,
          downloadedBrowserFullMessages: selected.filter(message => message.browser?.completeness === "full" && !isMailPreview(message)).length,
          retainedPreviewRecords: messages.filter(isMailPreview).length,
          reviewStatus: this.hooks.workspace().aiReview?.status ?? "idle",
          limitation: "This counts locally available eligible evidence, preferring full messages over duplicate thread previews, not the full mailbox or verified completed review. Full capture may predate newer Inbox activity. Open Activity / AI review for detailed batch progress." };
      })
    ];
    for (const type of allowedActions) {
      if (type === "refresh.request") continue;
      const schema: z.AnyZodObject = commandSchema.options.find(option => option.shape.type.value === type)!;
      const parameters = schema.omit({ type: true, ...(type === "calendar.approve" ? { hash: true } : {}),
        ...(type === "task.schedule" ? { confirmed: true } : {}),
        ...(type === "browser.calendar.move" ? { expectedRevision: true } : {}) });
      tools.push(tool(`propose_${type.replaceAll(".", "_")}`, `Preparing a reviewable ${type} proposal (does not execute it)`, parameters,
        args => {
          const generated = type === "calendar.approve" ? { hash: this.vault.get<Approval>("approvals", args.approvalId)?.hash } :
            type === "task.schedule" ? { confirmed: true } :
            type === "browser.calendar.move" ? { expectedRevision: this.revision("browserItems", args.itemId) } : {};
          return this.propose(turn, commandSchema.parse({ ...args, ...generated, type }) as ProposedCommand);
        }));
    }
    if (this.hooks.knowledge) {
      const knowledge = this.hooks.knowledge;
      tools.push(
        tool("list_documents", "Listing documents from added folders and shared links", z.object({
          sourceId: idSchema.optional()
        }).strict(), args => knowledge.list(args.sourceId)),
        tool("search_documents", "Searching documents from added folders and shared links", z.object({
          query: z.string().min(1).max(500), sourceId: idSchema.optional(), limit: z.number().int().min(1).max(20).optional()
        }).strict(), args => knowledge.search(args.query, { sourceId: args.sourceId, limit: args.limit })),
        tool("read_document", "Reading a document from an added folder or shared link", z.object({
          documentId: idSchema, offset: z.number().int().min(0).optional(), length: z.number().int().min(500).max(20000).optional()
        }).strict(), args => knowledge.read(args.documentId, args.offset, args.length))
      );
    }
    if (this.hooks.settings().assistantTools && this.hooks.workspaceDirectory) {
      const directory = this.hooks.workspaceDirectory();
      tools.push(tool("create_document", "Creating a document in the workspace folder", z.object({
        fileName: z.string().min(1).max(120),
        format: z.enum(DOCUMENT_FORMATS),
        title: z.string().max(300).optional(),
        content: z.string().max(200000).optional(),
        sheets: z.array(z.object({ name: z.string().max(31), rows: z.array(z.array(z.string().max(5000)).max(200)).max(5000) }).strict()).max(20).optional(),
        overwrite: z.boolean().optional()
      }).strict(), async args => {
        const created = await createDocument(directory, args);
        this.addFile(turn, created.path, created.size);
        return { saved: true, path: created.path, fileName: created.name, format: created.format, bytes: created.size,
          note: "The app shows Open and Show in folder buttons for this file. Mention the saved path in your answer." };
      }, 220000));
    }
    return tools;
  }
  private addFile(turn: StoredTurn, path: string, size: number): void {
    const files = turn.files ??= [];
    const existing = files.find(file => file.path.toLowerCase() === path.toLowerCase());
    if (existing) { existing.size = size; existing.createdAt = now(); }
    else if (files.length < 50) files.push({ name: host.path.basename(path), path, size, createdAt: now() });
    this.persist();
  }
  private async permissionRequest(turn: StoredTurn, conversationId: string, request: PermissionRequest, directory: string, approvedReads: Set<string>): Promise<"approve" | "deny"> {
    const raw = request as unknown as Record<string, unknown>;
    const text = (value: unknown, max = 4000) => typeof value === "string" ? value.slice(0, max) : "";
    const settings = this.hooks.settings();
    const conversation = this.state.conversations.find(item => item.id === conversationId);
    if (!this.active || this.active.turn !== turn || this.active.controller.signal.aborted || !settings.assistantTools) return "deny";
    let kind: ChatPermission["kind"], title: string, detail: string;
    if (request.kind === "write") {
      const path = text(raw.resolvedPath) || text(raw.fileName);
      return path && insidePath(directory, path) ? "approve" : "deny";
    } else if (request.kind === "read") {
      const path = text(raw.resolvedPath) || text(raw.path);
      if (path && (insidePath(directory, path) || [...approvedReads].some(root => insidePath(root, path)))) return "approve";
      kind = "read"; title = "Read a file outside the workspace"; detail = path;
    } else if (request.kind === "shell") {
      if (settings.assistantShell !== "ask") return "deny";
      if (conversation?.grants?.includes("shell")) return "approve";
      kind = "shell"; title = `Run a ${host.shell.name} command`; detail = text(raw.fullCommandText, 8000);
      const warning = text(raw.warning, 500);
      if (warning) detail += `\n\n⚠ ${warning}`;
    } else if (request.kind === "url") {
      if (settings.assistantWeb !== "ask") return "deny";
      if (conversation?.grants?.includes("url")) return "approve";
      kind = "url"; title = "Fetch a web page"; detail = text(raw.url, 2000);
    } else return "deny";
    if (!detail) return "deny";
    const permission: ChatPermission = { id: randomUUID(), kind, title, detail, intention: text(raw.intention, 500) || undefined, status: "pending" };
    (turn.permissions ??= []).push(permission);
    turn.progress = "Waiting for your approval…";
    this.persist();
    this.hooks.attention?.("Relay Desk needs your approval", title);
    const decision = await new Promise<"approve" | "deny">(resolve => {
      const timeout = setTimeout(() => finish("expired"), 5 * 60_000);
      const signal = this.active!.controller.signal;
      const abort = () => finish("expired");
      const finish = (status: ChatPermission["status"]) => {
        if (!this.pendingPermissions.has(permission.id)) return;
        this.pendingPermissions.delete(permission.id);
        clearTimeout(timeout); signal.removeEventListener("abort", abort);
        permission.status = status;
        if (status === "approved" && kind === "read") approvedReads.add(detail);
        resolve(status === "approved" || status === "approved-chat" ? "approve" : "deny");
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingPermissions.set(permission.id, { turnId: turn.id, conversationId, kind, finish });
    });
    if (turn.status === "working") turn.progress = decision === "approve" ? "Approved; the assistant is continuing…" : "Denied; the assistant is continuing without it…";
    this.persist();
    return decision;
  }
  private decidePermission(command: Extract<ChatCommand, { type: "chat.permission" }>): CommandResult {
    const pending = this.pendingPermissions.get(command.requestId);
    if (!pending || pending.turnId !== command.turnId || pending.conversationId !== command.conversationId)
      throw new Error("This approval request is no longer pending.");
    if (command.decision === "chat" && (pending.kind === "shell" || pending.kind === "url")) {
      const conversation = this.state.conversations.find(item => item.id === command.conversationId);
      if (conversation && !(conversation.grants ??= []).includes(pending.kind)) conversation.grants.push(pending.kind);
      for (const other of [...this.pendingPermissions.values()])
        if (other !== pending && other.conversationId === command.conversationId && other.kind === pending.kind) other.finish("approved-chat");
      pending.finish("approved-chat");
    } else pending.finish(command.decision === "deny" ? "denied" : "approved");
    this.persist();
    return { message: command.decision === "deny" ? "Request denied." : "Approved." };
  }
  private async openFile(command: Extract<ChatCommand, { type: "chat.openFile" }>): Promise<CommandResult> {
    const turn = this.state.conversations.find(item => item.id === command.conversationId)?.turns.find(item => item.id === command.turnId);
    const file = turn?.files?.find(item => item.path === command.path);
    if (!file || !this.hooks.openPath) throw new Error("This file is not available.");
    if (!command.reveal && !chatFileOpenable(host.path.basename(file.path)))
      throw new Error("This file type can run code, so Relay Desk only shows it in its folder. Inspect it before opening.");
    await this.hooks.openPath(file.path, !!command.reveal);
    return { message: command.reveal ? "Opened the containing folder." : `Opened ${file.name}.` };
  }
  private validateAction(command: ProposedCommand, turn: StoredTurn): Evidence[] {
    if (!allowedActions.includes(command.type)) throw new Error("Unsupported action.");
    if (command.type === "browser.calendar.move") this.browserMoveReview(command, turn);
    if (command.type === "draft.generate") this.message(command.messageId, turn);
    if (command.type === "draft.save" || command.type === "draft.handoff") this.draftReview(command, turn);
    if (command.type === "task.edit" || command.type === "task.status" || command.type === "task.schedule") {
      const task = this.hooks.workspace().tasks?.find(task => task.id === command.taskId);
      if (!task) throw new Error("Task not found.");
      this.trackTask(turn, task);
      if (command.type === "task.schedule" && ["pending", "uncertain"].includes(task.schedule?.state ?? ""))
        throw new Error("Inspect the prior uncertain or pending calendar write before scheduling.");
    }
    if (command.type === "calendar.approve") {
      const approval = this.vault.get<Approval>("approvals", command.approvalId);
      if (!approval) throw new Error("Approval not found.");
      validateApproval(approval, command.hash);
      this.track(turn, "approvals", approval.id, approval.change.accountId, approval.change.sourceId);
    }
    if (command.type === "calendar.propose" || command.type === "task.schedule" || command.type === "calendar.approve") {
      const change = command.type === "calendar.approve" ? this.vault.get<Approval>("approvals", command.approvalId)!.change : command.change;
      const account = this.vault.get<Account>("accounts", change.accountId);
      const source = this.vault.get<Source>("sources", change.sourceId);
      if (!account || account.demo || account.connection === "browser" || !source || source.kind !== "calendar" ||
          !this.permitted(account.id, source.id)) throw new Error("Choose a permitted writable API calendar.");
      this.track(turn, "sources", source.id, account.id, source.id);
      if (change.eventId) {
        const event = this.vault.get<CalendarEvent>("events", change.eventId);
        if (!event || event.accountId !== account.id || event.sourceId !== source.id || event.recurring || event.writable === false ||
            change.expectedRevision !== event.revision) throw new Error("Calendar event is read-only or changed. Read its current revision first.");
        this.track(turn, "events", event.id, account.id, source.id);
      }
      validateChange(change);
    }
    // Capture existing evidence too: action arguments may derive from any earlier read.
    return turn.evidence.map(ref => ({
      ...ref, revision: this.revision(ref.collection, ref.id)
    }));
  }
  private browserMoveReview(command: Extract<ProposedCommand, { type: "browser.calendar.move" }>, turn: StoredTurn): Record<string, unknown> {
    const item = this.vault.get<BrowserCalendarItem>("browserItems", command.itemId);
    if (!item || !this.permitted(item.accountId, item.sourceId)) throw new Error("Browser calendar event unavailable or not permitted for AI.");
    const account = this.vault.get<Account>("accounts", item.accountId);
    const source = this.vault.get<Source>("sources", item.sourceId);
    if (!account || account.demo || account.connection !== "browser" || account.provider !== "gmail" ||
        source?.kind !== "calendar") throw new Error("Choose a connected Google browser calendar.");
    if (browserCalendarRevision(item) !== command.expectedRevision) throw new Error("The captured meeting changed. Read it again before proposing a move.");
    const date = new Date(`${command.newDate}T12:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== command.newDate || command.endTime <= command.startTime)
      throw new Error("Choose a valid date and a same-day end time after the start time.");
    try { new Intl.DateTimeFormat("en", { timeZone: command.timeZone }).format(date); }
    catch { throw new Error("Choose a valid IANA time zone for this meeting."); }
    this.track(turn, "browserItems", item.id, item.accountId, item.sourceId);
    this.trackScope(turn, item.accountId, item.sourceId);
    this.track(turn, "accounts", account.id, account.id);
    const normalized = buildCalendarWorkspace({ accounts: [account], sources: [source], events: [], browserItems: [item] }, { includePast: true }).entries[0];
    return {
      title: normalized?.title || item.title, accountEmail: account.email, sourceId: source.id,
      currentWhen: item.whenText, newDate: command.newDate, startTime: command.startTime,
      endTime: command.endTime, timeZone: command.timeZone,
      effect: "Uses your paired browser to edit this single meeting. Google Calendar may notify guests. Recurring, read-only or unverifiable edits stop without automatic saving. If Google requests another confirmation, finish it in the browser. A successful save is reported only after verification."
    };
  }
  private draftReview(command: Extract<ProposedCommand, { type: "draft.save" | "draft.handoff" }>, turn: StoredTurn): Record<string, unknown> {
    const draft = this.readDraft(command.draftId, turn);
    const message = this.message(draft.messageId, turn);
    const account = this.vault.get<Account>("accounts", draft.accountId)!;
    if (account.demo || account.provider === "slack" || ["stale", "uncertain"].includes(draft.status) || draft.sourceRevision !== message.revision)
      throw new Error("This draft cannot be safely saved. Review its source and provider state first.");
    if (command.type === "draft.handoff" && account.provider !== "gmail") throw new Error("Gmail handoff only.");
    let destination = account;
    if (account.connection === "browser") {
      const linked = this.vault.all<Account>("accounts").find(a => a.provider === "gmail" && a.connection !== "browser" &&
        !a.demo && a.status === "connected" && a.consent && a.email.trim().toLowerCase() === account.email.trim().toLowerCase());
      destination = draft.nativeTarget ? this.vault.get<Account>("accounts", draft.nativeTarget.accountId)! : linked!;
      if (!destination || destination.demo || destination.connection === "browser" || destination.provider !== "gmail" ||
          destination.email.trim().toLowerCase() !== account.email.trim().toLowerCase() || !this.permitted(destination.id))
        throw new Error("Native browser draft saves need the same mailbox's connected, AI-enabled Gmail API account. Otherwise use Drafts for review.");
      const sources = this.vault.all<Source>("sources").filter(s => s.accountId === destination.id && s.kind === "mail" && this.permitted(destination.id, s.id));
      if (!sources.length) throw new Error("Select an authorized API mail source before native draft saving.");
      for (const source of sources) this.track(turn, "sources", source.id, destination.id, source.id);
    }
    this.track(turn, "accounts", destination.id, destination.id);
    const fields = command.type === "draft.handoff" ? command : draft;
    commandSchema.parse({ type: "draft.edit", draftId: draft.id, body: fields.body, subject: fields.subject, recipients: fields.recipients });
    if (!fields.recipients.length) throw new Error("Review at least one exact recipient before saving.");
    return { draftId: draft.id, accountId: account.id, destinationAccountId: destination.id,
      messageId: message.id, sourceRevision: draft.sourceRevision, providerId: draft.providerId, providerRevision: draft.providerRevision,
      nativeTarget: draft.nativeTarget, subject: fields.subject, body: fields.body, recipients: [...fields.recipients] };
  }
  private review(command: ProposedCommand, turn: StoredTurn): Record<string, unknown> | undefined {
    if (command.type === "browser.calendar.move") return this.browserMoveReview(command, turn);
    if (command.type === "draft.save" || command.type === "draft.handoff") return this.draftReview(command, turn);
    if (command.type === "calendar.approve") {
      const approval = this.vault.get<Approval>("approvals", command.approvalId)!;
      return { change: approval.change, hash: approval.hash, effect: approval.effect };
    }
    if (command.type === "task.schedule") {
      const task = this.hooks.workspace().tasks?.find(task => task.id === command.taskId);
      if (!task) throw new Error("Task unavailable.");
      return { payloadHash: payloadHash(command.change), task: this.taskFields(task),
        effect: "Writes a private calendar event without attendees; existing reminder settings in this preview apply." };
    }
    return undefined;
  }
  private taskFields(task: TaskItem): Record<string, unknown> {
    return { id: task.id, title: task.title, notes: task.notes, status: task.status, priority: task.priority,
      dueAt: task.dueAt, sourceMessageId: task.sourceMessageId, sourceAccountId: task.sourceAccountId, sourceSourceId: task.sourceSourceId };
  }
  private propose(turn: StoredTurn, input: ProposedCommand): unknown {
    this.guard(turn);
    if (turn.actions.length >= 6) throw new Error("At most six previews per turn.");
    const command = commandSchema.parse(input) as ProposedCommand;
    if (command.type === "draft.generate") command.model = turn.model;
    if (command.type === "task.schedule") {
      const task = this.hooks.workspace().tasks?.find(task => task.id === command.taskId);
      if (task?.schedule?.eventId && !command.change.eventId) {
        command.change.eventId = task.schedule.eventId;
        command.change.expectedRevision = this.vault.get<CalendarEvent>("events", task.schedule.eventId)?.revision;
      }
    }
    const guards = this.validateAction(command, turn);
    const review = this.review(command, turn);
    const autoWrite = command.type === "calendar.propose" && this.hooks.settings().autoApprove && !command.change.attendees.some(attendee => attendee.trim());
    const description = autoWrite ? "Writes exactly this calendar change when you confirm. No attendees are notified, so it is approved automatically (Activity setting)." :
      command.type === "calendar.propose" ? "Creates a separate calendar approval, not a provider write. Afterwards ask chat to prepare its exact write preview, or review it in Calendar." :
      command.type === "draft.generate" ? "Generates a local reply draft using the selected AI provider. Afterwards ask chat for an exact native-save preview, or review it in Drafts. Never sends mail." :
      command.type === "review.start" ? "Starts a bounded full-archive review using your AI budget. Pause or cancel it in AI review." :
      command.type === "draft.save" || command.type === "draft.handoff" ? "Saves exactly the reviewed recipients, subject and body as a native mailbox draft. Nothing is sent. Uncertain saves must be checked in the mailbox." :
      command.type === "calendar.approve" ? "Writes exactly this reviewed calendar change. Provider invitation/update notifications may be sent to every listed attendee." :
      command.type === "task.schedule" ? "Writes the exact private task event and reminder shown below. No attendees or invitations." :
      command.type === "browser.calendar.move" ? "Moves the reviewed meeting using Google Calendar in your paired browser. Verify the account, date, time zone, and guest-notification effects before confirming." :
      command.type === "refresh.request" ? "Refreshes selected connected inboxes. Browser refresh requires the companion and signed-in tabs." :
      command.type === "report.generate" ? "Generates a local focus report using your AI budget." : "Changes a local task only; it does not write to a calendar.";
    const preview = JSON.stringify(review ? { command, review } : command, null, 2);
    if (preview.length > 16000) throw new Error("This action is too large for a complete chat preview. Use the dedicated review screen.");
    const action: StoredAction = { id: randomUUID(), title: actionTitles[command.type], description, preview,
      status: "pending", command, guards, review };
    turn.actions.push(action); this.persist();
    return { actionId: action.id, status: "pending_confirmation", preview: action.preview, description,
      instruction: "Nothing has been executed. The user must confirm this exact card in the app." };
  }
  private async confirm(command: Extract<ChatCommand, { type: "chat.confirm" }>): Promise<CommandResult> {
    const conversation = this.state.conversations.find(c => c.id === command.conversationId);
    const turn = conversation?.turns.find(t => t.id === command.turnId);
    const action = turn?.actions.find(a => a.id === command.actionId);
    if (!turn || turn.status !== "complete" || !action || action.status !== "pending") throw new Error("This action is not awaiting confirmation.");
    this.confirming = true;
    try {
      if (!turn.evidence.every(ref => this.valid(ref)) || !action.guards.every(ref => this.valid(ref, true)))
        throw new Error("Source permissions or action targets changed. Propose the action again.");
      const payload = commandSchema.parse(action.command) as ProposedCommand;
      const review = this.review(payload, turn);
      if (!allowedActions.includes(payload.type) || JSON.stringify(review ? { command: payload, review } : payload, null, 2) !== action.preview)
        throw new Error("Stored action preview does not match its payload.");
      this.validateAction(payload, turn);
      action.status = "running"; this.persist();
      const beforeWrite = () => {
        if (!turn.evidence.every(ref => this.valid(ref))) throw new Error("Source permissions changed before writing.");
        const mutable = payload.type === "draft.handoff" || payload.type === "draft.save" ? "drafts" :
          payload.type === "task.schedule" ? "tasks" : payload.type === "calendar.approve" ? "approvals" : undefined;
        const mutableId = "draftId" in payload ? payload.draftId : "taskId" in payload ? payload.taskId :
          "approvalId" in payload ? payload.approvalId : undefined;
        if (!action.guards.every(ref => ref.collection === mutable && ref.id === mutableId ? this.valid(ref) : this.valid(ref, true)))
          throw new Error("Reviewed evidence changed before writing.");
        if (payload.type === "draft.handoff" || payload.type === "draft.save") {
          const current = this.draftReview(payload, turn);
          if (hash(current) !== hash(review)) throw new Error("The reviewed draft changed before writing.");
          const draft = this.vault.get<Draft>("drafts", payload.draftId)!;
          if (draft.subject !== current.subject || draft.body !== current.body || hash(draft.recipients) !== hash(current.recipients))
            throw new Error("The reviewed draft fields changed before writing.");
        }
        if (payload.type === "calendar.approve") {
          const approval = this.vault.get<Approval>("approvals", payload.approvalId);
          if (!approval) throw new Error("The reviewed approval changed before writing.");
          validateApproval(approval, payload.hash);
          if (hash({ change: approval.change, hash: approval.hash, effect: approval.effect }) !== hash(review))
            throw new Error("The reviewed calendar change changed before writing.");
        }
        if (payload.type === "task.schedule") {
          const task = this.hooks.workspace().tasks?.find(task => task.id === payload.taskId);
          if (!task || hash(this.taskFields(task)) !== hash(review?.task) ||
              (task.schedule && payloadHash(task.schedule.change) !== payloadHash(payload.change)))
            throw new Error("The reviewed task or calendar change changed before writing.");
        }
      };
      const result = await this.hooks.execute(payload, beforeWrite);
      action.status = result.browserCalendarOutcome === "needs-user" ? "needs-user" :
        result.browserCalendarOutcome === "uncertain" ? "uncertain" : "completed";
      action.result = result.message ?? "The approved app command completed. Inspect the relevant workspace for its result.";
      const references = [["Draft", result.draftId], ["Approval", result.approvalId], ["Task", result.taskId], ["Event", result.eventId]]
        .filter(([, id]) => id).map(([kind, id]) => `${kind} ID: ${id}`);
      if (references.length) action.result += `\n${references.join("\n")}`;
      this.persist();
      return { ...result, conversationId: conversation!.id };
    } catch (error) {
      action.status = "failed";
      action.result = error instanceof Error && /changed|preview|payload|Unsupported/.test(error.message) ? error.message :
        "The approved action failed. Inspect Activity and the workspace; this card will not execute again automatically.";
      this.persist();
      throw new Error(action.result);
    } finally { this.confirming = false; this.redact(); this.persist(); }
  }
  async settled(): Promise<void> { await this.active?.promise; }
  async stop(): Promise<void> {
    this.stopped = true; this.active?.controller.abort();
    await this.settled();
    await this.confirmation?.catch(() => undefined);
  }
}
