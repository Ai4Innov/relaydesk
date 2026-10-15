import { createHash } from "node:crypto";
import type { Account, Attachment, CalendarEvent, Collection, Message, Source } from "../../shared/contracts";

export interface Vault {
  get<T>(collection: Collection, id: string): T | undefined;
  put<T>(collection: Collection, id: string, value: T): void;
  all<T>(collection: Collection): T[];
  delete(collection: Collection, id: string): void;
}
export interface Page {
  messages: Message[];
  attachments: Attachment[];
  events: CalendarEvent[];
  checkpoint?: { id: string; value: unknown };
}
export type OnPage = (page: Page) => void | Promise<void>;
export type Fetch = typeof globalThis.fetch;
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider object");
  return value as Json;
}
export function optionalObject(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? object(value) : {}; }
export function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
export function required(value: unknown): string { const result = text(value); if (!result) throw new Error("Missing provider identifier"); return result; }
export function list(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
export function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export function id(accountId: string, kind: string, providerId: string): string { return `${accountId}:${kind}:${encodeURIComponent(providerId)}`; }
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function revision(value: Json): string { return text(value["@odata.etag"]) || text(value.etag) || text(value.changeKey) || hash(JSON.stringify(value)); }
export function emptyPage(checkpoint?: Page["checkpoint"]): Page { return { messages: [], attachments: [], events: [], checkpoint }; }
export function cancelledEvent(event: CalendarEvent, currentRevision = event.revision): CalendarEvent {
  return { ...event, title: event.title.startsWith("(Cancelled) ") ? event.title : `(Cancelled) ${event.title}`,
    writable: false, revision: currentRevision };
}
export function source(account: Account, providerId: string, name: string, kind: Source["kind"]): Source {
  return { id: id(account.id, kind, providerId), accountId: account.id, providerId, name, kind, selected: false };
}
export class ProviderError extends Error {
  constructor(public readonly status: number, public readonly code = "provider_error", hint?: string) {
    super(`Provider request failed (${status}: ${code})${hint ? `. ${hint}` : ""}`);
  }
}
export class ConflictError extends Error { constructor() { super("Provider content changed or was removed. Refresh and review before saving."); this.name = "ConflictError"; } }
export class UncertainWriteError extends Error { constructor() { super("The provider write may have succeeded. Reconcile in the provider before retrying."); } }

export function trustedUrl(input: string, base: string, attachment = false): URL {
  const url = new URL(input, base);
  const origin = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    (attachment ? url.hostname !== "files.slack.com" : url.origin !== origin.origin || !url.pathname.startsWith(origin.pathname))) {
    throw new Error("Untrusted provider URL rejected");
  }
  return url;
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export class HttpClient {
  constructor(
    readonly base: string,
    private readonly token: () => Promise<string>,
    private readonly fetcher: Fetch = globalThis.fetch,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    private readonly headers: Record<string, string> = {},
  ) {}
  async response(path: string, init: RequestInit = {}, attachment = false): Promise<Response> {
    const url = trustedUrl(path, this.base, attachment);
    const method = init.method ?? "GET";
    const read = method === "GET";
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), redirect: "error", headers: {
          ...this.headers, ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${await this.token()}`,
        } });
      } catch {
        if (init.signal?.aborted) throw init.signal.reason;
        if (!read) throw new UncertainWriteError();
        if (attempt >= 3) throw new ProviderError(0, "network_error");
        await this.wait(Math.min(8000, 400 * 2 ** attempt), init.signal ?? undefined);
        continue;
      }
      if (response.ok) return response;
      if (response.status === 412) throw new ConflictError();
      if (!read && response.status >= 500) throw new UncertainWriteError();
      if (read && (response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
        if (Number.isFinite(delay) && delay > 60000) throw new ProviderError(429, "retry_later");
        await response.body?.cancel();
        await this.wait(Math.max(0, Number.isFinite(delay) ? delay : Math.min(8000, 400 * 2 ** attempt) + Math.random() * 100), init.signal ?? undefined);
        continue;
      }
      await response.body?.cancel();
      const googleApi = url.hostname === "gmail.googleapis.com" ? "Gmail API"
        : url.hostname === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3/") ? "Google Calendar API" : undefined;
      if (googleApi && response.status === 403)
        throw new ProviderError(403, "access_denied", `${googleApi} access was denied. Enable ${googleApi} in the Google Cloud project that owns your OAuth client, grant the requested permissions, and check Workspace administrator restrictions.`);
      if (googleApi && response.status === 401)
        throw new ProviderError(401, "authentication_required", `${googleApi} rejected the authorization. Reconnect the account in Settings.`);
      throw new ProviderError(response.status);
    }
  }
  async json(path: string, init: RequestInit = {}): Promise<Json> {
    const response = await this.response(path, init);
    try { return object(await response.json()); }
    catch (error) { if (init.method && init.method !== "GET") throw new UncertainWriteError(); throw error; }
  }
  async write(path: string, method: "POST" | "PUT" | "PATCH", body: unknown, expectedRevision?: string): Promise<Json> {
    return this.json(path, { method, headers: { "Content-Type": "application/json", ...(expectedRevision ? { "If-Match": expectedRevision } : {}) }, body: JSON.stringify(body) });
  }
}
export function query(path: string, values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, value);
  return `${path}?${params}`;
}
export function ensureSelected(vault: Vault, account: Account, sourceId: string): Source {
  const value = vault.get<Source>("sources", sourceId);
  if (!value || !value.selected || value.accountId !== account.id) throw new Error("Source is not selected for this account");
  return value;
}
export function assertAccount(account: Account, ...values: { accountId: string }[]): void {
  if (account.connection === "browser") throw new Error("Browser accounts are read-only. Copy replies and make calendar changes in the original website.");
  if (account.status !== "connected" || values.some(v => v.accountId !== account.id)) throw new Error("Account boundary rejected");
}
export function textBody(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(?:div|p|br|tr)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
