import { createHash } from "node:crypto";
import { z } from "zod";
import type { Account, Attachment, Message, Source } from "../../shared/contracts";
import { emptyPage, hash, id, type Fetch, type OnPage, type Page, type Vault } from "./core";

export const GMAIL_RELAY_PROVIDER_ID = "__apps_script_relay__";
const GMAIL_RELAY_SECRET_PREFIX = "gmail-relay:";
export const GMAIL_RELAY_STATUS_PREFIX = "gmail-relay-status:";
const MAX_FILE_CHUNK = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
// Apps Script web apps can take minutes while the mailbox export trigger is busy with Drive; 60 s caused repeated aborts.
const REQUEST_TIMEOUT_MS = 180_000;
const now = () => new Date().toISOString();
const normalizeEmail = (value: string) => value.trim().toLowerCase();

export interface GmailRelaySecret { url: string; token: string; mailbox: string; pollIntervalMinutes: number }
export interface GmailRelayState {
  sourceId: string;
  mailbox: string;
  cursor: number;
  imported: number;
  lastSyncAt?: string;
  lastStatusAt?: string;
  lastError?: string;
  stopped?: boolean;
  exportStatus?: string;
  phase?: string;
  latestSeq?: number;
  tokenExpiresAt?: string | null;
  tokenIsPrevious?: boolean;
  updatedAt?: string;
}
export interface GmailRelayPublicStatus extends Omit<GmailRelayState, "stopped"> {
  accountId: string;
  pollIntervalMinutes: number;
  configured: boolean;
  stopped: boolean;
}

const relayStatusSchema = z.object({
  ok: z.boolean(), schemaVersion: z.literal(1).optional(), mailbox: z.string().email().optional(),
  status: z.string().optional(), continuous: z.boolean().optional(), phase: z.string().optional(),
  lastSyncAt: z.string().nullable().optional(), updatedAt: z.string().nullable().optional(), lastError: z.string().nullable().optional(),
  latestSeq: z.number().int().nonnegative().optional(), tokenExpiresAt: z.string().nullable().optional(), tokenIsPrevious: z.boolean().optional(),
  error: z.string().optional()
}).passthrough();
const headerSchema = z.object({ name: z.string(), value: z.string() }).passthrough();
const partSchema = z.object({
  mimePath: z.string().optional(), partId: z.string().optional(), kind: z.enum(["body", "attachment"]),
  originalFilename: z.string().optional(), filename: z.string().optional(), relativePath: z.string().optional(),
  mimeType: z.string().optional(), headers: z.array(headerSchema).optional(), contentId: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(), gmailReportedSizeBytes: z.number().int().nonnegative().optional(),
  sizeMatchesGmail: z.boolean().optional(), driveFileId: z.string().min(1).optional()
}).passthrough();
const manifestSchema = z.object({
  schemaVersion: z.number().int(), status: z.literal("complete"), gmailMessageId: z.string().min(1), gmailThreadId: z.string().min(1),
  mailbox: z.string().email(), internalDateMs: z.number().int().nonnegative(), receivedAt: z.string().optional(),
  headers: z.array(headerSchema).optional(), labelIds: z.array(z.string()).optional(), historyId: z.union([z.string(), z.number()]).optional(),
  sizeEstimate: z.number().int().nonnegative().optional(), raw: z.object({ filename: z.string(), driveFileId: z.string().min(1), sizeBytes: z.number().int().nonnegative() }),
  parts: z.array(partSchema).optional(), mimeStructure: z.unknown().optional()
}).passthrough();
const changesSchema = z.object({
  ok: z.boolean(), mailbox: z.string().email().optional(), entries: z.array(z.object({
    seq: z.number().int().nonnegative(), gmailMessageId: z.string().min(1), gmailThreadId: z.string().min(1), internalDateMs: z.number().int().nonnegative().optional(),
    messageFolderId: z.string().optional(), manifestFileId: z.string().optional(), journaledAt: z.string().optional(), manifest: manifestSchema
  }).passthrough()).optional(), nextAfter: z.number().int().nonnegative().optional(), latestSeq: z.number().int().nonnegative().optional(), hasMore: z.boolean().optional(), error: z.string().optional()
}).passthrough();
const fileSchema = z.object({
  ok: z.boolean(), fileId: z.string().optional(), name: z.string().optional(), mimeType: z.string().optional(),
  totalSize: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(), error: z.string().optional()
}).passthrough();

type RelayStatusResponse = z.infer<typeof relayStatusSchema>;
type Manifest = z.infer<typeof manifestSchema>;

function safeRelayError(error: unknown): string {
  return (error instanceof Error ? error.message : "Gmail Apps Script relay failed.").replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 1000);
}
export function validateGmailRelayUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || url.username || url.password || url.port) throw new Error("Use an HTTPS Apps Script web app URL on script.google.com.");
  if (!/^\/(?:macros\/s\/[^/]+\/exec|a\/macros\/[^/]+\/s\/[^/]+\/exec)$/.test(url.pathname)) throw new Error("Use the Apps Script web app /macros/.../s/.../exec URL.");
  url.hash = "";
  return url.href;
}
function validateRedirect(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["script.google.com", "script.googleusercontent.com"].includes(url.hostname)) throw new Error("Untrusted Apps Script redirect target rejected.");
  return url;
}
async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_JSON_BYTES) throw new Error("Apps Script relay response exceeded the local safety limit.");
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class GmailRelayTransport {
  constructor(private readonly webAppUrl: string, private readonly token: string, private readonly fetcher: Fetch = globalThis.fetch,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
    })) {
    validateGmailRelayUrl(webAppUrl);
    if (!token.trim()) throw new Error("Paste the Apps Script relay token.");
  }
  private async post(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let url = new URL(validateGmailRelayUrl(this.webAppUrl));
    let init: RequestInit = { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: this.token, action, ...body }) };
    for (let redirect = 0; redirect < 5; redirect++) {
      signal?.throwIfAborted();
      const response = await this.fetcher(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Apps Script relay redirected without a target.");
        url = validateRedirect(location);
        init = { method: response.status === 307 || response.status === 308 ? init.method : "GET", redirect: "manual", headers: { "Content-Type": "application/json" }, body: response.status === 307 || response.status === 308 ? init.body : undefined };
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("Apps Script relay returned an unexpected HTTP status."); }
      const text = await responseText(response);
      try { return JSON.parse(text) as unknown; } catch {
        throw new Error(/^\s*<(?:!doctype|html)/i.test(text)
          ? "Apps Script returned a Google error page instead of data (usually busy while its export runs, or a quota limit). Relay Desk will retry."
          : "Apps Script relay returned invalid JSON.");
      }
    }
    throw new Error("Apps Script relay redirected too many times.");
  }
  async request(action: "status", body?: Record<string, unknown>, signal?: AbortSignal): Promise<RelayStatusResponse>;
  async request(action: "changes", body: Record<string, unknown>, signal?: AbortSignal): Promise<z.infer<typeof changesSchema>>;
  async request(action: "file", body: Record<string, unknown>, signal?: AbortSignal): Promise<z.infer<typeof fileSchema>>;
  async request(action: "status" | "changes" | "file", body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.post(action, body, signal);
        const parsed = action === "status" ? relayStatusSchema.parse(raw) : action === "changes" ? changesSchema.parse(raw) : fileSchema.parse(raw);
        if (!parsed.ok) throw new Error(parsed.error || "Apps Script relay rejected the request.");
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : "network_error";
        if (/redirect|Untrusted|Apps Script web app URL|script\.google\.com/i.test(message)) throw error;
        if (/Unauthorized|expired|Token expired|revoked/i.test(message)) throw error;
        if (signal?.aborted) throw signal.reason;
        if (attempt >= 3) throw error;
        await this.wait(Math.min(8000, 400 * 2 ** attempt), signal);
      }
    }
  }
  async downloadFile(fileId: string, expectedSize?: number, signal?: AbortSignal): Promise<Buffer> {
    if (!fileId.trim()) throw new Error("Missing relay Drive file identifier.");
    const chunks: Buffer[] = [];
    let offset = 0;
    let totalSize: number | undefined;
    for (;;) {
      const file = await this.request("file", { fileId, offset, length: MAX_FILE_CHUNK }, signal);
      if (file.fileId && file.fileId !== fileId) throw new Error("Apps Script relay returned a different file.");
      if (typeof file.totalSize !== "number" || typeof file.offset !== "number" || typeof file.length !== "number" || typeof file.dataBase64 !== "string") throw new Error("Apps Script relay file response is incomplete.");
      if (file.offset !== offset) throw new Error("Apps Script relay returned an unexpected file offset.");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) throw new Error("Apps Script relay returned invalid file encoding.");
      const bytes = Buffer.from(file.dataBase64, "base64");
      if (bytes.length !== file.length) throw new Error("Apps Script relay file chunk size mismatch.");
      totalSize ??= file.totalSize;
      if (file.totalSize !== totalSize) throw new Error("Apps Script relay file size changed during download.");
      chunks.push(bytes); offset += bytes.length;
      if (offset >= totalSize) break;
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length !== totalSize || expectedSize !== undefined && buffer.length !== expectedSize) throw new Error("Apps Script relay downloaded file size did not match the manifest.");
    return buffer;
  }
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      const bytes = enc.toLowerCase() === "b" ? Buffer.from(data, "base64") : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), "binary");
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch { return data; }
  });
}
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let current = "";
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && current) headers[current] += " " + line.trim();
    else {
      const idx = line.indexOf(":");
      if (idx > 0) { current = line.slice(0, idx).toLowerCase(); headers[current] = line.slice(idx + 1).trim(); }
    }
  }
  for (const key of Object.keys(headers)) headers[key] = decodeHeader(headers[key]);
  return headers;
}
function headerParam(value: string, name: string): string | undefined {
  const match = new RegExp(`${name}=\\"?([^\\";]+)`, "i").exec(value);
  return match?.[1];
}
function qp(input: string): Buffer {
  const normalized = input.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(normalized, "binary");
}
function decodeBody(body: string, headers: Record<string, string>): string {
  const transfer = (headers["content-transfer-encoding"] || "").toLowerCase();
  const bytes = transfer === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : transfer === "quoted-printable" ? qp(body) : Buffer.from(body, "utf8");
  const charset = headerParam(headers["content-type"] || "", "charset") || "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString("utf8"); }
}
function stripHtml(html: string): string { return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?|<\/(?:p|div|tr)>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
function parseRelayEml(raw: Buffer): { headers: Record<string, string>; text: string; html: string } {
  const content = raw.toString("binary");
  const split = /\r?\n\r?\n/.exec(content);
  const head = split ? content.slice(0, split.index) : "";
  const body = split ? content.slice(split.index + split[0].length) : content;
  const headers = parseHeaders(head);
  const textParts: string[] = [], htmlParts: string[] = [];
  const walk = (partHeaders: Record<string, string>, partBody: string) => {
    const type = (partHeaders["content-type"] || "text/plain").toLowerCase();
    const boundary = headerParam(partHeaders["content-type"] || "", "boundary");
    if (type.startsWith("multipart/") && boundary) {
      for (const rawPart of partBody.split(`--${boundary}`).slice(1)) {
        if (rawPart.startsWith("--")) break;
        const clean = rawPart.replace(/^\r?\n/, "");
        const s = /\r?\n\r?\n/.exec(clean);
        if (!s) continue;
        walk(parseHeaders(clean.slice(0, s.index)), clean.slice(s.index + s[0].length));
      }
      return;
    }
    if (/attachment/i.test(partHeaders["content-disposition"] || "")) return;
    if (type.startsWith("text/plain")) textParts.push(decodeBody(partBody, partHeaders));
    else if (type.startsWith("text/html")) htmlParts.push(decodeBody(partBody, partHeaders));
  };
  walk(headers, body);
  const html = htmlParts.join("\n");
  return { headers, text: textParts.join("\n").trim() || stripHtml(html).trim(), html: html.trim() };
}
function attachmentRecord(account: Account, message: Message, part: z.infer<typeof partSchema>): Attachment | undefined {
  if (part.kind !== "attachment" || !part.driveFileId) return undefined;
  const providerId = JSON.stringify({ relayFileId: part.driveFileId, gmailMessageId: message.providerId, sizeBytes: part.sizeBytes });
  return { id: id(account.id, "attachment", providerId), accountId: account.id, messageId: message.id, providerId,
    name: part.originalFilename || part.filename || "attachment", mimeType: part.mimeType || "application/octet-stream", size: part.sizeBytes,
    status: "pending" };
}
function relayMessage(account: Account, source: Source, manifest: Manifest, raw: Buffer): { message: Message; attachments: Attachment[] } {
  const parsed = parseRelayEml(raw);
  const h = (name: string) => parsed.headers[name.toLowerCase()] || manifest.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value || "";
  const providerId = manifest.gmailMessageId;
  const revision = hash(JSON.stringify([manifest.historyId, manifest.raw.driveFileId, manifest.parts?.map(part => [part.driveFileId, part.sizeBytes]), createHash("sha256").update(raw).digest("hex")]));
  const message: Message = { id: id(account.id, "message", providerId), accountId: account.id, sourceId: source.id, providerId,
    threadId: id(account.id, "thread", manifest.gmailThreadId), subject: h("Subject"), sender: h("From"),
    recipients: [h("To"), h("Cc")].flatMap(value => value.split(",").map(item => item.trim()).filter(Boolean)),
    body: parsed.text, html: parsed.html || undefined, receivedAt: new Date(manifest.internalDateMs).toISOString(),
    url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#all/${encodeURIComponent(manifest.gmailThreadId)}`,
    unread: (manifest.labelIds ?? []).includes("UNREAD"), revision, historical: false };
  return { message, attachments: (manifest.parts ?? []).map(part => attachmentRecord(account, message, part)).filter((value): value is Attachment => !!value) };
}

export class GmailRelayConnector {
  constructor(private readonly vault: Vault, private readonly fetcher: Fetch = globalThis.fetch) {}
  secretId(sourceId: string): string { return `${GMAIL_RELAY_SECRET_PREFIX}${sourceId}`; }
  stateId(sourceId: string): string { return `${GMAIL_RELAY_STATUS_PREFIX}${sourceId}`; }
  transport(secret: GmailRelaySecret): GmailRelayTransport { return new GmailRelayTransport(secret.url, secret.token, this.fetcher); }
  publicStatuses(): GmailRelayPublicStatus[] {
    return this.vault.all<Source>("sources").filter(source => source.providerId === GMAIL_RELAY_PROVIDER_ID).map(source => {
      const secret = this.vault.get<GmailRelaySecret>("secrets", this.secretId(source.id));
      const state = this.vault.get<GmailRelayState>("checkpoints", this.stateId(source.id));
      return { sourceId: source.id, accountId: source.accountId, mailbox: state?.mailbox || secret?.mailbox || "", cursor: state?.cursor ?? 0,
        imported: state?.imported ?? 0, lastSyncAt: state?.lastSyncAt, lastStatusAt: state?.lastStatusAt, lastError: state?.lastError,
        exportStatus: state?.exportStatus, phase: state?.phase, latestSeq: state?.latestSeq, tokenExpiresAt: state?.tokenExpiresAt ?? undefined,
        tokenIsPrevious: state?.tokenIsPrevious, updatedAt: state?.updatedAt, pollIntervalMinutes: secret?.pollIntervalMinutes ?? 5,
        configured: !!secret, stopped: !!state?.stopped };
    });
  }
  async status(secret: GmailRelaySecret, signal?: AbortSignal): Promise<RelayStatusResponse> { return this.transport(secret).request("status", {}, signal); }
  async sync(account: Account, source: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    if (source.providerId !== GMAIL_RELAY_PROVIDER_ID || source.kind !== "mail") throw new Error("Unsupported Gmail relay source.");
    const secret = this.vault.get<GmailRelaySecret>("secrets", this.secretId(source.id));
    if (!secret) throw new Error("Configure the Gmail Apps Script relay token in Settings.");
    if (normalizeEmail(account.email) !== normalizeEmail(secret.mailbox)) throw new Error("Gmail relay account binding no longer matches the configured mailbox.");
    const stateId = this.stateId(source.id);
    let state = this.vault.get<GmailRelayState>("checkpoints", stateId) ?? { sourceId: source.id, mailbox: secret.mailbox, cursor: 0, imported: 0 };
    if (state.stopped) throw new Error(state.lastError || "Gmail Apps Script relay is stopped. Replace the token or reconnect it.");
    const transport = this.transport(secret);
    const status = await transport.request("status", {}, signal);
    if (status.mailbox && normalizeEmail(status.mailbox) !== normalizeEmail(secret.mailbox)) {
      state = { ...state, stopped: true, lastError: "Apps Script relay mailbox changed; import stopped to protect the archive.", updatedAt: now() };
      this.vault.put("checkpoints", stateId, state);
      throw new Error(state.lastError);
    }
    state = { ...state, mailbox: secret.mailbox, lastStatusAt: now(), exportStatus: status.status, phase: status.phase, latestSeq: status.latestSeq,
      tokenExpiresAt: status.tokenExpiresAt ?? null, tokenIsPrevious: status.tokenIsPrevious, lastError: status.lastError || undefined, updatedAt: status.updatedAt || now() };
    this.vault.put("checkpoints", stateId, state);
    try { await this.importChanges(account, source, secret, transport, stateId, state, onPage, signal); }
    catch (error) {
      // Keep the failure visible on the relay card; the import resumes from the saved cursor next time.
      const current = this.vault.get<GmailRelayState>("checkpoints", stateId) ?? state;
      if (!signal?.aborted && !current.stopped)
        this.vault.put("checkpoints", stateId, { ...current, lastError: safeRelayError(error), updatedAt: now() });
      throw error;
    }
  }
  private async importChanges(account: Account, source: Source, secret: GmailRelaySecret, transport: GmailRelayTransport, stateId: string,
    state: GmailRelayState, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const changes = await transport.request("changes", { after: state.cursor, limit: 10 }, signal);
      if (changes.mailbox && normalizeEmail(changes.mailbox) !== normalizeEmail(secret.mailbox)) {
        state = { ...state, stopped: true, lastError: "Apps Script relay mailbox changed; import stopped to protect the archive.", updatedAt: now() };
        this.vault.put("checkpoints", stateId, state);
        throw new Error(state.lastError);
      }
      const page: Page = emptyPage();
      const seen = new Set<string>();
      for (const entry of changes.entries ?? []) {
        signal?.throwIfAborted();
        if (seen.has(entry.manifest.gmailMessageId)) continue;
        seen.add(entry.manifest.gmailMessageId);
        if (normalizeEmail(entry.manifest.mailbox) !== normalizeEmail(secret.mailbox)) throw new Error("Apps Script relay manifest mailbox does not match the configured account.");
        const raw = await transport.downloadFile(entry.manifest.raw.driveFileId, entry.manifest.raw.sizeBytes, signal);
        const parsed = relayMessage(account, source, entry.manifest, raw);
        page.messages.push(parsed.message);
        page.attachments.push(...parsed.attachments);
      }
      const nextAfter = changes.nextAfter ?? state.cursor;
      const nextState: GmailRelayState = { ...state, cursor: nextAfter, imported: state.imported + page.messages.length, latestSeq: changes.latestSeq ?? state.latestSeq,
        lastSyncAt: now(), updatedAt: now(), lastError: undefined };
      page.checkpoint = { id: stateId, value: nextState };
      await onPage(page);
      state = nextState;
      if (!changes.hasMore) break;
    }
  }
  async downloadAttachment(sourceId: string, attachment: Attachment, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const secret = this.vault.get<GmailRelaySecret>("secrets", this.secretId(sourceId));
    if (!secret) throw new Error("Gmail Apps Script relay credentials are unavailable.");
    const ref = JSON.parse(attachment.providerId) as { relayFileId?: string; gmailMessageId?: string; sizeBytes?: number };
    if (!ref.relayFileId || ref.gmailMessageId !== this.vault.get<Message>("messages", attachment.messageId)?.providerId) throw new Error("Gmail relay attachment provenance rejected.");
    const bytes = await this.transport(secret).downloadFile(ref.relayFileId, ref.sizeBytes ?? attachment.size, signal);
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }
}
