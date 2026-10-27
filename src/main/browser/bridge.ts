import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { browserAttachmentsSchema } from "./attachment-schema";
import type { BrowserMailPendingHint, BrowserMailRequest } from "../../shared/browser-mail";
import type { BrowserCalendarMove, BrowserCalendarResult, BrowserCalendarResultCode } from "../../shared/browser-calendar";
import {
  BROWSER_BRIDGE_PORT,
  type BrowserAccess,
  type BrowserCapture,
  type BrowserKind,
  type BrowserPairing,
  type BrowserRegistration,
  type BrowserStatus,
} from "../../shared/browser";

interface SecretVault {
  get<T>(collection: "secrets", id: string): T | undefined;
  put<T>(collection: "secrets", id: string, value: T): void;
  delete(collection: "secrets", id: string): void;
}
interface BridgeOptions {
  extensionId: string;
  onDiscover: (registration: BrowserRegistration) => Promise<BrowserAccess>;
  onCapture: (capture: BrowserCapture) => Promise<void>;
  changed: () => void;
  refreshSettings?: () => { intervalSeconds: number; paused: boolean; backgroundCapture?: boolean };
  port?: number;
  /** File inside the installed companion folder. Holding its per-launch secret lets an unpaired companion pair itself. */
  bootstrapFile?: string;
}
const SECRET_ID = "browser-bridge-token";
const AUTO_PAIR_OFF_ID = "browser-bridge-autopair-off";
const CLIENT_META_ID = "browser-bridge-clients";
const MAX_CLIENTS = 8;
const CLIENT_LIMIT_ERROR = "Browser pairing limit reached (8 clients). Revoke all browser pairings in Relay Desk, then pair the browsers you want to keep.";
const storedToken = z.string().regex(/^[a-f0-9]{64}$/);
const storedClientMeta = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  browser: z.enum(["edge", "chrome", "unknown"]).optional(),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  discoveredAccountIds: z.array(z.string().min(1).max(512)).max(64).optional(),
}).strict();
const storedClients = z.union([
  z.object({ extensionId: z.string(), token: storedToken }).strict(),
  z.object({ extensionId: z.string(), tokens: z.array(storedToken).min(1).max(MAX_CLIENTS) }).strict(),
]);
const storedClientMetas = z.object({
  extensionId: z.string(),
  clients: z.array(storedClientMeta).max(MAX_CLIENTS),
}).strict();
const MAX_BODY = 2 * 1024 * 1024;
const text = (max: number) => z.string().max(max);
const identifier = text(512).min(1);
const url = text(8192).url();
const registration = z.object({
  accountEmail: z.union([z.string().trim().toLowerCase().email().max(254), z.string().regex(/^\+[1-9]\d{6,14}$/)]),
  accountName: text(512),
  pageUrl: url,
  kind: z.enum(["mail", "calendar", "whatsapp"]),
  chat: z.object({ id: text(128).regex(/^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/), name: text(512).min(1) }).strict().optional(),
}).strict();
const capture = registration.extend({
  messages: z.array(z.object({
    id: identifier, threadId: identifier, subject: text(4096), sender: text(2048),
    recipients: z.array(text(2048)).max(200), body: text(1_000_000),
    html: text(1_000_000).refine(value => Buffer.byteLength(value, "utf8") <= 1_000_000).optional(),
    receivedAt: z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value))).optional(),
    dateText: text(512), url, unread: z.boolean(), completeness: z.enum(["preview", "full"]),
    attachments: browserAttachmentsSchema.optional(),
    attachmentManifestVersion: z.literal(1).optional(),
  }).strict().refine(message => message.completeness === "full" || (!message.attachments?.length && message.html === undefined),
    "Attachment metadata and HTML require a full message.")
    .refine(message => message.attachmentManifestVersion === undefined || (message.completeness === "full" && message.attachments !== undefined),
      "A versioned attachment manifest requires an inspected full message.")).max(200),
  meetings: z.array(z.object({
    id: identifier, title: text(4096), whenText: text(2048), description: text(100_000),
    location: text(4096), meetingUrl: url.optional(), url,
  }).strict()).max(100),
}).strict();
const access = z.object({ accountId: text(512).min(1), enabled: z.boolean() }).strict();
const calendarMove = z.object({
  accountId: identifier, accountEmail: z.string().email().max(254),
  itemId: identifier, providerId: identifier, expectedTitle: text(4096).min(1), expectedWhenText: text(2048).min(1),
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: text(100).min(1).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return value === "UTC" || value.includes("/"); }
    catch { return false; }
  }),
  notificationPolicy: z.literal("provider-default"),
  expiresAt: z.string().datetime({ offset: true }), proofRevision: identifier,
}).strict().refine(value => value.startTime < value.endTime);
const calendarPoll = z.object({
  protocol: z.literal(1), registration,
  tabId: z.number().int().nonnegative(), documentId: text(128).min(1),
}).strict();
const calendarLease = calendarPoll.extend({
  requestId: z.string().regex(/^[a-f0-9]{32}$/), lease: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const calendarCodes = ["saved", "busy", "expired", "unavailable", "account-mismatch", "event-not-found",
  "event-changed", "unsupported-editor", "time-zone-unverified", "recurring-event", "permission-denied",
  "authorization-denied", "notification-confirmation", "save-unverified"] as const;
const calendarComplete = calendarLease.extend({ code: z.enum(calendarCodes) }).strict();
const mailRead = z.object({
  accountId: identifier, accountEmail: z.string().trim().toLowerCase().email().max(254),
  threadId: text(256).regex(/^[A-Za-z0-9_-]+$/), messageProviderId: identifier.optional(),
  inboxRefresh: z.literal(true).optional(),
  attachment: z.object({
    metadataId: identifier, name: text(200).min(1),
    maxBytes: z.number().int().positive().max(512 * 1024 * 1024),
    approved: z.boolean().optional(),
    allowUnknownSize: z.boolean().optional(),
    relativePath: text(512).regex(/^RelayDesk\/[a-f0-9-]{36}\/[^\\/:*?"<>|\u0000-\u001f]+$/),
  }).strict().refine(value => !value.allowUnknownSize || value.approved === true,
    "Unknown-size downloads require explicit approval.").optional(),
}).strict().refine(value => !value.inboxRefresh || (!value.attachment && !value.messageProviderId
  && value.threadId === "__relay_inbox__"), "Inbox refresh cannot authorize a conversation or attachment.");
const mailRowProof = z.object({
  threadId: text(256).regex(/^[A-Za-z0-9_-]+$/), inboxUrl: url,
  providerThreadId: text(512).min(1).optional(), targetUrl: url.optional(),
}).strict();
const mailPoll = calendarPoll.extend({
  requestId: z.string().regex(/^[a-f0-9]{32}$/).optional(), lease: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  wakeRequestId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  sourceTabId: z.number().int().nonnegative().optional(), sourceDocumentId: text(128).min(1).optional(),
  rowProof: mailRowProof.optional(),
}).strict();
const mailDiagnostics = z.object({
  containers: z.number().int().min(0).max(10000), bodies: z.number().int().min(0).max(10000),
  senders: z.number().int().min(0).max(10000), threadMarkers: z.number().int().min(0).max(10000),
  rows: z.number().int().min(0).max(10000).optional(), matchingRows: z.number().int().min(0).max(10000).optional(),
  refreshMutations: z.number().int().min(0).max(10000).optional(), refreshQuietMs: z.number().int().min(0).max(10000).optional(),
  refreshBusy: z.number().int().min(0).max(1).optional(), extractedRows: z.number().int().min(0).max(10000).optional(),
}).strict();
const mailComplete = calendarLease.extend({
  code: z.enum(["complete", "unavailable", "account-mismatch", "thread-mismatch", "unsupported", "partial", "interrupted",
    "attachment-unavailable", "attachment-size-limit", "attachment-dangerous", "attachment-interrupted",
    "attachment-path-mismatch", "attachment-authorization-denied"]),
  capture: capture.extend({
    attachmentDownload: z.object({
      metadataId: identifier, name: text(200).min(1), relativePath: text(512).min(1),
      bytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
      downloadId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict().optional(),
  }).strict().optional(), diagnostics: mailDiagnostics.optional(),
}).strict();
const mailDispatch = z.object({
  protocol: z.literal(1), requestId: z.string().regex(/^[a-f0-9]{32}$/),
  code: z.enum(["wake", "no-route", "document-not-ready", "read-in-progress", "account-mismatch", "interrupted", "delivery-failed"]),
}).strict();
interface PendingMailRead {
  requestId: string; input: BrowserMailRequest; guards: Set<() => void>; promise: Promise<BrowserCapture>;
  generation: number; deadline: number; timer: ReturnType<typeof setTimeout>;
  resolve: (capture: BrowserCapture) => void; reject: (error: Error) => void;
  client?: string; lease?: string; tabId?: number; documentId?: string; route?: string; bound: boolean;
  rowProof?: z.infer<typeof mailRowProof>;
  boundPageUrl?: string;
  wakeClient?: string;
  attachmentAuthorized?: boolean;
  cleanup?: () => void;
}
const calendarMessages: Record<BrowserCalendarResultCode, string> = {
  saved: "Google Calendar confirmed the save and the event date, times and time zone were read back.",
  busy: "Another browser calendar action or an existing editor is open. Finish it before reviewing a new move.",
  expired: "This browser move expired. Review a fresh proposal; it was not retried.",
  unavailable: "Open the selected Google Calendar account in the updated Edge/Chrome companion, with the captured event visible, then review a fresh move.",
  "account-mismatch": "The browser account changed. Open the reviewed Google account and review a fresh move.",
  "event-not-found": "The exact captured event is not visible. Open its Calendar schedule view and refresh the capture, then review again.",
  "event-changed": "The captured event changed. Refresh the capture and review a fresh move.",
  "unsupported-editor": "Calendar's editor could not be verified safely. No Save was clicked; finish the move manually in the browser.",
  "time-zone-unverified": "Calendar's event time zone could not be verified against the reviewed IANA zone. No Save was clicked.",
  "recurring-event": "Recurring events require a manual occurrence/series choice. No Save was clicked.",
  "permission-denied": "This event has no verified editable controls. No Save was clicked.",
  "authorization-denied": "The reviewed move is no longer authorized. No Save was authorized.",
  "notification-confirmation": "Google Calendar is asking for a confirmation, possibly guest notifications. Finish it in the browser; the move is not confirmed saved.",
  "save-unverified": "Save may have occurred, but the final event could not be verified. Check Google Calendar before attempting another move.",
};
interface PendingCalendarMove {
  requestId: string; move: BrowserCalendarMove; beforeWrite: () => void;
  generation: number; deadline: number; timer: ReturnType<typeof setTimeout>;
  resolve: (result: BrowserCalendarResult) => void;
  client?: string; lease?: string; tabId?: number; documentId?: string; route?: string;
  authorized: boolean;
}
const safeCallbackErrors = new Set([
  "Connect this browser account before capturing.",
  "Select this source before capturing.",
  "Select this account's source in Relay Desk first.",
  "Browser capture is paused in Relay Desk.",
  "Gmail previews contain no readable text. Activate the Gmail tab and capture again; existing messages were preserved.",
  "Browser account or source was excluded during capture.",
  "Account is disabled.", "Source is disabled.",
  "This browser account was forgotten. Pair again to authorize discovery.",
  "This browser account is disconnected. Pair again to reconnect.",
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function forbidden(): never { throw new HttpError(403, "Forbidden."); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function providerRoute(value: string, kind: BrowserRegistration["kind"], email: string): string {
  const parsed = new URL(value);
  if (kind === "whatsapp") {
    if (value !== "https://web.whatsapp.com/") throw new HttpError(400, "Invalid WhatsApp Web URL.");
    return "whatsapp";
  }
  const host = kind === "mail" ? "mail.google.com" : "calendar.google.com";
  const prefix = kind === "mail" ? "/mail/" : "/calendar/";
  if (parsed.origin !== `https://${host}` || parsed.username || parsed.password ||
      !value.startsWith(`https://${host}/`) || /[\\\s]/.test(value) || !parsed.pathname.startsWith(prefix))
    throw new HttpError(400, "Invalid provider URL.");
  const tail = parsed.pathname.slice(prefix.length);
  const slot = /^u\/(0|[1-9]\d{0,3})(?:\/|$)/.exec(tail)?.[1];
  if (tail.startsWith("u/") && slot === undefined) throw new HttpError(400, "Invalid account route.");
  if (/%|(?:^|\/)u\//.test(tail.replace(/^u\/\d+\/?/, "")))
    throw new HttpError(400, "Invalid account route.");
  const selectors = parsed.searchParams.getAll("authuser");
  if (selectors.length > 1) throw new HttpError(400, "Invalid account route.");
  const selector = selectors[0];
  if (selector !== undefined && !/^(0|[1-9]\d{0,3})$/.test(selector) && selector.toLowerCase() !== email)
    throw new HttpError(400, "Invalid account route.");
  if (slot !== undefined && selector !== undefined && selector !== slot)
    throw new HttpError(400, "Conflicting account route.");
  return slot ?? selector?.toLowerCase() ?? "0";
}
function validateRoutes(input: BrowserRegistration | BrowserCapture): void {
  if (input.kind === "whatsapp" ? !/^\+[1-9]\d{6,14}$/.test(input.accountEmail)
    : !input.accountEmail.includes("@") || input.chat !== undefined)
    throw new HttpError(400, "Invalid provider identity.");
  const route = providerRoute(input.pageUrl, input.kind, input.accountEmail);
  if (!("messages" in input)) return;
  if (input.kind === "whatsapp" && (!input.chat || input.meetings.length || input.messages.some(message =>
    message.threadId !== input.chat!.id || message.completeness !== "full" || message.html !== undefined
    || !(message.id.startsWith(`true_${input.chat!.id}_`) || message.id.startsWith(`false_${input.chat!.id}_`)))))
    throw new HttpError(400, "WhatsApp capture must match its selected chat.");
  if ((input.kind === "mail" && input.meetings.length) || (input.kind === "calendar" && input.messages.length))
    throw new HttpError(400, "Invalid capture kind.");
  for (const item of [...input.messages, ...input.meetings]) {
    if (providerRoute(item.url, input.kind, input.accountEmail) !== route)
      throw new HttpError(400, "Mismatched account route.");
  }
  for (const item of input.meetings) {
    if (item.meetingUrl) {
      const meeting = new URL(item.meetingUrl);
      if (meeting.origin !== "https://meet.google.com" || meeting.username || meeting.password ||
          !item.meetingUrl.startsWith("https://meet.google.com/") || /[\\\s]/.test(item.meetingUrl))
        throw new HttpError(400, "Invalid meeting URL.");
    }
  }
}
function refreshInterval(settings: { intervalSeconds: number; paused: boolean; backgroundCapture?: boolean } | undefined): number {
  const value = settings?.intervalSeconds;
  if (value === 0) return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 30 && value <= 3600) return value;
  return 60;
}
function clientId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
function browserKind(userAgent: string | string[] | undefined): BrowserKind {
  const value = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("edg/")) return "edge";
  if (normalized.includes("chrome/")) return "chrome";
  return "unknown";
}

export class BrowserBridge {
  private server?: Server;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly sockets = new Set<Socket>();
  private pendingCode?: { code: string; expires: number; attempts: number };
  private lastCapture?: string;
  private error?: string;
  private generation = 0;
  private active = 0;
  private budget = 120;
  private budgetTime = Date.now();
  private readonly origin: string;
  private readonly configuredPort: number;
  private refreshRequestedAt = 0;
  private calendarPending?: PendingCalendarMove;
  private readonly calendarCapabilities = new Map<string, { protocol: 1; lastSeenAt: string }>();
  private readonly mailPending = new Map<string, PendingMailRead>();

  constructor(private readonly vault: SecretVault, private readonly options: BridgeOptions) {
    if (!/^[a-p]{32}$/.test(options.extensionId)) throw new Error("Invalid browser extension ID.");
    this.configuredPort = options.port ?? BROWSER_BRIDGE_PORT;
    if (!Number.isInteger(this.configuredPort) || this.configuredPort < 0 || this.configuredPort > 65535)
      throw new Error("Invalid browser bridge port.");
    this.origin = `chrome-extension://${options.extensionId}`;
  }

  private bootstrap?: string;
  private removeBootstrap(): void {
    this.bootstrap = undefined;
    if (this.options.bootstrapFile) try { rmSync(this.options.bootstrapFile, { force: true }); } catch { /* best effort */ }
  }
  private writeBootstrap(): void {
    this.removeBootstrap();
    if (!this.options.bootstrapFile || this.vault.get<unknown>("secrets", AUTO_PAIR_OFF_ID) === true) return;
    const secret = randomBytes(32).toString("hex");
    try {
      writeFileSync(this.options.bootstrapFile, JSON.stringify({ version: 1, secret, port: this.status().port }), { mode: 0o600 });
      this.bootstrap = secret;
    } catch { /* the companion can still pair with a code */ }
  }
  private issueToken(request: IncomingMessage, response: ServerResponse, replaceStale: boolean): void {
    let tokens = this.tokens();
    if (tokens.length >= MAX_CLIENTS) {
      if (!replaceStale) throw new HttpError(409, CLIENT_LIMIT_ERROR);
      const seen = new Map(this.clientMetas().map(client => [client.id, client.lastSeenAt ?? ""]));
      const stalest = [...tokens].sort((a, b) => (seen.get(clientId(a)) ?? "").localeCompare(seen.get(clientId(b)) ?? ""))[0];
      tokens = tokens.filter(token => token !== stalest);
    }
    const next = randomBytes(32).toString("hex");
    this.vault.put("secrets", SECRET_ID, { tokens: [...tokens, next], extensionId: this.options.extensionId });
    this.updateClientMeta(next, current => ({
      ...current,
      browser: browserKind(request.headers["user-agent"]),
      lastSeenAt: new Date().toISOString(),
    }));
    this.options.changed();
    this.reply(response, 200, { token: next });
  }

  private refreshSettings(): { intervalSeconds: number; paused: boolean; backgroundCapture: boolean } {
    const settings = this.options.refreshSettings?.();
    return {
      intervalSeconds: refreshInterval(settings),
      paused: settings?.paused === true,
      backgroundCapture: settings?.backgroundCapture === true,
    };
  }
  private tokens(): string[] {
    const stored = storedClients.safeParse(this.vault.get<unknown>("secrets", SECRET_ID));
    if (!stored.success || stored.data.extensionId !== this.options.extensionId) return [];
    return "tokens" in stored.data ? stored.data.tokens : [stored.data.token];
  }
  private clientMetas(): Array<z.infer<typeof storedClientMeta>> {
    const stored = storedClientMetas.safeParse(this.vault.get<unknown>("secrets", CLIENT_META_ID));
    if (!stored.success || stored.data.extensionId !== this.options.extensionId) return [];
    return stored.data.clients;
  }
  private writeClientMetas(clients: Array<z.infer<typeof storedClientMeta>>): void {
    const current = new Set(this.tokens().map(clientId));
    const sanitized = clients
      .filter(client => current.has(client.id))
      .slice(0, MAX_CLIENTS)
      .map(client => ({
        id: client.id,
        ...(client.browser ? { browser: client.browser } : {}),
        ...(client.lastSeenAt ? { lastSeenAt: client.lastSeenAt } : {}),
        ...(client.discoveredAccountIds?.length ? { discoveredAccountIds: [...new Set(client.discoveredAccountIds)].slice(0, 64) } : {}),
      }));
    if (!sanitized.length) {
      this.vault.delete("secrets", CLIENT_META_ID);
      return;
    }
    this.vault.put("secrets", CLIENT_META_ID, { extensionId: this.options.extensionId, clients: sanitized });
  }
  private updateClientMeta(token: string, patch: (current: z.infer<typeof storedClientMeta>) => z.infer<typeof storedClientMeta>): void {
    if (!this.tokens().includes(token)) return;
    const id = clientId(token);
    const clients = this.clientMetas();
    const index = clients.findIndex(client => client.id === id);
    const current = index >= 0 ? clients[index] : { id, browser: "unknown" as const };
    const next = patch(current);
    if (index >= 0) clients[index] = next;
    else clients.push(next);
    this.writeClientMetas(clients);
  }
  private summarizeClients(): BrowserStatus["clients"] {
    const meta = new Map(this.clientMetas().map(client => [client.id, client]));
    const clients = this.tokens().map(token => {
      const id = clientId(token);
      const current = meta.get(id);
      const calendar = this.calendarCapabilities.get(id);
      return {
        id,
        browser: current?.browser ?? "unknown",
        ...(current?.lastSeenAt ? { lastSeenAt: current.lastSeenAt } : {}),
        ...(current?.discoveredAccountIds?.length ? { discoveredAccountIds: current.discoveredAccountIds } : {}),
        ...(calendar ? { calendarActions: {
          ...calendar,
          ready: Boolean(this.server?.listening) && Date.now() - Date.parse(calendar.lastSeenAt) < 30_000,
        } } : {}),
      };
    });
    return clients.length ? clients : undefined;
  }
  status(): BrowserStatus {
    const address = this.server?.address();
    const clients = this.summarizeClients();
    return {
      running: this.server?.listening ?? false,
      paired: this.tokens().length > 0,
      port: address && typeof address !== "string" ? address.port : this.configuredPort,
      ...(this.lastCapture ? { lastCapture: this.lastCapture } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(clients ? { clients } : {}),
    };
  }
  requestRefresh(): void {
    if (this.refreshSettings().paused) return;
    this.refreshRequestedAt = Date.now();
  }
  readMailThread(input: BrowserMailRequest, beforeRead: () => void, signal?: AbortSignal): Promise<BrowserCapture> {
    try {
      const value = mailRead.parse(input);
      signal?.throwIfAborted();
      beforeRead();
      if (!this.server?.listening || !this.tokens().length)
        throw new Error("Full email unavailable: open and pair the updated browser companion.");
      const key = JSON.stringify([value.accountId, value.threadId]);
      const existing = this.mailPending.get(key);
      if (existing) {
        if (existing.input.accountEmail !== value.accountEmail) throw new Error("Full email account mismatch.");
        if (existing.input.inboxRefresh !== value.inboxRefresh
          || JSON.stringify(existing.input.attachment) !== JSON.stringify(value.attachment))
          throw new Error("This conversation already has a different browser read in progress.");
        existing.guards.add(beforeRead);
        return existing.promise;
      }
      if (this.mailPending.size >= 3) throw new Error("Three full email reads are already active. Try again after one finishes.");
      let resolve!: (capture: BrowserCapture) => void, reject!: (error: Error) => void;
      const promise = new Promise<BrowserCapture>((yes, no) => { resolve = yes; reject = no; });
      const budget = value.attachment ? 300_000 : 90_000;
      const pending: PendingMailRead = {
        requestId: randomBytes(16).toString("hex"), input: value, guards: new Set([beforeRead]), promise,
        generation: this.generation, deadline: Date.now() + budget, resolve, reject, bound: false,
        timer: setTimeout(() => this.finishMail(pending, new Error(`Full email read timed out (${pending.bound
          ? "read-in-progress" : pending.lease || pending.wakeClient ? "document-not-ready" : "unclaimed"}). No preview was substituted.`)), budget),
      };
      this.mailPending.set(key, pending);
      if (signal) {
        const abort = () => this.finishMail(pending, new Error("Browser mail request cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", abort);
      }
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private finishMail(pending: PendingMailRead, result: BrowserCapture | Error): void {
    const key = JSON.stringify([pending.input.accountId, pending.input.threadId]);
    if (this.mailPending.get(key) !== pending) return;
    this.mailPending.delete(key);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
  }
  private cancelMail(reason: string): void {
    for (const pending of this.mailPending.values()) this.finishMail(pending, new Error(reason));
  }
  private async mailRequest(path: string, input: unknown, token: string): Promise<unknown> {
    if (path === "/mail/pending" || path === "/mail/dispatch") {
      const client = clientId(token);
      const accounts = this.clientMetas().find(meta => meta.id === client)?.discoveredAccountIds ?? [];
      const eligible = (pending: PendingMailRead) => accounts.includes(pending.input.accountId) &&
        (!pending.client || pending.client === client) && (!pending.wakeClient || pending.wakeClient === client);
      const authorize = (pending: PendingMailRead) => {
        if (pending.generation !== this.generation || pending.deadline <= Date.now()) {
          this.finishMail(pending, new Error("Full email read expired."));
          return false;
        }
        try { for (const guard of pending.guards) guard(); }
        catch {
          this.finishMail(pending, new Error("Full email read is no longer authorized for this source."));
          return false;
        }
        return true;
      };
      if (path === "/mail/pending") {
        if (!z.object({ protocol: z.literal(1) }).strict().safeParse(input).success)
          throw new HttpError(400, "Invalid full email pending query.");
        return { pending: [...this.mailPending.values()].filter(eligible).filter(authorize).map((pending): BrowserMailPendingHint => ({
          requestId: pending.requestId, accountId: pending.input.accountId, accountEmail: pending.input.accountEmail,
          expiresAt: pending.deadline, state: pending.bound ? "reading" : pending.lease ? "leased" : pending.wakeClient ? "waking" : "pending",
        })) };
      }
      const parsed = mailDispatch.safeParse(input);
      if (!parsed.success) throw new HttpError(400, "Invalid full email dispatch.");
      const pending = [...this.mailPending.values()].find(item => item.requestId === parsed.data.requestId);
      if (!pending) throw new HttpError(409, "Full email read is no longer pending.");
      if (!eligible(pending)) forbidden();
      if (!authorize(pending)) throw new HttpError(403, "Full email read is no longer authorized.");
      if (parsed.data.code === "wake") {
        if (pending.lease) throw new HttpError(409, "Full email read was already claimed.");
        pending.wakeClient = client;
      } else {
        if (pending.client !== client && pending.wakeClient !== client) forbidden();
        this.finishMail(pending, new Error(`Full email dispatch failed (${parsed.data.code}). No preview was substituted.`));
      }
      return { accepted: true };
    }
    const attachmentCheck = path === "/mail/attachment/authorize" || path === "/mail/attachment/status";
    const parsed = (path === "/mail/poll" ? mailPoll : attachmentCheck ? calendarLease : mailComplete).safeParse(input);
    if (!parsed.success) throw new HttpError(400, "Invalid full email payload.");
    const payload = parsed.data;
    const poll = path === "/mail/poll" ? mailPoll.parse(input) : undefined;
    validateRoutes(payload.registration);
    if (payload.registration.kind !== "mail") forbidden();
    const route = providerRoute(payload.registration.pageUrl, "mail", payload.registration.accountEmail);
    if (!/^\/mail\/u\/\d+\/$/.test(new URL(payload.registration.pageUrl).pathname)) forbidden();
    const pending = payload.requestId
      ? [...this.mailPending.values()].find(item => item.requestId === payload.requestId)
      : [...this.mailPending.values()].find(item => !item.lease && item.input.accountEmail === payload.registration.accountEmail &&
        (!poll?.wakeRequestId || item.requestId === poll.wakeRequestId) &&
        (!item.wakeClient || item.wakeClient === clientId(token)));
    if (!pending) {
      if (path === "/mail/poll" && !payload.requestId) return { job: null };
      throw new HttpError(409, "Full email read is no longer pending.");
    }
    if (pending.generation !== this.generation || pending.deadline <= Date.now()) {
      this.finishMail(pending, new Error("Full email read expired."));
      throw new HttpError(409, "Full email read expired.");
    }
    if (pending.input.accountEmail !== payload.registration.accountEmail) forbidden();
    if (poll?.wakeRequestId && (payload.requestId || pending.wakeClient !== clientId(token))) forbidden();
    if (payload.requestId) {
      if (pending.client !== clientId(token) || pending.lease !== payload.lease || pending.route !== route) forbidden();
      if (poll) {
        if (poll.rowProof) {
          if (pending.input.inboxRefresh || !pending.bound || pending.rowProof || poll.tabId !== pending.tabId || poll.documentId !== pending.documentId ||
            poll.sourceTabId !== undefined || poll.sourceDocumentId !== undefined ||
            poll.rowProof.threadId !== pending.input.threadId || poll.rowProof.inboxUrl !== poll.registration.pageUrl ||
            poll.registration.pageUrl !== pending.boundPageUrl ||
            new URL(poll.registration.pageUrl).hash !== "#inbox" ||
            (poll.rowProof.targetUrl && !this.mailConversationRoute(poll.rowProof.inboxUrl, poll.rowProof.targetUrl))) forbidden();
        } else if (pending.bound || poll.sourceTabId !== pending.tabId || poll.sourceDocumentId !== pending.documentId ||
          poll.tabId === pending.tabId || !["#inbox", `#all/${pending.input.threadId}`].includes(new URL(poll.registration.pageUrl).hash)) forbidden();
      } else if (pending.tabId !== payload.tabId || pending.documentId !== payload.documentId) forbidden();
    } else if (payload.lease || poll?.sourceTabId !== undefined || poll?.sourceDocumentId !== undefined || poll?.rowProof) forbidden();
    try {
      for (const guard of pending.guards) guard();
      const current = access.parse(await this.options.onDiscover(payload.registration));
      // The source guard, not an AI grant or automatic-sync preference, authorizes this local read.
      if (current.accountId !== pending.input.accountId) throw new Error("Account changed.");
      for (const guard of pending.guards) guard();
    } catch {
      this.finishMail(pending, new Error("Full email read is no longer authorized for this source."));
      throw new HttpError(403, "Full email read is no longer authorized.");
    }
    if (![...this.mailPending.values()].includes(pending) || pending.generation !== this.generation ||
      !this.tokens().includes(token) || pending.deadline <= Date.now()) forbidden();
    if (poll) {
      if (poll.rowProof) {
        if (pending.rowProof) forbidden();
        pending.rowProof = poll.rowProof;
        return { authorized: true };
      }
      if (!payload.requestId && pending.lease) return { job: null };
      if (payload.requestId && pending.bound) forbidden();
      pending.client = clientId(token);
      pending.lease ??= randomBytes(32).toString("hex");
      pending.tabId = payload.tabId;
      pending.documentId = payload.documentId;
      pending.route = route;
      pending.bound = Boolean(payload.requestId);
      if (pending.bound) pending.boundPageUrl = payload.registration.pageUrl;
      return { job: { protocol: 1, requestId: pending.requestId, lease: pending.lease,
        input: pending.input, expiresAt: pending.deadline } };
    }
    if (attachmentCheck) {
      if (!pending.bound || !pending.rowProof || !pending.input.attachment || !pending.input.messageProviderId
        || (path === "/mail/attachment/authorize" ? pending.attachmentAuthorized : !pending.attachmentAuthorized)
        || !this.mailConversationRoute(pending.rowProof.inboxUrl, payload.registration.pageUrl)
        || (pending.rowProof.targetUrl && pending.rowProof.targetUrl !== payload.registration.pageUrl)) forbidden();
      pending.attachmentAuthorized = true;
      return { authorized: true };
    }
    const completed = mailComplete.parse(input);
    if (completed.code !== "complete") {
      if (completed.capture) throw new HttpError(400, "Failed reads cannot contain messages.");
      const counts = completed.diagnostics;
      this.finishMail(pending, new Error(`${pending.input.inboxRefresh ? "Native inbox refresh" : "Full email read"} failed (${completed.code}). No preview was substituted.${counts
        ? ` Diagnostic counts: containers=${counts.containers}, bodies=${counts.bodies}, senders=${counts.senders}, threadMarkers=${counts.threadMarkers}, rows=${counts.rows ?? 0}, matchingRows=${counts.matchingRows ?? 0}.${pending.input.inboxRefresh
          ? ` Refresh mutations=${counts.refreshMutations ?? 0}, quietMs=${counts.refreshQuietMs ?? 0}, busy=${counts.refreshBusy ?? 0}, extractedRows=${counts.extractedRows ?? 0}.` : ""}` : ""}`));
      return { accepted: true };
    }
    const result = completed.capture;
    if (pending.input.inboxRefresh) {
      if (!pending.bound || pending.rowProof || !result || result.kind !== "mail"
        || result.accountEmail !== pending.input.accountEmail || result.pageUrl !== payload.registration.pageUrl
        || result.pageUrl !== pending.boundPageUrl || new URL(result.pageUrl).hash !== "#inbox"
        || result.meetings.length || result.attachmentDownload
        || result.messages.some(message => message.completeness !== "preview")
        || new Set(result.messages.map(message => message.id)).size !== result.messages.length)
        throw new HttpError(400, "Inbox refresh result does not match the leased inbox.");
      validateRoutes(result);
      this.finishMail(pending, result);
      return { accepted: true };
    }
    if (!pending.bound || !result || result.kind !== "mail" || result.accountEmail !== pending.input.accountEmail ||
      result.pageUrl !== payload.registration.pageUrl || !result.messages.length ||
      (pending.rowProof ? !this.mailConversationRoute(pending.rowProof.inboxUrl, result.pageUrl) ||
        (pending.rowProof.targetUrl !== undefined && pending.rowProof.targetUrl !== result.pageUrl)
        : pending.boundPageUrl !== result.pageUrl || new URL(result.pageUrl).hash !== `#all/${pending.input.threadId}`) ||
      new Set(result.messages.map(message => message.id)).size !== result.messages.length ||
      result.messages.some(message => message.threadId !== pending.input.threadId || message.completeness !== "full" ||
        message.id.startsWith("thread:") || !message.html?.trim() || (!message.body.trim() && !/<img\b/i.test(message.html)) ||
        message.url !== result.pageUrl) ||
      (pending.input.messageProviderId && !pending.input.messageProviderId.startsWith("thread:") &&
        !result.messages.some(message => message.id === pending.input.messageProviderId)))
      throw new HttpError(400, "Full email result does not match the requested conversation.");
    validateRoutes(result);
    const requested = pending.input.attachment, downloaded = result.attachmentDownload;
    if (requested) {
      const message = result.messages.find(item => item.id === pending.input.messageProviderId);
      const metadata = message?.attachments?.find(item => item.id === requested.metadataId);
      if (!pending.attachmentAuthorized || !downloaded || !metadata || metadata.name !== requested.name
        || downloaded.metadataId !== requested.metadataId || downloaded.name !== requested.name
        || downloaded.relativePath !== requested.relativePath || downloaded.bytes > requested.maxBytes)
        throw new HttpError(400, "Attachment download does not match the authorized metadata and owned path.");
    } else if (downloaded) throw new HttpError(400, "This read did not authorize an attachment download.");
    this.finishMail(pending, result);
    return { accepted: true };
  }
  private mailConversationRoute(inboxUrl: string, conversationUrl: string): boolean {
    const inbox = new URL(inboxUrl), conversation = new URL(conversationUrl);
    return !conversation.username && !conversation.password && inbox.origin === conversation.origin && inbox.pathname === conversation.pathname &&
      inbox.search === conversation.search && /^#(?:inbox|all)\/[A-Za-z0-9_-]{1,512}$/.test(conversation.hash);
  }
  /** Only call with the exact persisted preview after explicit user confirmation. Never retries. */
  async moveCalendarEvent(input: BrowserCalendarMove, beforeWrite: () => void): Promise<BrowserCalendarResult> {
    const move = calendarMove.parse(input);
    const requestId = randomBytes(16).toString("hex");
    if (this.calendarPending) return this.calendarResult(requestId, "busy");
    if (Date.parse(move.expiresAt) <= Date.now()) return this.calendarResult(requestId, "expired");
    if (!this.server?.listening || !this.tokens().length || this.refreshSettings().paused)
      return this.calendarResult(requestId, "unavailable");
    try { beforeWrite(); } catch { return this.calendarResult(requestId, "authorization-denied"); }
    const deadline = Math.min(Date.parse(move.expiresAt), Date.now() + 90_000);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finishCalendar(this.calendarPending?.authorized ? "save-unverified" : "expired"), deadline - Date.now());
      this.calendarPending = { requestId, move, beforeWrite, generation: this.generation, deadline, timer, resolve, authorized: false };
    });
  }
  private calendarResult(requestId: string, code: BrowserCalendarResultCode, authorized = false): BrowserCalendarResult {
    return { requestId, code, status: code === "saved" ? "saved" :
      authorized || code === "save-unverified" || code === "notification-confirmation" ? "uncertain" : "needs-user",
    message: calendarMessages[code] };
  }
  private finishCalendar(code: BrowserCalendarResultCode): void {
    const pending = this.calendarPending;
    if (!pending) return;
    this.calendarPending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(this.calendarResult(pending.requestId, code, pending.authorized));
  }
  private async calendarRequest(path: string, input: unknown, token: string): Promise<unknown> {
    const schema = path === "/calendar/poll" ? calendarPoll : path === "/calendar/authorize" ? calendarLease : calendarComplete;
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "Invalid calendar payload.");
    const payload = parsed.data;
    validateRoutes(payload.registration);
    if (payload.registration.kind !== "calendar") forbidden();
    if (path === "/calendar/poll") {
      const id = clientId(token);
      const firstSeen = !this.calendarCapabilities.has(id);
      this.calendarCapabilities.set(id, { protocol: 1, lastSeenAt: new Date().toISOString() });
      if (firstSeen) this.options.changed();
    }
    const pending = this.calendarPending;
    if (!pending) {
      if (path === "/calendar/poll") return { job: null };
      throw new HttpError(409, "Calendar action is no longer pending.");
    }
    if (pending.generation !== this.generation || pending.deadline <= Date.now()) {
      this.finishCalendar(pending.authorized ? "save-unverified" : "expired");
      throw new HttpError(409, "Calendar action expired.");
    }
    if (pending.move.accountEmail.toLowerCase() !== payload.registration.accountEmail) {
      if (path === "/calendar/poll") return { job: null };
      forbidden();
    }
    if (path !== "/calendar/poll") {
      const { code: _code, ...leaseInput } = payload as Record<string, unknown>;
      const bound = calendarLease.parse(leaseInput);
      if (pending.client !== clientId(token) || pending.lease !== bound.lease || pending.requestId !== bound.requestId ||
          pending.tabId !== bound.tabId || pending.documentId !== bound.documentId ||
          pending.route !== providerRoute(bound.registration.pageUrl, "calendar", bound.registration.accountEmail)) forbidden();
    } else if (pending.lease) return { job: null };
    if (path === "/calendar/complete") {
      const completed = calendarComplete.parse(input);
      if (completed.code === "saved" && !pending.authorized) forbidden();
      this.finishCalendar(completed.code);
      return { accepted: true };
    }
    let currentAccess;
    try {
      currentAccess = access.parse(await this.options.onDiscover(payload.registration));
      if (!currentAccess.enabled || currentAccess.accountId !== pending.move.accountId || this.refreshSettings().paused)
        throw new Error("Not enabled.");
      pending.beforeWrite();
    } catch {
      this.finishCalendar(pending.authorized ? "save-unverified" : "authorization-denied");
      throw new HttpError(403, "Calendar action is no longer authorized.");
    }
    if (this.calendarPending !== pending || pending.generation !== this.generation || !this.tokens().includes(token) ||
        pending.deadline <= Date.now()) forbidden();
    if (path === "/calendar/poll") {
      // Recheck after the asynchronous source validation: two browsers may poll concurrently.
      if (pending.lease) return { job: null };
      pending.client = clientId(token);
      pending.lease = randomBytes(32).toString("hex");
      pending.tabId = payload.tabId;
      pending.documentId = payload.documentId;
      pending.route = providerRoute(payload.registration.pageUrl, "calendar", payload.registration.accountEmail);
      return { job: { protocol: 1, requestId: pending.requestId, lease: pending.lease, move: pending.move } };
    }
    if (pending.authorized) throw new HttpError(409, "Calendar authorization was already consumed.");
    pending.authorized = true;
    return { authorized: true, requestId: pending.requestId, expiresAt: Math.min(Date.now() + 1500, pending.deadline) };
  }
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.server?.listening) return;
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 10;
    server.on("connection", socket => {
      if (this.sockets.size >= 32) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.setTimeout(10_000, () => socket.destroy());
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    this.starting = new Promise<void>((resolve, reject) => {
      server.once("error", () => {
        this.error = "Browser bridge could not listen.";
        reject(new Error(this.error));
      });
      server.listen(this.configuredPort, "127.0.0.1", () => { this.error = undefined; resolve(); });
    });
    try { await this.starting; this.writeBootstrap(); this.options.changed(); }
    finally { this.starting = undefined; }
  }
  async pair(): Promise<BrowserPairing> {
    if (this.tokens().length >= MAX_CLIENTS) throw new Error(CLIENT_LIMIT_ERROR);
    const generation = this.generation;
    await this.start();
    if (generation !== this.generation) throw new Error("Browser pairing was interrupted.");
    const expires = Date.now() + 120_000;
    const code = randomInt(1_000_000).toString().padStart(6, "0");
    this.pendingCode = { code, expires, attempts: 0 };
    if (this.vault.get<unknown>("secrets", AUTO_PAIR_OFF_ID) === true) {
      this.vault.delete("secrets", AUTO_PAIR_OFF_ID);
      this.writeBootstrap();
    }
    return { code, expiresAt: new Date(expires).toISOString(), port: this.status().port };
  }
  async revoke(): Promise<void> {
    this.cancelMail("Full email read cancelled: browser pairing was revoked.");
    this.finishCalendar(this.calendarPending?.authorized ? "save-unverified" : "authorization-denied");
    this.calendarCapabilities.clear();
    this.generation++;
    this.pendingCode = undefined;
    this.lastCapture = undefined;
    this.refreshRequestedAt = 0;
    this.vault.delete("secrets", SECRET_ID);
    this.vault.delete("secrets", CLIENT_META_ID);
    // An explicit revoke must not be undone by automatic pairing; a new pairing code re-enables it.
    if (this.options.bootstrapFile) this.vault.put("secrets", AUTO_PAIR_OFF_ID, true);
    this.removeBootstrap();
    for (const socket of this.sockets) socket.destroy();
    this.options.changed();
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.cancelMail("Full email read cancelled: browser bridge stopped.");
    this.finishCalendar(this.calendarPending?.authorized ? "save-unverified" : "unavailable");
    this.calendarCapabilities.clear();
    this.generation++;
    this.pendingCode = undefined;
    this.removeBootstrap();
    this.stopping = (async () => {
      if (this.starting) await this.starting.catch(() => undefined);
      const server = this.server;
      this.server = undefined;
      if (!server) return;
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING"))
            reject(new Error("Browser bridge could not stop."));
          else resolve();
        });
      });
      for (const socket of this.sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
      this.options.changed();
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private consumeBudget(): void {
    const now = Date.now();
    this.budget = Math.min(120, this.budget + Math.max(0, now - this.budgetTime) / 500);
    this.budgetTime = now;
    if (this.budget < 1) throw new HttpError(429, "Too many requests.");
    this.budget--;
  }
  private authorize(request: IncomingMessage): string {
    const tokens = this.tokens();
    let authorized = 0;
    let matched = "";
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const token = tokens[index] ?? "0".repeat(64);
      const ok = Number(equal(request.headers.authorization ?? "", `Bearer ${token}`)) & Number(index < tokens.length);
      authorized |= ok;
      if (ok) matched = token;
    }
    if (!authorized || !matched) throw new HttpError(401, "Unauthorized.");
    const now = new Date().toISOString();
    this.updateClientMeta(matched, current => ({
      ...current,
      browser: browserKind(request.headers["user-agent"]),
      lastSeenAt: now,
    }));
    return matched;
  }
  private discard(request: IncomingMessage): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        request.off("end", finish); request.off("error", finish); request.off("aborted", finish);
        request.pause();
        resolve();
      };
      const timer = setTimeout(finish, 100);
      request.once("end", finish); request.once("error", finish); request.once("aborted", finish);
      request.resume();
    });
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
      await this.discard(request);
      throw new HttpError(413, "Payload too large.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        request.off("data", data); request.off("end", end);
        request.off("error", fail); request.off("aborted", aborted);
      };
      const fail = () => { cleanup(); reject(new HttpError(400, "Invalid request.")); };
      const aborted = () => fail();
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          cleanup();
          void this.discard(request).then(() => reject(new HttpError(413, "Payload too large.")));
        } else chunks.push(chunk);
      };
      const end = () => {
        cleanup();
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve(JSON.parse(decoded) as unknown);
        } catch { reject(new HttpError(400, "Invalid JSON.")); }
      };
      request.on("data", data); request.once("end", end);
      request.once("error", fail); request.once("aborted", aborted);
    });
  }
  private reply(response: ServerResponse, status: number, payload?: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", Connection: "close",
    });
    response.end(payload === undefined ? undefined : JSON.stringify(payload));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const generation = this.generation;
    let counted = false;
    try {
      this.consumeBudget();
      const port = this.status().port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? "") ||
          request.headers.origin !== this.origin) forbidden();
      for (const name of ["host", "origin", "authorization", "content-type"]) {
        if (request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === name).length > 1)
          forbidden();
      }
      response.setHeader("Access-Control-Allow-Origin", this.origin);
      response.setHeader("Vary", "Origin");
      if (!["/pair", "/discover", "/capture", "/calendar/poll", "/calendar/authorize", "/calendar/complete", "/mail/pending", "/mail/dispatch", "/mail/poll", "/mail/complete", "/mail/attachment/authorize", "/mail/attachment/status"].includes(request.url ?? ""))
        throw new HttpError(404, "Not found.");
      if (request.method === "OPTIONS") {
        if (request.headers["access-control-request-method"] !== "POST") forbidden();
        const headers = String(request.headers["access-control-request-headers"] ?? "")
          .toLowerCase().split(",").map(header => header.trim()).filter(Boolean);
        if (headers.some(header => !["authorization", "content-type"].includes(header))) forbidden();
        response.setHeader("Access-Control-Allow-Methods", "POST");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        if (request.headers["access-control-request-private-network"] === "true")
          response.setHeader("Access-Control-Allow-Private-Network", "true");
        this.reply(response, 204);
        return;
      }
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
          request.headers["content-encoding"]) throw new HttpError(415, "JSON required.");
      if (this.active >= 8) throw new HttpError(429, "Too many requests.");
      this.active++;
      counted = true;
      const pairing = request.url === "/pair";
      let token = "";
      if (!pairing) token = this.authorize(request);
      const input = await this.body(request);
      if (generation !== this.generation || response.destroyed) forbidden();
      if (pairing) {
        const automatic = z.object({ bootstrap: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(input);
        if (automatic.success) {
          if (!this.bootstrap || !equal(this.bootstrap, automatic.data.bootstrap))
            throw new HttpError(403, "Automatic pairing is unavailable. Generate a pairing code in Relay Desk and enter it here.");
          this.issueToken(request, response, true);
          return;
        }
        const pending = this.pendingCode;
        if (!pending) throw new HttpError(403, "No active pairing code. Generate a fresh code in Relay Desk, then enter it here.");
        if (pending.expires <= Date.now()) throw new HttpError(403, "Pairing code expired. Generate a fresh code in Relay Desk and enter it within two minutes.");
        if (pending.attempts >= 5) throw new HttpError(403, "Too many pairing attempts. Generate a fresh code in Relay Desk.");
        pending.attempts++;
        const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().safeParse(input);
        if (!pending || pending !== this.pendingCode)
          throw new HttpError(403, "Pairing code was replaced or already used. Generate a fresh code in Relay Desk.");
        if (pending.expires <= Date.now())
          throw new HttpError(403, "Pairing code expired. Generate a fresh code in Relay Desk and enter it within two minutes.");
        if (!parsed.success || !equal(pending.code, parsed.data.code))
          throw new HttpError(403, "Pairing code does not match. Enter the latest six-digit code shown in Relay Desk.");
        if (this.tokens().length >= MAX_CLIENTS) throw new HttpError(409, CLIENT_LIMIT_ERROR);
        this.pendingCode = undefined;
        this.issueToken(request, response, false);
        return;
      }
      this.authorize(request);
      if (request.url?.startsWith("/mail/")) {
        const result = await this.mailRequest(request.url, input, token);
        if (generation !== this.generation || response.destroyed) forbidden();
        this.authorize(request);
        this.reply(response, 200, result);
        return;
      }
      if (request.url?.startsWith("/calendar/")) {
        const result = await this.calendarRequest(request.url, input, token);
        if (generation !== this.generation || response.destroyed) forbidden();
        this.authorize(request);
        this.reply(response, 200, result);
        return;
      }
      const parsed = (request.url === "/discover" ? registration : capture).safeParse(input);
      if (!parsed.success) throw new HttpError(400, "Invalid payload.");
      validateRoutes(parsed.data);
      let result: BrowserAccess | { accepted: true };
      try {
        if (request.url === "/discover") {
          const discovered = access.parse(await this.options.onDiscover(parsed.data));
          this.updateClientMeta(token, current => ({
            ...current,
            browser: browserKind(request.headers["user-agent"]),
            lastSeenAt: new Date().toISOString(),
            discoveredAccountIds: [...new Set([...(current.discoveredAccountIds ?? []), discovered.accountId])].slice(0, 64),
          }));
          const settings = this.refreshSettings();
          result = {
            ...discovered,
            refreshIntervalSeconds: settings.intervalSeconds,
            backgroundCapture: settings.backgroundCapture,
            ...(!settings.paused && this.refreshRequestedAt > 0 ? { refreshRequestedAt: this.refreshRequestedAt } : {}),
          };
        } else {
          await this.options.onCapture(capture.parse(parsed.data));
          result = { accepted: true };
        }
      } catch (error) {
        if (error instanceof Error && safeCallbackErrors.has(error.message)) throw new HttpError(403, error.message);
        throw new HttpError(409, "Browser request could not be completed.");
      }
      if (generation !== this.generation || response.destroyed) forbidden();
      this.authorize(request);
      if (request.url === "/capture") {
        this.lastCapture = new Date().toISOString();
        this.options.changed();
      }
      this.reply(response, 200, result);
    } catch (error) {
      this.reply(response, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : "Browser request failed." });
    } finally {
      if (counted) this.active--;
    }
  }
}
