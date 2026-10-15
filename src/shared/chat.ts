import type { Citation } from "./contracts";
import type { MailFreshnessResult } from "./mail-freshness";

export const CHAT_MESSAGE_MAX = 12_000;
export const CHAT_PROMPT_MAX = 100_000;
export const CHAT_TOOL_OUTPUT_BUDGET = 160_000;
export type ChatMailRefresh = "download" | "local";

export function skipsChatMailRefresh(text: string): boolean {
  return /\b(?:no\s+need\s+to|do\s+not|don['’]?t|without|skip|no)\s+(?:a\s+|any\s+)?(?:refresh(?:ing)?|download(?:ing)?|sync(?:ing)?|fetch(?:ing)?)(?:\b|es\b)/i.test(text)
    || /\b(?:use|only|just)\s+(?:(?:the|already|existing)\s+)*(?:local|saved|downloaded|cached)\s+(?:messages|emails|mail|data|archive)\b/i.test(text)
    || /\b(?:ne\s+pas|pas\s+besoin\s+de|sans)\s+(?:actualiser|rafra[iî]chir|télécharger|synchroniser)\b/i.test(text);
}
export class ChatLimitError extends Error {
  constructor(message: string) { super(message); this.name = "ChatLimitError"; }
}
export class ChatTimeoutError extends Error {
  constructor(readonly reason: "idle" | "deadline") {
    super(reason === "idle" ? "Copilot stopped responding for three minutes." : "Copilot reached the ten-minute request deadline.");
    this.name = "ChatTimeoutError";
  }
}

export interface ChatAction {
  id: string;
  title: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "needs-user" | "uncertain";
  preview: string;
  result?: string;
}
export interface ChatPermission {
  id: string;
  kind: "shell" | "read" | "write" | "url" | "other";
  title: string;
  detail: string;
  intention?: string;
  status: "pending" | "approved" | "approved-chat" | "denied" | "expired";
}
export interface ChatFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  model?: string;
  status: "working" | "complete" | "error" | "cancelled";
  progress?: string;
  citations: Citation[];
  actions: ChatAction[];
  mailFreshness?: MailFreshnessResult[];
  mailRefresh?: ChatMailRefresh;
  permissions?: ChatPermission[];
  files?: ChatFile[];
}
export interface ChatConversation {
  id: string;
  title: string;
  updatedAt: string;
  turns: ChatTurn[];
  /** Shell/web approvals granted with "Allow for this response"; cleared when the next request starts. */
  grants?: ("shell" | "url" | "read")[];
}

/**
 * Workspace files the assistant writes may only be launched with their default app when they are passive
 * document formats. Anything else (scripts, .hta, .url, .lnk, macro-enabled Office files…) is "Show in folder" only,
 * so prompt-injected content can never turn the Open button into code execution.
 */
const OPENABLE_FILE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf", ".txt", ".md", ".csv", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export function chatFileOpenable(name: string): boolean {
  const match = /(\.[a-z0-9]+)$/i.exec(name.trim());
  return !!match && OPENABLE_FILE_EXTENSIONS.has(match[1].toLowerCase()) && !/[:\u0000-\u001f]/.test(name);
}
export interface ChatState {
  conversations: ChatConversation[];
  activeConversationId?: string;
  busy: boolean;
}
export type ChatCommand =
  | { type: "chat.new" }
  | { type: "chat.send"; conversationId?: string; text: string; model?: string; mailRefresh?: ChatMailRefresh }
  | { type: "chat.confirm"; conversationId: string; turnId: string; actionId: string }
  | { type: "chat.cancel" }
  | { type: "chat.delete"; conversationId: string }
  | { type: "chat.permission"; conversationId: string; turnId: string; requestId: string; decision: "once" | "chat" | "deny" }
  | { type: "chat.openFile"; conversationId: string; turnId: string; path: string; reveal?: boolean };
