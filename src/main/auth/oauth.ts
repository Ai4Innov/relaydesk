import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Provider, Settings } from "../../shared/contracts";
import { object, required, text, number, type Fetch, type Vault } from "../connectors/core";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Calendars.ReadWrite"];
export interface Credential {
  accountId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
}
export function configuration(provider: Exclude<Provider, "slack" | "whatsapp">, settings: Settings) {
  if (provider !== "gmail" && provider !== "microsoft") throw new Error("This provider does not support an OAuth connection.");
  if (provider === "gmail") {
    if (!settings.googleClientId.trim()) throw new Error("Configure a Google Desktop OAuth client ID first");
    return { clientId: settings.googleClientId.trim(), authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token", scopes: GOOGLE_SCOPES };
  }
  const tenant = settings.microsoftTenant || "common";
  if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new Error("Invalid Microsoft tenant");
  if (!settings.microsoftClientId.trim()) throw new Error("Configure a Microsoft public-client application ID first");
  return { clientId: settings.microsoftClientId.trim(), authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, scopes: MICROSOFT_SCOPES };
}
function safeEqual(a: string, b: string): boolean {
  return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function validateTokenUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !(url.href === "https://oauth2.googleapis.com/token" ||
      url.hostname === "login.microsoftonline.com" && /^\/[a-zA-Z0-9.-]+\/oauth2\/v2\.0\/token$/.test(url.pathname) && !url.search)) {
    throw new Error("Invalid token endpoint");
  }
}
async function exchange(fetcher: Fetch, tokenUrl: string, fields: Record<string, string>): Promise<Credential> {
  validateTokenUrl(tokenUrl);
  let response: Response;
  try {
    response = await fetcher(tokenUrl, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(30000) });
  } catch { throw new Error("OAuth exchange failed; reconnect the account"); }
  if (!response.ok) {
    let data: Record<string, unknown>;
    try { data = object(await response.json()); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`OAuth exchange failed (${response.status}); the token endpoint returned an unreadable error response`);
    }
    const code = text(data.error);
    let help = "Check the desktop app registration and consent, then connect again.";
    if (tokenUrl === "https://oauth2.googleapis.com/token" && !fields.client_secret &&
      (code === "invalid_request" || code === "invalid_client"))
      help = "Enter the Google desktop client secret from the same downloaded OAuth registration JSON as your client ID, then connect again.";
    else if (code === "invalid_client" || code === "unauthorized_client")
      help = "The OAuth client was rejected. Check that the client ID and registration credential belong to the same Desktop app, not a Web application.";
    else if (code === "invalid_grant")
      help = "The authorization code or refresh token was rejected or expired. Start a new connection in Relay Desk; do not reuse the browser callback.";
    else if (code === "access_denied")
      help = "Google or Microsoft denied access. Review consent and ask your organization administrator to approve the application if required.";
    throw new Error(`OAuth exchange failed (${response.status}). ${help}`);
  }
  const data = object(await response.json());
  if (text(data.token_type).toLowerCase() !== "bearer") throw new Error("Unsupported OAuth token type");
  return { accessToken: required(data.access_token), refreshToken: text(data.refresh_token) || undefined,
    expiresAt: Date.now() + number(data.expires_in, 3600) * 1000, scopes: text(data.scope).split(" ").filter(Boolean),
    tokenUrl, clientId: fields.client_id, clientSecret: fields.client_secret };
}
export async function login(provider: Exclude<Provider, "slack" | "whatsapp">, settings: Settings, openExternal: (url: string) => Promise<void>,
  fetcher: Fetch = globalThis.fetch, googleDesktopClientSecret?: string): Promise<Credential> {
  const config = configuration(provider, settings);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach immediately: closing the browser must not cause an unhandled rejection.
  void codePromise.catch(() => undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback" || !safeEqual(url.searchParams.get("state") ?? "", state)) {
      response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Invalid OAuth callback");
      return;
    }
    const code = url.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" })
      .end(code
        ? "Authorization received. You may close this tab and return to Relay Desk. Connection is still being completed. Your account is connected only when it appears in Settings. If it does not appear, review the connection error in Settings or Activity."
        : "Authorization was not completed. Return to Relay Desk for details.");
    if (code) resolveCode(code); else rejectCode(new Error("Authorization declined"));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot start OAuth callback");
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const url = new URL(config.authorizationUrl);
    url.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: redirectUri,
      scope: config.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
      ...(provider === "gmail" ? { access_type: "offline", prompt: "consent" } : { prompt: "select_account" }) }).toString();
    timer = setTimeout(() => rejectCode(new Error("OAuth sign-in timed out")), 180000);
    await openExternal(url.href);
    const code = await codePromise;
    const credential = await exchange(fetcher, config.tokenUrl, { client_id: config.clientId, grant_type: "authorization_code",
      code, redirect_uri: redirectUri, code_verifier: verifier,
      ...(provider === "gmail" && googleDesktopClientSecret ? { client_secret: googleDesktopClientSecret } : {}) });
    if (credential.scopes.length && config.scopes.some(scope => !credential.scopes.includes(scope) && scope !== "offline_access")) {
      throw new Error("Required provider permissions were not granted");
    }
    return credential;
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}
export class TokenStore {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly vault: Vault, private readonly fetcher: Fetch = globalThis.fetch) {}
  async access(accountId: string): Promise<string> {
    const credential = this.vault.get<Credential>("secrets", `provider:${accountId}`);
    if (!credential) throw new Error("Account is disconnected; sign in again");
    if (credential.expiresAt > Date.now() + 60000) return credential.accessToken;
    const pending = this.pending.get(accountId);
    if (pending) return pending;
    const operation = this.refresh(accountId, credential);
    this.pending.set(accountId, operation);
    try { return await operation; } finally { this.pending.delete(accountId); }
  }
  private async refresh(accountId: string, credential: Credential): Promise<string> {
    if (!credential.refreshToken || !credential.tokenUrl || !credential.clientId) throw new Error("Session expired; reconnect the account");
    const next = await exchange(this.fetcher, credential.tokenUrl, { client_id: credential.clientId, grant_type: "refresh_token",
      refresh_token: credential.refreshToken, ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}) });
    if (!this.vault.get<Credential>("secrets", `provider:${accountId}`)) throw new Error("Account disconnected");
    this.vault.put("secrets", `provider:${accountId}`, { ...next, accountId, refreshToken: next.refreshToken ?? credential.refreshToken,
      scopes: next.scopes.length ? next.scopes : credential.scopes });
    return next.accessToken;
  }
}
