import type { BrowserCalendarItem, BrowserPairing, BrowserStatus } from "./browser";
import type { AiReviewCoverage, FocusReport, ProductivityCommand, TaskItem } from "./productivity";
import type { ChatCommand, ChatState } from "./chat";
import type { GmailApiOrigin, MailTransportStatus, PlaywrightMailStatus } from "./mail-transport";
export type Provider = "gmail" | "microsoft" | "slack" | "whatsapp";
export type Collection = "accounts" | "sources" | "messages" | "drafts" | "attachments" | "events" | "browserItems" | "actions" | "tasks" | "reports" | "jobs" | "approvals" | "settings" | "checkpoints" | "secrets" | "audit" | "knowledge" | "documents";

export type KnowledgeProvider = "local" | "google-drive" | "dropbox" | "onedrive" | "web";
/** A local folder or public shared link indexed as read-only reference material for the assistant. */
export interface KnowledgeSource {
  id: string;
  kind: "folder" | "link";
  provider: KnowledgeProvider;
  name: string;
  /** Absolute folder path or the original share URL. */
  location: string;
  aiEnabled: boolean;
  addedAt: string;
  status: "idle" | "syncing" | "ready" | "error";
  progress?: string;
  lastSyncAt?: string;
  error?: string;
  files: number;
  indexed: number;
  skipped: number;
  failed: number;
  truncated?: boolean;
}

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  email: string;
  status: "connected" | "disconnected" | "error";
  aiEnabled: boolean;
  consent: boolean;
  lastSync?: string;
  error?: string;
  demo?: boolean;
  connection?: "api" | "browser" | "relay";
}
export interface Source {
  id: string;
  accountId: string;
  providerId: string;
  name: string;
  kind: "mail" | "channel" | "calendar";
  selected: boolean;
  lastSync?: string;
}
export interface Message {
  id: string;
  accountId: string;
  sourceId: string;
  providerId: string;
  threadId: string;
  subject: string;
  sender: string;
  recipients: string[];
  body: string;
  html?: string;
  /** Set in renderer snapshots when `html` was left out to keep them small; load it with `message.html`. */
  htmlOmitted?: boolean;
  receivedAt: string;
  url: string;
  unread: boolean;
  revision: string;
  historical: boolean;
  deleted?: boolean;
  gmailApi?: GmailApiOrigin;
  browser?: { completeness: "preview" | "full"; capturedAt: string; dateText: string; position?: number; attachmentRevision?: string; attachmentManifestVersion?: 1 };
}
export interface Draft {
  id: string;
  accountId: string;
  messageId: string;
  body: string;
  subject: string;
  recipients: string[];
  model?: string;
  updatedAt: string;
  sourceRevision: string;
  nativeTarget?: {
    accountId: string;
    provider: "gmail" | "microsoft";
    messageProviderId: string;
    threadProviderId: string;
    messageRevision: string;
    threadRevision?: string;
    resolvedAt: string;
  };
  providerId?: string;
  providerRevision?: string;
  savedBody?: string;
  status: "local" | "saved" | "stale" | "uncertain";
  citations: Citation[];
}
export interface MessageThread {
  accountId: string;
  sourceId: string;
  threadId: string;
  messages: Message[];
  attachments: Attachment[];
  loadedAt: string;
  cached: boolean;
}
export interface Attachment {
  id: string;
  accountId: string;
  messageId: string;
  providerId: string;
  name: string;
  mimeType: string;
  size?: number;
  status: "pending" | "awaiting-approval" | "downloading" | "extracting" | "indexed" | "partial" | "unsupported" | "encrypted" | "blocked" | "failed" | "cancelled";
  reason?: string;
  approved?: boolean;
  hash?: string;
  browser?: { source: "browser_gmail" | "browser_whatsapp"; metadataId: string };
  gmailApi?: GmailApiOrigin;
  /** Snapshot-only parent metadata, freshly derived by main; commands still enforce access. */
  sourceId?: string;
  parentAvailable?: boolean;
}
export interface AttachmentView {
  attachmentId: string;
  name: string;
  mimeType: string;
  kind: "pdf" | "image" | "text" | "unsupported" | "unavailable";
  base64?: string;
  text?: string;
  truncated: boolean;
  canSave: boolean;
  message?: string;
}
export interface AttachmentSave {
  status: "saved" | "cancelled" | "unavailable";
  name?: string;
  message: string;
}
export interface CalendarEvent {
  id: string;
  accountId: string;
  sourceId: string;
  providerId: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
  attendees: string[];
  location: string;
  description: string;
  revision: string;
  url: string;
  recurring?: boolean;
  writable?: boolean;
  reminderMinutes?: number;
}
export interface EventChange {
  accountId: string;
  sourceId: string;
  eventId?: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: boolean;
  attendees: string[];
  location: string;
  description: string;
  expectedRevision?: string;
  reminderMinutes?: number;
}
export interface ActionItem {
  id: string;
  messageId: string;
  accountId: string;
  title: string;
  reason: string;
  priority: "urgent" | "important" | "normal";
  status: "open" | "done" | "snoozed" | "waiting";
  dueAt?: string;
  snoozedUntil?: string;
  confidence: number;
  citations: Citation[];
}
export interface Citation {
  id: string;
  messageId: string;
  title: string;
  excerpt: string;
  location?: string;
  attachmentId?: string;
  score?: number;
}
export interface Job {
  id: string;
  kind: "sync" | "attachment" | "index" | "ai" | "backup" | "calendar";
  accountId?: string;
  status: "pending" | "running" | "paused" | "done" | "failed";
  label: string;
  detail?: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
}
export interface Approval {
  id: string;
  kind: "calendar";
  change: EventChange;
  hash: string;
  createdAt: string;
  status: "pending" | "executing" | "done" | "failed" | "uncertain";
  effect: string;
  error?: string;
}
export type AiProviderId = "copilot" | "claude" | "codex";
export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  /** subscription: reuses the provider CLI's own sign-in; api-key: an encrypted key stored in this archive. */
  auth: "subscription" | "api-key";
  status: "disconnected" | "connecting" | "ready" | "error";
  message: string;
  hasKey?: boolean;
}
export interface Settings {
  model: string;
  aiProvider: AiProviderId;
  /** Last model chosen per provider, restored when switching back. */
  providerModels: Partial<Record<AiProviderId, string>>;
  /** Optional absolute path to the Codex CLI when it is not discoverable on PATH. */
  codexPath: string;
  dailyAiLimit: number;
  aiRunsToday: number;
  aiUsageDate: string;
  backgroundAi: boolean;
  syncPaused: boolean;
  startAtLogin: boolean;
  closeToTray: boolean;
  notifications: boolean;
  refreshIntervalSeconds: number;
  browserBackgroundCapture: boolean;
  browserFullMailDownload: boolean;
  browserAttachmentDownload: boolean;
  playwrightMailEnabled: boolean;
  browserMailTransport: "auto" | "companion";
  attachmentThresholdMb: number;
  semanticEnabled: boolean;
  embeddingModel: string;
  googleClientId: string;
  microsoftClientId: string;
  microsoftTenant: string;
  assistantTools: boolean;
  assistantWorkspaceDir: string;
  assistantShell: "ask" | "off";
  assistantWeb: "ask" | "off";
  /** New accounts get data access + AI and all discovered sources selected (WhatsApp excepted). */
  fullAccessByDefault: boolean;
  /** Activity approvals happen automatically: attachment downloads/processing and calendar changes without attendees. */
  autoApprove: boolean;
}
export interface GmailRelayPublicStatus {
  sourceId: string;
  accountId: string;
  mailbox: string;
  cursor: number;
  imported: number;
  pollIntervalMinutes: number;
  configured: boolean;
  stopped: boolean;
  lastSyncAt?: string;
  lastStatusAt?: string;
  lastError?: string;
  exportStatus?: string;
  phase?: string;
  latestSeq?: number;
  tokenExpiresAt?: string | null;
  tokenIsPrevious?: boolean;
  updatedAt?: string;
}
export interface ModelInfo { id: string; name: string }
export interface FullMailArchive {
  enabled: boolean;
  running: boolean;
  queued: number;
  complete: number;
  failed: number;
  total: number;
  currentAccountId?: string;
  lastError?: string;
  nextRetryAt?: string;
}
export interface Snapshot {
  fullMailArchive?: FullMailArchive;
  chat?: ChatState;
  accounts: Account[];
  sources: Source[];
  messages: Message[];
  drafts: Draft[];
  attachments: Attachment[];
  events: CalendarEvent[];
  actions: ActionItem[];
  jobs: Job[];
  approvals: Approval[];
  settings: Settings;
  /** Models of the active AI provider. */
  models: ModelInfo[];
  /** Connection status of the active AI provider (named for compatibility). */
  copilot: { status: "disconnected" | "connecting" | "ready" | "error"; message: string };
  ai?: { provider: AiProviderId; providers: AiProviderInfo[] };
  archive: { messages: number; attachments: number; indexed: number; searchMode: "hybrid" | "keyword"; bytes: number };
  demo: boolean;
  browser?: BrowserStatus;
  mailTransports?: MailTransportStatus[];
  gmailRelays?: GmailRelayPublicStatus[];
  assistantWorkspace?: string;
  playwrightMail?: PlaywrightMailStatus;
  browserItems?: BrowserCalendarItem[];
  knowledge?: KnowledgeSource[];
  tasks?: TaskItem[];
  focusReport?: FocusReport;
  aiReview?: AiReviewCoverage;
}
export type Command =
  | ChatCommand
  | ProductivityCommand
  | { type: "demo.load" }
  | { type: "demo.clear" }
  | { type: "account.connect"; provider: Exclude<Provider, "whatsapp">; token?: string; consent: boolean }
  | { type: "gmailRelay.test"; url: string; token: string }
  | { type: "gmailRelay.connect"; url: string; token: string; pollIntervalMinutes: number; consent: boolean }
  | { type: "gmailRelay.replaceToken"; sourceId: string; token: string }
  | { type: "gmailRelay.remove"; sourceId: string; forget: boolean }
  | { type: "gmailRelay.sync"; sourceId?: string }
  | { type: "assistant.workspace.open" }
  | { type: "assistant.workspace.choose" }
  | { type: "knowledge.folder.add"; name?: string }
  | { type: "knowledge.link.add"; url: string; name?: string }
  | { type: "knowledge.sync"; sourceId: string }
  | { type: "knowledge.update"; sourceId: string; aiEnabled?: boolean; name?: string }
  | { type: "knowledge.remove"; sourceId: string }
  | { type: "knowledge.open"; sourceId: string }
  | { type: "browser.pair"; consent: boolean }
  | { type: "browser.revoke" }
  | { type: "browser.extension" }
  | { type: "browser.playwright.open"; accountId: string }
  | { type: "browser.playwright.close" }
  | { type: "browser.open"; kind: "mail" | "calendar" | "add-account" | "whatsapp"; accountId?: string }
  | { type: "browser.open-link"; url: string }
  | { type: "browser.meeting"; itemId: string }
  | { type: "browser.calendar.move"; itemId: string; newDate: string; startTime: string; endTime: string; timeZone: string; expectedRevision: string }
  | { type: "account.disconnect"; accountId: string; forget: boolean }
  | { type: "account.ai"; accountId: string; enabled: boolean }
  | { type: "account.consent"; accountId: string; enabled: boolean }
  | { type: "source.select"; sourceId: string; selected: boolean }
  | { type: "sync"; accountId?: string }
  | { type: "refresh.request" }
  | { type: "settings.update"; patch: Partial<Settings> }
  | { type: "copilot.connect" }
  | { type: "copilot.login" }
  | { type: "ai.provider"; provider: AiProviderId }
  | { type: "ai.claudeKey"; key: string }
  | { type: "ai.claudeKey.clear" }
  | { type: "draft.generate"; messageId: string; instruction?: string; model?: string }
  | { type: "draft.edit"; draftId: string; body: string; recipients: string[]; subject: string }
  | { type: "draft.save"; draftId: string }
  | { type: "draft.handoff"; draftId: string; body: string; recipients: string[]; subject: string }
  | { type: "action.update"; actionId: string; status: ActionItem["status"]; snoozedUntil?: string }
  | { type: "search"; query: string; accountId?: string }
  | { type: "ask"; query: string; accountId?: string; model?: string }
  | { type: "attachment.process"; attachmentId: string; approved: boolean }
  | { type: "attachment.import"; attachmentId: string; approved: boolean }
  | { type: "attachment.download"; attachmentId: string; approved: boolean }
  | { type: "attachment.view"; attachmentId: string }
  | { type: "attachment.save"; attachmentId: string }
  | { type: "calendar.propose"; change: EventChange }
  | { type: "calendar.approve"; approvalId: string; hash: string }
  | { type: "open.message"; messageId: string }
  | { type: "message.load"; messageId: string; refresh?: boolean }
  | { type: "message.html"; messageId: string }
  | { type: "message.downloadAll" }
  | { type: "clipboard.copy"; text: string }
  | { type: "job.retry"; jobId: string }
  | { type: "archive.backup" }
  | { type: "archive.restore" }
  | { type: "archive.reindex" };
export interface CommandResult {
  messageThread?: MessageThread;
  html?: string;
  attachmentView?: AttachmentView;
  attachmentSave?: AttachmentSave;
  browserCalendarOutcome?: "saved" | "needs-user" | "uncertain";
  conversationId?: string;
  message?: string;
  citations?: Citation[];
  answer?: string;
  draftId?: string;
  approvalId?: string;
  browserPairing?: BrowserPairing;
  eventId?: string;
  taskId?: string;
  reportId?: string;
}
export interface DesktopBridge {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<CommandResult>;
  onChange(listener: () => void): () => void;
}
declare global {
  interface Window { relay: DesktopBridge }
}
