import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Account, Attachment, CalendarEvent, Collection, Draft, EventChange, Message, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { ConnectorHub } from "../src/main/connectors";
import { ConflictError, HttpClient, ProviderError, UncertainWriteError, id, revision, source, trustedUrl, type Fetch, type Json, type Page, type Vault } from "../src/main/connectors/core";
import { GmailConnector, gmailMessage, gmailThreadRevision, googleEvent, GMAIL_BASE, GOOGLE_CALENDAR_BASE } from "../src/main/connectors/gmail";
import { graphEvent, MicrosoftConnector, GRAPH_BASE } from "../src/main/connectors/microsoft";
import { SlackConnector, SLACK_BASE, SLACK_SCOPES } from "../src/main/connectors/slack";
import { eventBody, validateChange } from "../src/main/connectors/calendar";
import { configuration, GOOGLE_SCOPES, login, MICROSOFT_SCOPES, TokenStore, type Credential } from "../src/main/auth/oauth";

class MemoryVault implements Vault {
  readonly data = new Map<string, unknown>();
  get<T>(collection: Collection, key: string): T | undefined { return this.data.get(`${collection}/${key}`) as T | undefined; }
  put<T>(collection: Collection, key: string, value: T): void { this.data.set(`${collection}/${key}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  delete(collection: Collection, key: string): void { this.data.delete(`${collection}/${key}`); }
}
const account: Account = { id: "gmail:me@example.org", provider: "gmail", email: "me@example.org", name: "Me", status: "connected", aiEnabled: false, consent: true };
const browserAccount: Account = { id: "browser:google:me@example.org", provider: "gmail", email: "me@example.org", name: "Me browser", status: "connected", aiEnabled: false, consent: true, connection: "browser" };
const graphAccount: Account = { ...account, id: "microsoft:user", provider: "microsoft" };
const slackAccount: Account = { ...account, id: "slack:T1:U1", provider: "slack" };
const mail = { ...source(account, "INBOX", "Inbox", "mail"), selected: true };
const browserSource = { id: `${browserAccount.id}:mail`, accountId: browserAccount.id, providerId: "mail", name: "Gmail pages (browser)", kind: "mail" as const, selected: true };
const folder = { ...source(graphAccount, "folder", "Inbox", "mail"), selected: true };
const channel = { ...source(slackAccount, "C1", "general", "channel"), selected: true };
function response(data: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } }); }
function client(base: string, fetcher: Fetch) { return new HttpClient(base, async () => "local-secret", fetcher, async () => undefined); }
function gmail(vault: Vault, fetcher: Fetch) { return new GmailConnector(client(GMAIL_BASE, fetcher), client(GOOGLE_CALENDAR_BASE, fetcher), vault); }
function nativeMail(providerId: string, historyId = "100"): Json {
  return { id: providerId, threadId: "thread", historyId, internalDate: "1700000000000", labelIds: ["INBOX", "UNREAD"],
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "sender@example.org" },
      { name: "To", value: "me@example.org" }, { name: "Message-ID", value: "<original@example.org>" }],
    body: { data: Buffer.from("Hello world").toString("base64url") } } };
}
const message = gmailMessage(account, mail, nativeMail("m1"), false).message;
const browserMessage: Message = {
  id: "browser-message", accountId: browserAccount.id, sourceId: `${browserAccount.id}:mail`, providerId: "thread:legacy-thread",
  threadId: `${browserAccount.id}:thread:legacy-thread`, subject: "Hello", sender: "sender@example.org", recipients: ["me@example.org"],
  body: "Hello world", receivedAt: "", url: "https://mail.google.com/mail/?authuser=me@example.org#all/legacy-thread",
  unread: true, revision: "browser-r1", historical: true, browser: { completeness: "preview", capturedAt: "2026-01-01T00:00:00Z", dateText: "Yesterday" }
};
const fullBrowserMessage: Message = {
  ...browserMessage, providerId: "api-message", threadId: `${browserAccount.id}:thread:thread`, browser: { ...browserMessage.browser!, completeness: "full" }
};
const draft: Draft = { id: "local-draft", accountId: account.id, messageId: message.id, body: "Réponse", subject: "Re: Hello",
  recipients: ["sender@example.org"], updatedAt: "2026-01-01", sourceRevision: "100", status: "local", citations: [] };
const eventChange: EventChange = { accountId: graphAccount.id, sourceId: "calendar", title: "Review", start: "2026-07-01T09:00:00-04:00",
  end: "2026-07-01T10:00:00-04:00", timeZone: "America/New_York", allDay: false, attendees: ["friend@example.org"], location: "Office", description: "Notes" };
function savePage(vault: Vault, pages: Page[]) {
  return async (page: Page) => {
    pages.push(page);
    for (const message of page.messages) vault.put("messages", message.id, message);
    if (page.checkpoint) vault.put("checkpoints", page.checkpoint.id, page.checkpoint.value);
  };
}

describe("provider HTTP security and retry boundaries", () => {
  it.each(["https://evil.example/v1.0/me", "https://graph.microsoft.com.evil.example/v1.0/me", "http://graph.microsoft.com/v1.0/me",
    "https://user:password@graph.microsoft.com/v1.0/me", "https://graph.microsoft.com/beta/me", "https://graph.microsoft.com/v1.0/../beta/me"])("rejects untrusted URL %s before fetching credentials", async url => {
    const fetcher = vi.fn<Fetch>();
    const token = vi.fn(async () => "secret");
    await expect(new HttpClient(GRAPH_BASE, token, fetcher).json(url)).rejects.toThrow("Untrusted");
    expect(fetcher).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
  });
  it("only permits Slack private files on the exact HTTPS host", () => {
    expect(trustedUrl("https://files.slack.com/files-pri/T/F/download", SLACK_BASE, true).hostname).toBe("files.slack.com");
    expect(() => trustedUrl("https://files.slack.com.evil.org/file", SLACK_BASE, true)).toThrow();
    expect(() => trustedUrl("https://drive.google.com/file", SLACK_BASE, true)).toThrow();
  });
  it("honors bounded Retry-After and disables automatic redirects", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({}, 429, { "retry-after": "2" })).mockResolvedValueOnce(response({ id: "ok" }));
    const wait = vi.fn(async () => undefined);
    const http = new HttpClient(GRAPH_BASE, async () => "secret", fetcher, wait);
    expect(await http.json("me")).toEqual({ id: "ok" });
    expect(wait).toHaveBeenCalledWith(2000, undefined);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });
  it("does not hot-loop through long rate limits or authentication failures", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({}, 429, { "retry-after": "120" }));
    await expect(client(GRAPH_BASE, fetcher).json("me")).rejects.toMatchObject({ status: 429, code: "retry_later" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValue(response({}, 401));
    await expect(client(GRAPH_BASE, fetcher).json("me")).rejects.toBeInstanceOf(ProviderError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds read retries, never retries uncertain mutation requests", async () => {
    const fetcher = vi.fn<Fetch>().mockRejectedValue(new Error("contains sensitive provider content"));
    await expect(client(GRAPH_BASE, fetcher).json("me")).rejects.toThrow("network_error");
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockClear();
    await expect(client(GRAPH_BASE, fetcher).write("me/messages/id/createReplyAll", "POST", {})).rejects.toBeInstanceOf(UncertainWriteError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not fetch once cancelled", async () => {
    const fetcher = vi.fn<Fetch>();
    const controller = new AbortController(); controller.abort(new Error("stopped"));
    await expect(client(GRAPH_BASE, fetcher).json("me", { signal: controller.signal })).rejects.toThrow("stopped");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[GMAIL_BASE, "Gmail API"], [GOOGLE_CALENDAR_BASE, "Google Calendar API"]])("identifies the Google API rejecting access: %s", async (base, api) => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({ error: { message: "sensitive-provider-value" } }, 403));
    const operation = client(base, fetcher).json("users/me/profile");
    await expect(operation).rejects.toThrow(`Enable ${api}`);
    await expect(operation).rejects.not.toThrow("sensitive-provider-value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("marks a successful mutation with a truncated response as uncertain, without retry", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response("{", { status: 200 }));
    await expect(client(GMAIL_BASE, fetcher).write("users/me/drafts", "POST", {})).rejects.toBeInstanceOf(UncertainWriteError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("public OAuth", () => {
  it("rejects WhatsApp even if an untyped caller bypasses the browser-only IPC boundary", () => {
    expect(() => configuration("whatsapp" as never, defaultSettings)).toThrow("does not support an OAuth");
  });
  it("requests draft permissions but no Mail.Send or Slack write scopes", () => {
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(GOOGLE_SCOPES).not.toContain("https://mail.google.com/");
    expect(MICROSOFT_SCOPES).toContain("Mail.ReadWrite");
    expect(MICROSOFT_SCOPES).not.toContain("Mail.Send");
    expect(SLACK_SCOPES.some(scope => scope.includes("write"))).toBe(false);
    expect(() => configuration("microsoft", { ...defaultSettings, microsoftClientId: "client", microsoftTenant: "common/evil" })).toThrow("tenant");
  });
  it("uses browser PKCE, rejects wrong state, and exchanges only on the token endpoint", async () => {
    let authorize: URL | undefined;
    const fetcher = vi.fn<Fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code")).toBe("returned-code");
      expect(body.get("client_secret")).toBe("native-registration-value");
      expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(authorize?.searchParams.get("code_challenge"));
      return response({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600, scope: GOOGLE_SCOPES.join(" ") });
    });
    const credential = await login("gmail", { ...defaultSettings, googleClientId: "registered-desktop" }, async url => {
      authorize = new URL(url);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.has("client_secret")).toBe(false);
      const redirect = authorize.searchParams.get("redirect_uri") ?? "";
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      expect((await fetch(`${redirect}?state=wrong&code=bad`)).status).toBe(400);
      const callback = await fetch(`${redirect}?state=${authorize.searchParams.get("state")}&code=returned-code`);
      expect(callback.status).toBe(200);
      const callbackText = await callback.text();
      expect(callbackText).toContain("Authorization received");
      expect(callbackText).toContain("Connection is still being completed");
      expect(callbackText).not.toContain("Connected.");
    }, fetcher, "native-registration-value");
    expect(credential.refreshToken).toBe("refresh");
    expect(credential.clientSecret).toBe("native-registration-value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["invalid_request", undefined, "Google desktop client secret"],
    ["invalid_client", "wrong-registration-value", "same Desktop app"],
    ["invalid_grant", "native-registration-value", "Start a new connection"],
    ["access_denied", "native-registration-value", "administrator"],
  ])("reports actionable OAuth failure after callback without leaking provider details: %s", async (code, secret, expected) => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({ error: code, error_description: "sensitive-provider-value" }, 400));
    const operation = login("gmail", { ...defaultSettings, googleClientId: "registered-desktop" }, async url => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "returned-code" }).toString();
      const result = await fetch(callback);
      expect(await result.text()).not.toContain("Connected.");
    }, fetcher, secret);
    await expect(operation).rejects.toThrow(expected);
    await expect(operation).rejects.not.toThrow("sensitive-provider-value");
  });
  it("coalesces refreshes and stores token rotation only in the vault", async () => {
    const vault = new MemoryVault();
    vault.put<Credential>("secrets", "provider:account", { accessToken: "expired", refreshToken: "r1", expiresAt: 0,
      clientId: "client", clientSecret: "native", tokenUrl: "https://oauth2.googleapis.com/token", scopes: GOOGLE_SCOPES });
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }));
    const store = new TokenStore(vault, fetcher);
    expect(await Promise.all([store.access("account"), store.access("account")])).toEqual(["new", "new"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vault.get<Credential>("secrets", "provider:account")?.refreshToken).toBe("r2");
    expect(vault.get<Credential>("secrets", "provider:account")?.accountId).toBe("account");
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("client_secret=native");
  });
  it("never sends a refresh token to a poisoned token endpoint", async () => {
    const vault = new MemoryVault();
    vault.put<Credential>("secrets", "provider:account", { accessToken: "expired", refreshToken: "r", expiresAt: 0,
      clientId: "client", tokenUrl: "https://evil.example/token", scopes: [] });
    const fetcher = vi.fn<Fetch>();
    await expect(new TokenStore(vault, fetcher).access("account")).rejects.toThrow("Invalid token endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Gmail selected history and native drafts", () => {
  it("fully paginates backfill, awaits each commit, then advances incremental history", async () => {
    const vault = new MemoryVault(); const pages: Page[] = []; let firstCommitted = false;
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) return response({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("labelIds")).toBe("INBOX");
        if (url.searchParams.get("pageToken")) { expect(firstCommitted).toBe(true); return response({ messages: [{ id: "m2" }] }); }
        return response({ messages: [{ id: "m1" }], nextPageToken: "second" });
      }
      if (url.pathname.endsWith("/history")) return response({ historyId: "105", history: [] });
      return response(nativeMail(url.pathname.endsWith("m2") ? "m2" : "m1"));
    });
    await gmail(vault, fetcher).sync(account, mail, async page => {
      await Promise.resolve(); await savePage(vault, pages)(page); firstCommitted = true;
    });
    expect(pages.flatMap(page => page.messages).map(message => message.providerId)).toEqual(["m1", "m2"]);
    expect(pages.flatMap(page => page.messages).every(message => message.historical && message.sourceId === mail.id)).toBe(true);
    expect(vault.get("checkpoints", id(account.id, "checkpoint", mail.id))).toEqual({ phase: "history", historyId: "105" });
  });
  it("does not persist checkpoints directly or fetch messages outside selected labels", async () => {
    const vault = new MemoryVault();
    vault.put("checkpoints", id(account.id, "checkpoint", mail.id), { phase: "history", historyId: "100" });
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ historyId: "200", history: [{ messagesAdded: [{ message: { id: "outside" } }] }] }))
      .mockResolvedValueOnce(response({ ...nativeMail("outside"), labelIds: ["OTHER"] }));
    const pages: Page[] = [];
    await gmail(vault, fetcher).sync(account, mail, page => { pages.push(page); });
    expect(pages[0].messages).toEqual([]);
    expect(vault.get("checkpoints", id(account.id, "checkpoint", mail.id))).toEqual({ phase: "history", historyId: "100" });
  });
  it("propagates atomic callback failure before requesting the next page", async () => {
    const vault = new MemoryVault();
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ historyId: "100" })).mockResolvedValueOnce(response({ nextPageToken: "next" }));
    await expect(gmail(vault, fetcher).sync(account, mail, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("creates a Unicode reply draft with native thread and MIME references, never sends", async () => {
    const vault = new MemoryVault();
    const fetcher = vi.fn<Fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toBe(`${GMAIL_BASE}users/me/drafts`);
        const body = JSON.parse(String(init.body)) as { message: { raw: string; threadId: string } };
        expect(body.message.threadId).toBe("thread");
        const mime = Buffer.from(body.message.raw, "base64url").toString("utf8");
        expect(mime).toContain("In-Reply-To: <original@example.org>");
        expect(mime).toContain("References: <original@example.org>");
        expect(mime).toContain(Buffer.from(draft.body).toString("base64"));
        return response({ id: "native-draft" });
      }
      return response(url.includes("/drafts/") ? { id: "native-draft", message: nativeMail("draft-message") } : nativeMail("m1"));
    });
    expect((await gmail(vault, fetcher).saveDraft(account, message, draft)).providerId).toBe("native-draft");
    expect(fetcher.mock.calls.some(([input]) => /\/send|\/modify|\/trash|\/delete/.test(String(input)))).toBe(false);
  });
  it("rejects remote draft revisions and MIME header injection without writing", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response(nativeMail("m1"))).mockResolvedValueOnce(response({ id: "d", message: nativeMail("d") }));
    await expect(gmail(new MemoryVault(), fetcher).saveDraft(account, message, { ...draft, providerId: "d", providerRevision: "old" })).rejects.toBeInstanceOf(ConflictError);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    fetcher.mockReset().mockResolvedValue(response(nativeMail("m1")));
    await expect(gmail(new MemoryVault(), fetcher).saveDraft(account, message, { ...draft, recipients: ["a@example.org\r\nBcc: b@example.org"] })).rejects.toThrow("MIME");
  });
  it("resolves an exact preview thread without guessing across the mailbox and puts the reply target first in citations", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/threads/legacy-thread")) return response({
        id: "legacy-thread", historyId: "210",
        messages: [
          { ...nativeMail("older", "205"), threadId: "legacy-thread", internalDate: "1699999900000" },
          { ...nativeMail("api-message", "200"), threadId: "legacy-thread", internalDate: "1700000000000" },
          { ...nativeMail("draft-only", "209"), threadId: "legacy-thread", internalDate: "1700000100000", labelIds: ["DRAFT"] }
        ]
      });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const resolved = await gmail(vault, fetcher).resolveBrowserThread(account, browserMessage);
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/messages?"))).toBe(false);
    expect(resolved.message).toMatchObject({ accountId: account.id, providerId: "api-message", revision: "200" });
    expect(resolved.threadProviderId).toBe("legacy-thread");
    expect(resolved.threadRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.citations[0]).toMatchObject({ messageId: browserMessage.id, id: `${browserMessage.id}:api-message` });
    expect(resolved.citations[1]).toMatchObject({ id: `${browserMessage.id}:older` });
  });
  it("fails closed when browser provenance is missing or unavailable instead of searching the mailbox", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    const invalid = { ...browserMessage, providerId: "not a gmail id", threadId: "not-a-thread-id" };
    const fetcher = vi.fn<Fetch>();
    await expect(gmail(vault, fetcher).resolveBrowserThread(account, invalid)).rejects.toThrow("trusted Gmail message or thread identifier");
    expect(fetcher).not.toHaveBeenCalled();
    const exactFetch = vi.fn<Fetch>().mockResolvedValue(response({}, 404));
    await expect(gmail(vault, exactFetch).resolveBrowserThread(account, browserMessage)).rejects.toThrow("thread identifier is unavailable");
    expect(exactFetch.mock.calls.some(([input]) => String(input).includes("/messages?"))).toBe(false);
  });
  it("uses the exact full-message provenance and rejects a misleading same-subject thread", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/api-message")) return response({ ...nativeMail("api-message", "220"), threadId: "thread" });
      if (url.pathname.endsWith("/threads/thread")) return response({
        id: "thread", historyId: "220",
        messages: [
          { ...nativeMail("api-message", "220"), threadId: "thread", internalDate: "1700000000000" },
          { ...nativeMail("older", "219"), threadId: "thread", internalDate: "1699999900000", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "sender@example.org" }, { name: "To", value: "me@example.org" }, { name: "Message-ID", value: "<older@example.org>" }], body: { data: Buffer.from("Earlier").toString("base64url") } } }
        ]
      });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const resolved = await gmail(vault, fetcher).resolveBrowserThread(account, fullBrowserMessage);
    expect(resolved.message.providerId).toBe("api-message");
    expect(resolved.citations[0].id).toBe(`${fullBrowserMessage.id}:api-message`);
  });
  it("rejects an exact full-message provenance when the native message is a draft", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    const fetcher = vi.fn<Fetch>().mockResolvedValue({} as Response);
    fetcher.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/api-message")) return response({ ...nativeMail("api-message", "220"), labelIds: ["DRAFT"], threadId: "thread" });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    await expect(gmail(vault, fetcher).resolveBrowserThread(account, fullBrowserMessage)).rejects.toThrow("points to a draft");
  });
  it("preserves the existing API-only Gmail draft path when no nativeTarget is present", async () => {
    const vault = new MemoryVault();
    vault.put("sources", mail.id, mail);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: vi.fn<Fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") return response({ id: "native-draft" });
      return response(url.includes("/drafts/") ? { id: "native-draft", message: nativeMail("draft-message") } : nativeMail("m1"));
    }) });
    expect((await hub.saveDraft(account, message, draft)).providerId).toBe("native-draft");
  });
  it("routes a reviewed browser-linked Gmail draft only when the original browser message and approved draft still match", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, browserSource);
    vault.put("messages", browserMessage.id, browserMessage);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: vi.fn<Fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") return response({ id: "native-draft" });
      if (url.pathname.endsWith("/threads/thread")) return response({ id: "thread", historyId: "200", messages: [{ ...nativeMail("api-message", "200"), threadId: "thread" }] });
      return response(String(url).includes("/drafts/") ? { id: "native-draft", message: nativeMail("draft-message") } : nativeMail("api-message", "200"));
    }) });
    const linkedMessage = { ...message, id: `${account.id}:message:api-message`, providerId: "api-message", sourceId: `${account.id}:mail:__browser-thread__`, revision: "200" };
    const approvedBrowserDraft: Draft = {
      ...draft,
      id: "browser-linked",
      accountId: browserAccount.id,
      messageId: browserMessage.id,
      sourceRevision: browserMessage.revision,
      body: "Reviewed browser reply",
      subject: "Re: Hello",
      recipients: ["sender@example.org"],
      nativeTarget: {
        accountId: account.id, provider: "gmail", messageProviderId: linkedMessage.providerId, threadProviderId: "thread",
        messageRevision: linkedMessage.revision, threadRevision: gmailThreadRevision({ messages: [nativeMail("api-message", "200")] }), resolvedAt: "2026-01-01T00:00:00Z"
      },
      citations: []
    };
    vault.put("drafts", approvedBrowserDraft.id, approvedBrowserDraft);
    const linkedDraft: Draft = {
      ...approvedBrowserDraft,
      accountId: account.id,
      messageId: linkedMessage.id,
      sourceRevision: linkedMessage.revision
    };
    expect((await hub.saveDraft(account, linkedMessage, linkedDraft, { browserMessageId: browserMessage.id })).providerId).toBe("native-draft");
  });
  it("rejects browser-linked Gmail draft routing when the browser source is no longer selected", async () => {
    const vault = new MemoryVault();
    vault.put("accounts", browserAccount.id, browserAccount);
    vault.put("sources", browserSource.id, { ...browserSource, selected: false });
    vault.put("messages", browserMessage.id, browserMessage);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const linkedMessage = { ...message, id: `${account.id}:message:api-message`, providerId: "api-message", sourceId: `${account.id}:mail:__browser-thread__`, revision: "200" };
    const approvedBrowserDraft: Draft = {
      ...draft,
      id: "browser-linked",
      accountId: browserAccount.id,
      messageId: browserMessage.id,
      sourceRevision: browserMessage.revision,
      nativeTarget: {
        accountId: account.id, provider: "gmail", messageProviderId: linkedMessage.providerId, threadProviderId: "thread",
        messageRevision: linkedMessage.revision, threadRevision: gmailThreadRevision({ messages: [nativeMail("api-message", "200")] }), resolvedAt: "2026-01-01T00:00:00Z"
      },
      citations: []
    };
    vault.put("drafts", approvedBrowserDraft.id, approvedBrowserDraft);
    const linkedDraft: Draft = {
      ...approvedBrowserDraft,
      accountId: account.id,
      messageId: linkedMessage.id,
      sourceRevision: linkedMessage.revision
    };
    await expect(new ConnectorHub(vault, async () => undefined).saveDraft(account, linkedMessage, linkedDraft, { browserMessageId: browserMessage.id }))
      .rejects.toThrow("Source is not selected");
  });
  it("blocks a native Gmail draft write when the verified thread changed after approval", async () => {
    const linkedMessage = { ...message, id: `${account.id}:message:api-message`, providerId: "api-message", sourceId: `${account.id}:mail:__browser-thread__`, revision: "200" };
    const linkedDraft: Draft = {
      ...draft, accountId: account.id, messageId: linkedMessage.id, sourceRevision: "200",
      nativeTarget: {
        accountId: account.id, provider: "gmail", messageProviderId: "api-message", threadProviderId: "thread",
        messageRevision: "200", threadRevision: gmailThreadRevision({ messages: [nativeMail("api-message", "200")] }), resolvedAt: "2026-01-01T00:00:00Z"
      }
    };
    const fetcher = vi.fn<Fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages/api-message")) return response({ ...nativeMail("api-message", "200"), threadId: "thread" });
      if (url.pathname.endsWith("/threads/thread")) return response({ id: "thread", historyId: "201", messages: [
        { ...nativeMail("api-message", "200"), threadId: "thread" }, { ...nativeMail("new-reply", "201"), threadId: "thread" }
      ] });
      throw new Error(`Unexpected ${url.pathname}`);
    });
    await expect(gmail(new MemoryVault(), fetcher).saveDraft(account, linkedMessage, linkedDraft)).rejects.toBeInstanceOf(ConflictError);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("updates its own saved browser draft without mistaking the draft's history change for a new reply", async () => {
    const original = nativeMail("api-message", "200");
    const linkedMessage = { ...message, providerId: "api-message", revision: "200" };
    const linkedDraft: Draft = { ...draft, messageId: linkedMessage.id, sourceRevision: "200",
      nativeTarget: { accountId: account.id, provider: "gmail", messageProviderId: "api-message",
        threadProviderId: "thread", messageRevision: "200",
        threadRevision: gmailThreadRevision({ messages: [original] }), resolvedAt: "2026-01-01T00:00:00Z" } };
    let writes = 0;
    let saved: Json | undefined;
    const fetcher = vi.fn<Fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" || init?.method === "PUT") {
        writes++;
        saved = { id: "native-draft", message: { ...nativeMail("draft-message", String(200 + writes)), labelIds: ["DRAFT"] } };
        return response(saved);
      }
      if (url.pathname.endsWith("/messages/api-message")) return response(original);
      if (url.pathname.endsWith("/threads/thread")) return response({ id: "thread", historyId: String(200 + writes),
        messages: [original, ...(saved ? [saved.message] : [])] });
      if (url.pathname.endsWith("/drafts/native-draft") && saved) return response(saved);
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const connector = gmail(new MemoryVault(), fetcher);
    const first = await connector.saveDraft(account, linkedMessage, linkedDraft);
    await expect(connector.saveDraft(account, linkedMessage, { ...linkedDraft, ...first, body: "Reviewed edited reply" }))
      .resolves.toHaveProperty("providerId", "native-draft");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("paginates calendar occurrences and commits the final sync token through onPage only", async () => {
    const vault = new MemoryVault(); const pages: Page[] = [];
    const calendar = { ...source(account, "primary", "Calendar", "calendar"), selected: true };
    const nativeEvent = { id: "e1", summary: "All day", etag: '"r1"', start: { date: "2026-07-01" }, end: { date: "2026-07-02" } };
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ items: [nativeEvent], nextPageToken: "next" }))
      .mockResolvedValueOnce(response({ items: [{ ...nativeEvent, id: "e2", recurringEventId: "series", status: "cancelled" }], nextSyncToken: "sync-2" }));
    await gmail(vault, fetcher).sync(account, calendar, savePage(vault, pages));
    expect(pages[0].events[0]).toMatchObject({ allDay: true, start: "2026-07-01", end: "2026-07-02", sourceId: calendar.id });
    expect(pages[1].events[0]).toMatchObject({ recurring: true, writable: false });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("pageToken")).toBe("next");
    expect(vault.get("checkpoints", id(account.id, "checkpoint", calendar.id))).toEqual({ syncToken: "sync-2" });
  });
});

describe("Microsoft Graph pagination and safe mutations", () => {
  it("recursively enumerates folders and paginates calendars with unselected sources", async () => {
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = String(input);
      if (url.includes("childFolders")) return response({ value: [{ id: "child", displayName: "Nested" }] });
      if (url.includes("mailFolders")) return response({ value: [{ id: "root", displayName: "Root", childFolderCount: 1 }] });
      if (url.includes("second")) return response({ value: [{ id: "c2", name: "Other" }] });
      return response({ value: [{ id: "c1", name: "Calendar" }], "@odata.nextLink": `${GRAPH_BASE}me/calendars?second=1` });
    });
    const sources = await new MicrosoftConnector(client(GRAPH_BASE, fetcher), new MemoryVault()).discover(graphAccount);
    expect(sources.map(source => source.providerId)).toEqual(["root", "child", "c1", "c2"]);
    expect(sources.every(source => !source.selected && source.accountId === graphAccount.id && source.id.startsWith(graphAccount.id))).toBe(true);
  });
  it("uses all delta pages and attachment pages and yields tombstones", async () => {
    const vault = new MemoryVault(); const pages: Page[] = [];
    const existing = { ...message, id: id(graphAccount.id, "message", "deleted"), providerId: "deleted", accountId: graphAccount.id, sourceId: folder.id };
    vault.put("messages", existing.id, existing);
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = String(input);
      if (url.includes("attachments")) return response({ value: [{ id: "a", name: "file.pdf", contentType: "application/pdf", size: 3 }] });
      if (url.includes("next=1")) return response({ value: [{ id: "deleted", "@removed": { reason: "deleted" } }], "@odata.deltaLink": `${GRAPH_BASE}delta?token=final` });
      return response({ value: [{ id: "m1", conversationId: "thread", hasAttachments: true, body: { contentType: "text", content: "Hi" } }],
        "@odata.nextLink": `${GRAPH_BASE}me/mailFolders/folder/messages/delta?next=1` });
    });
    await new MicrosoftConnector(client(GRAPH_BASE, fetcher), vault).sync(graphAccount, folder, savePage(vault, pages));
    expect(pages[0].attachments).toHaveLength(1);
    expect(pages[1].messages[0].deleted).toBe(true);
    expect(vault.get("checkpoints", id(graphAccount.id, "checkpoint", folder.id))).toEqual({ delta: `${GRAPH_BASE}delta?token=final`, historical: false });
  });
  it("rejects malicious nextLink before bearer credentials can leave Graph", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({ value: [], "@odata.nextLink": "https://evil.example/steal" }));
    await expect(new MicrosoftConnector(client(GRAPH_BASE, fetcher), new MemoryVault()).sync(graphAccount, folder, () => undefined)).rejects.toThrow("Untrusted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates reply-all drafts rather than immediately replying or sending", async () => {
    const original = { id: "m1", conversationId: "t", "@odata.etag": 'W/"r1"' };
    const graphMessage: Message = { ...message, accountId: graphAccount.id, revision: 'W/"r1"' };
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response({ id: "d1" }))
      .mockResolvedValueOnce(response({ id: "d1", isDraft: true, "@odata.etag": 'W/"d1"' }));
    const result = await new MicrosoftConnector(client(GRAPH_BASE, fetcher), new MemoryVault()).saveDraft(graphAccount, graphMessage, { ...draft, sourceRevision: graphMessage.revision });
    expect(result).toEqual({ providerId: "d1", providerRevision: 'W/"d1"' });
    expect(String(fetcher.mock.calls[1][0])).toBe(`${GRAPH_BASE}me/messages/m1/createReplyAll`);
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
  });
  it("checks exact event revision before PATCH and sends If-Match", async () => {
    const vault = new MemoryVault();
    const calendar = { ...source(graphAccount, "cal", "Calendar", "calendar"), selected: true };
    const remote = { id: "e", subject: "Old", "@odata.etag": 'W/"e1"', isOrganizer: true, start: { dateTime: "2026-07-01T13:00:00", timeZone: "UTC" }, end: { dateTime: "2026-07-01T14:00:00", timeZone: "UTC" } };
    const event: CalendarEvent = { id: "local-event", accountId: graphAccount.id, sourceId: calendar.id, providerId: "e", title: "", start: "", end: "", allDay: false, timeZone: "UTC", attendees: [], location: "", description: "", revision: 'W/"e1"', url: "" };
    vault.put("events", event.id, event);
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response(remote)).mockResolvedValueOnce(response({ ...remote, "@odata.etag": 'W/"e2"' }));
    await new MicrosoftConnector(client(GRAPH_BASE, fetcher), vault).writeEvent(graphAccount, calendar, { ...eventChange, eventId: event.id, expectedRevision: 'W/"e1"' }, "op");
    expect(fetcher.mock.calls[1][1]?.method).toBe("PATCH");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("if-match")).toBe('W/"e1"');
    fetcher.mockReset().mockResolvedValue(response(remote));
    await expect(new MicrosoftConnector(client(GRAPH_BASE, fetcher), vault).writeEvent(graphAccount, calendar, { ...eventChange, eventId: event.id, expectedRevision: "different" }, "op")).rejects.toBeInstanceOf(ConflictError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Slack read-only threads and files", () => {
  it("requires authorized user identity and all documented read scopes", async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ ok: true, team_id: "T1", user_id: "U1", team: "Work", user: "Me" }, 200,
      { "x-oauth-scopes": SLACK_SCOPES.join(",") }));
    expect((await new SlackConnector(client(SLACK_BASE, fetcher), new MemoryVault()).identity()).id).toBe("T1:U1");
    fetcher.mockReset().mockResolvedValue(response({ ok: true, team_id: "T1", user_id: "U1" }));
    await expect(new SlackConnector(client(SLACK_BASE, fetcher), new MemoryVault()).identity()).rejects.toThrow("read scopes");
  });
  it("discovers replies on old parents even when incremental history is empty", async () => {
    const vault = new MemoryVault(); const pages: Page[] = [];
    vault.put("checkpoints", id(slackAccount.id, "checkpoint", channel.id), { latest: "1700001000.000001", fullScanAt: Date.now() });
    const archived: Message = { ...message, id: id(slackAccount.id, "message", "C1:1600000000.000001"), accountId: slackAccount.id,
      sourceId: channel.id, providerId: "C1:1600000000.000001", threadId: id(slackAccount.id, "thread", "C1:1600000000.000001") };
    vault.put("messages", archived.id, archived);
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("conversations.history")) return response({ ok: true, messages: [] });
      expect(url.pathname).toBe("/api/conversations.replies");
      expect(url.searchParams.get("ts")).toBe("1600000000.000001");
      return response({ ok: true, messages: [{ ts: "1600000000.000001", text: "Old" }, { ts: "1700001001.000001", thread_ts: "1600000000.000001", text: "New reply" }] });
    });
    await new SlackConnector(client(SLACK_BASE, fetcher), vault).sync(slackAccount, channel, savePage(vault, pages));
    expect(pages.flatMap(page => page.messages).some(message => message.body === "New reply" && !message.historical)).toBe(true);
    expect(fetcher.mock.calls.every(([input]) => !String(input).includes("chat.post"))).toBe(true);
  });
  it("rejects external-file and hostile attachment URLs without leaking the token", async () => {
    const attachment: Attachment = { id: "file", accountId: slackAccount.id, messageId: "m", providerId: "F1", name: "file", mimeType: "text/plain", status: "pending" };
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response({ ok: true, file: { id: "F1", url_private: "https://evil.example/secret" } }));
    await expect(new SlackConnector(client(SLACK_BASE, fetcher), new MemoryVault()).downloadAttachment(attachment)).rejects.toThrow("Untrusted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValue(response({ ok: true, file: { id: "F1", is_external: true, url_private: "https://files.slack.com/file" } }));
    await expect(new SlackConnector(client(SLACK_BASE, fetcher), new MemoryVault()).downloadAttachment(attachment)).rejects.toThrow("separately authorized");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fully paginates history and old-thread replies before completing a checkpoint", async () => {
    const vault = new MemoryVault(); const pages: Page[] = [];
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      const url = new URL(String(input)); const next = url.searchParams.get("cursor");
      if (url.pathname.endsWith("conversations.history")) {
        return response(next ? { ok: true, messages: [] } :
          { ok: true, messages: [{ ts: "1700000000.000001", text: "Root" }], has_more: true, response_metadata: { next_cursor: "h2" } });
      }
      return response(next ? { ok: true, messages: [{ ts: "1700000001.000001", thread_ts: "1700000000.000001", text: "Reply" }] } :
        { ok: true, messages: [{ ts: "1700000000.000001", text: "Root" }], has_more: true, response_metadata: { next_cursor: "r2" } });
    });
    await new SlackConnector(client(SLACK_BASE, fetcher), vault).sync(slackAccount, channel, savePage(vault, pages));
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(pages.flatMap(page => page.messages).some(message => message.body === "Reply")).toBe(true);
    expect(vault.get<{ latest: string; scanning?: boolean }>("checkpoints", id(slackAccount.id, "checkpoint", channel.id))).toMatchObject({ latest: "1700000000.000001" });
    expect(vault.get<{ scanning?: boolean }>("checkpoints", id(slackAccount.id, "checkpoint", channel.id))?.scanning).toBeUndefined();
  });
});

describe("calendar dates and ConnectorHub policy boundaries", () => {
  it.each(["gmail", "microsoft"] as const)("emits explicit tombstones when a %s full calendar refresh is empty", async provider => {
    const selectedAccount = provider === "gmail" ? account : graphAccount;
    const calendar = { ...source(selectedAccount, "cal", "Calendar", "calendar"), selected: true };
    const vault = new MemoryVault(); const pages: Page[] = [];
    const existing: CalendarEvent = { id: id(selectedAccount.id, "event", "cal:removed"), accountId: selectedAccount.id,
      sourceId: calendar.id, providerId: "removed", title: "Removed appointment",
      start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 90000000).toISOString(),
      timeZone: "UTC", allDay: false, attendees: [], location: "", description: "", revision: "old", url: "", writable: true };
    vault.put("events", existing.id, existing);
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response(provider === "gmail" ? { items: [], nextSyncToken: "new" } : { value: [] }));
    const adapter = provider === "gmail" ? gmail(vault, fetcher) : new MicrosoftConnector(client(GRAPH_BASE, fetcher), vault);
    await adapter.sync(selectedAccount, calendar, page => { pages.push(page); });
    expect(pages[0].events).toEqual([{ ...existing, title: "(Cancelled) Removed appointment", writable: false }]);
  });
  it.each(["gmail", "microsoft"] as const)("preserves observed events from earlier %s calendar pages after restart", async provider => {
    const selectedAccount = provider === "gmail" ? account : graphAccount;
    const calendar = { ...source(selectedAccount, "cal", "Calendar", "calendar"), selected: true };
    const vault = new MemoryVault(); const pages: Page[] = [];
    const existing: CalendarEvent = { id: id(selectedAccount.id, "event", "cal:kept"), accountId: selectedAccount.id,
      sourceId: calendar.id, providerId: "kept", title: "Kept appointment",
      start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 90000000).toISOString(),
      timeZone: "UTC", allDay: false, attendees: [], location: "", description: "", revision: "old", url: "", writable: true };
    vault.put("events", existing.id, existing);
    const removed = { ...existing, id: id(selectedAccount.id, "event", "cal:removed"), providerId: "removed", title: "Removed appointment" };
    vault.put("events", removed.id, removed);
    vault.put("checkpoints", id(selectedAccount.id, "checkpoint", calendar.id), provider === "gmail" ?
      { pageToken: "second", seenIds: [existing.id] } :
      { next: `${GRAPH_BASE}me/calendars/cal/calendarView?next=second`, seenIds: [existing.id],
        start: new Date(Date.now() - 86400000).toISOString(), end: new Date(Date.now() + 86400000 * 7).toISOString() });
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response(provider === "gmail" ? { items: [], nextSyncToken: "new" } : { value: [] }));
    const adapter = provider === "gmail" ? gmail(vault, fetcher) : new MicrosoftConnector(client(GRAPH_BASE, fetcher), vault);
    await adapter.sync(selectedAccount, calendar, page => { pages.push(page); });
    expect(pages[0].events).toHaveLength(1);
    expect(pages[0].events[0]).toMatchObject({ id: removed.id, writable: false });
  });
  it("does not infer Google deletions from empty incremental pages and preserves sparse tombstone dates", async () => {
    const calendar = { ...source(account, "cal", "Calendar", "calendar"), selected: true };
    const vault = new MemoryVault(); const pages: Page[] = [];
    const existing: CalendarEvent = { id: id(account.id, "event", "cal:kept"), accountId: account.id, sourceId: calendar.id, providerId: "kept",
      title: "Original title", start: "2026-07-01", end: "2026-07-02", timeZone: "Europe/Paris", allDay: true,
      attendees: [], location: "", description: "", revision: "old", url: "", writable: true };
    vault.put("events", existing.id, existing);
    vault.put("checkpoints", id(account.id, "checkpoint", calendar.id), { syncToken: "old-token" });
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ items: [], nextSyncToken: "next" }))
      .mockResolvedValueOnce(response({ items: [{ id: "kept", status: "cancelled", etag: "cancelled" }], nextSyncToken: "last" }));
    await gmail(vault, fetcher).sync(account, calendar, savePage(vault, pages));
    expect(pages[0].events).toEqual([]);
    await gmail(vault, fetcher).sync(account, calendar, savePage(vault, pages));
    expect(pages[1].events[0]).toEqual({ ...existing, title: "(Cancelled) Original title", revision: "cancelled", writable: false });
  });
  it("preserves all-day exclusive dates and timed timezone across DST", () => {
    const allDay = { ...eventChange, allDay: true, start: "2026-03-08", end: "2026-03-09" };
    validateChange(allDay);
    expect(eventBody("gmail", allDay).end).toEqual({ date: "2026-03-09" });
    expect(eventBody("microsoft", allDay).start).toEqual({ dateTime: "2026-03-08T00:00:00", timeZone: "America/New_York" });
    expect(eventBody("microsoft", eventChange).start).toEqual({ dateTime: "2026-07-01T09:00:00", timeZone: "America/New_York" });
    expect(() => validateChange({ ...eventChange, start: "2026-07-01T09:00" })).toThrow("offset");
    expect(() => validateChange({ ...allDay, start: "2026-02-30" })).toThrow("valid");
    expect(() => validateChange({ ...eventChange, recurrence: {} } as EventChange)).toThrow("Recurrence");
  });
  it("preserves explicit reminder payloads and leaves provider defaults untouched when omitted", () => {
    const withReminder = { ...eventChange, reminderMinutes: 0 };
    expect(eventBody("gmail", withReminder)).toMatchObject({ reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] } });
    expect(eventBody("microsoft", withReminder)).toMatchObject({ isReminderOn: true, reminderMinutesBeforeStart: 0 });
    expect(eventBody("gmail", eventChange)).not.toHaveProperty("reminders");
    expect(eventBody("microsoft", eventChange)).not.toHaveProperty("isReminderOn");
    expect(eventBody("microsoft", eventChange)).not.toHaveProperty("reminderMinutesBeforeStart");
  });
  it.each([Number.NaN, 0.5, -1, 40321])("rejects invalid reminder minutes: %p", reminderMinutes => {
    expect(() => validateChange({ ...eventChange, reminderMinutes })).toThrow("Reminder");
  });
  it("maps Google calendar reminders only when explicitly present", () => {
    const calendar = { ...source(account, "primary", "Calendar", "calendar"), selected: true };
    expect(googleEvent(account, calendar, {
      id: "event-1", summary: "Reminder", etag: '"r1"', htmlLink: "https://calendar.google.com/calendar/event?eid=1",
      start: { dateTime: "2026-07-01T09:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-01T10:00:00-04:00", timeZone: "America/New_York" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] }
    }).reminderMinutes).toBe(0);
    expect(googleEvent(account, calendar, {
      id: "event-2", summary: "Default reminder", etag: '"r2"',
      start: { dateTime: "2026-07-01T09:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-01T10:00:00-04:00", timeZone: "America/New_York" },
      reminders: { useDefault: true, overrides: [{ method: "popup", minutes: 15 }] }
    }).reminderMinutes).toBeUndefined();
  });
  it("maps Microsoft reminders only when enabled and in range", () => {
    const calendar = { ...source(graphAccount, "cal", "Calendar", "calendar"), selected: true };
    expect(graphEvent(graphAccount, calendar, {
      id: "event-1", subject: "Reminder", "@odata.etag": 'W/"r1"', webLink: "https://outlook.office.com/calendar/item/1",
      isOrganizer: true, isReminderOn: true, reminderMinutesBeforeStart: 0,
      start: { dateTime: "2026-07-01T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-01T10:00:00", timeZone: "America/New_York" }
    }).reminderMinutes).toBe(0);
    expect(graphEvent(graphAccount, calendar, {
      id: "event-2", subject: "No reminder", "@odata.etag": 'W/"r2"', webLink: "https://outlook.office.com/calendar/item/2",
      isOrganizer: true, isReminderOn: false, reminderMinutesBeforeStart: 15,
      start: { dateTime: "2026-07-01T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-01T10:00:00", timeZone: "America/New_York" }
    }).reminderMinutes).toBeUndefined();
    expect(graphEvent(graphAccount, calendar, {
      id: "event-3", subject: "Out of range", "@odata.etag": 'W/"r3"', webLink: "https://outlook.office.com/calendar/item/3",
      isOrganizer: true, isReminderOn: true, reminderMinutesBeforeStart: 50000,
      start: { dateTime: "2026-07-01T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-01T10:00:00", timeZone: "America/New_York" }
    }).reminderMinutes).toBeUndefined();
  });
  it("connects without secrets in returned accounts and every source starts unselected", async () => {
    const vault = new MemoryVault();
    const credential: Credential = { accessToken: "sensitive", refreshToken: "refresh", expiresAt: Date.now() + 3600000, scopes: GOOGLE_SCOPES };
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      if (String(input).includes("/profile")) return response({ emailAddress: account.email });
      if (String(input).includes("/labels")) return response({ labels: [{ id: "INBOX", name: "Inbox" }] });
      return response({ items: [{ id: "primary", summary: "My calendar" }] });
    });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: fetcher, login: async () => credential });
    const result = await hub.connect("gmail", defaultSettings);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every(source => !source.selected)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(vault.get<Credential>("secrets", `provider:${account.id}`)?.accessToken).toBe("sensitive");
    expect(vault.get<Credential>("secrets", `provider:${account.id}`)?.accountId).toBe(account.id);
    await hub.disconnect(account.id);
    expect(vault.get("secrets", `provider:${account.id}`)).toBeUndefined();
  });
  it("skips unselected sync and rejects cross-account sources and Slack native drafts", async () => {
    const hub = new ConnectorHub(new MemoryVault(), async () => undefined, { fetch: vi.fn<Fetch>() });
    const onPage = vi.fn();
    await hub.sync(account, [{ ...mail, selected: false }], onPage);
    expect(onPage).not.toHaveBeenCalled();
    await expect(hub.sync(account, [folder], onPage)).rejects.toThrow("Cross-account");
    const vault = new MemoryVault(); vault.put("sources", channel.id, channel);
    await expect(new ConnectorHub(vault, async () => undefined).saveDraft(slackAccount,
      { ...message, accountId: slackAccount.id, sourceId: channel.id }, { ...draft, accountId: slackAccount.id })).rejects.toThrow("remain local");
  });
  it("rejects API operations for a read-only browser account before any network access", async () => {
    const fetcher = vi.fn<Fetch>();
    const hub = new ConnectorHub(new MemoryVault(), async () => undefined, { fetch: fetcher });
    const browserAccount: Account = { ...account, connection: "browser" };
    await expect(hub.sync(browserAccount, [mail], async () => undefined)).rejects.toThrow("read-only");
    await expect(hub.saveDraft(browserAccount, message, draft)).rejects.toThrow("read-only");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not claim connection or retain new credentials when calendar discovery fails after Google authorization", async () => {
    const vault = new MemoryVault();
    const credential: Credential = { accessToken: "sensitive", expiresAt: Date.now() + 3600000, scopes: GOOGLE_SCOPES };
    const fetcher = vi.fn<Fetch>().mockImplementation(async input => {
      if (String(input).includes("/profile")) return response({ emailAddress: account.email });
      if (String(input).includes("/labels")) return response({ labels: [{ id: "INBOX", name: "Inbox" }] });
      return response({}, 403);
    });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: fetcher, login: async () => credential });
    await expect(hub.connect("gmail", defaultSettings)).rejects.toThrow("Google Calendar API");
    expect(vault.get("secrets", `provider:${account.id}`)).toBeUndefined();
    expect(vault.all("accounts")).toEqual([]);
  });
  it("durably blocks repeat draft creation after an uncertain response", async () => {
    const vault = new MemoryVault();
    vault.put("sources", mail.id, mail);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const fetcher = vi.fn<Fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === "POST") throw new Error("disconnected after write");
      return response(nativeMail("m1"));
    });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: fetcher });
    await expect(hub.saveDraft(account, message, draft)).rejects.toBeInstanceOf(UncertainWriteError);
    await expect(new ConnectorHub(vault, async () => undefined, { fetch: fetcher }).saveDraft(account, message, draft)).rejects.toBeInstanceOf(UncertainWriteError);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(vault.all<{ accountId?: string; state?: string }>("secrets").find(value => value.state === "pending")?.accountId).toBe(account.id);
  });
  it("adds indexed account ownership to every emitted checkpoint without writing it", async () => {
    const vault = new MemoryVault(); const pages: Page[] = [];
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(response({ historyId: "100" }))
      .mockResolvedValueOnce(response({ messages: [] })).mockResolvedValueOnce(response({ historyId: "101", history: [] }));
    await new ConnectorHub(vault, async () => undefined, { fetch: fetcher }).sync(account, [mail], page => { pages.push(page); });
    expect(pages).toHaveLength(2);
    expect(pages.every(page => (page.checkpoint?.value as { accountId: string }).accountId === account.id)).toBe(true);
    expect(vault.all("checkpoints")).toEqual([]);
  });
  it("does not lock out explicit retry after a definite provider rejection", async () => {
    const vault = new MemoryVault(); vault.put("sources", mail.id, mail);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const fetcher = vi.fn<Fetch>().mockImplementation(async (_input, init) => response(init?.method === "POST" ? {} : nativeMail("m1"), init?.method === "POST" ? 403 : 200));
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: fetcher });
    await expect(hub.saveDraft(account, message, draft)).rejects.toMatchObject({ status: 403 });
    await expect(hub.saveDraft(account, message, draft)).rejects.toMatchObject({ status: 403 });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("retains uncertainty if creation succeeded but the native revision cannot be read", async () => {
    const vault = new MemoryVault(); vault.put("sources", mail.id, mail);
    vault.put<Credential>("secrets", `provider:${account.id}`, { accessToken: "access", expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] });
    const fetcher = vi.fn<Fetch>().mockImplementation(async (input, init) => {
      if (init?.method === "POST") return response({ id: "created" });
      if (String(input).includes("/drafts/")) return response({}, 404);
      return response(nativeMail("m1"));
    });
    const hub = new ConnectorHub(vault, async () => undefined, { fetch: fetcher });
    await expect(hub.saveDraft(account, message, draft)).rejects.toBeInstanceOf(UncertainWriteError);
    await expect(hub.saveDraft(account, message, draft)).rejects.toBeInstanceOf(UncertainWriteError);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("rejects attachment provider IDs that are not bound to the archived message", async () => {
    const vault = new MemoryVault(); vault.put("sources", mail.id, mail); vault.put("messages", message.id, message);
    const attachment: Attachment = { id: "a", accountId: account.id, messageId: message.id, providerId: '{"messageId":"other","attachmentId":"a"}', name: "a", mimeType: "text/plain", status: "pending" };
    vault.put("attachments", attachment.id, attachment);
    const fetcher = vi.fn<Fetch>();
    await expect(new ConnectorHub(vault, async () => undefined, { fetch: fetcher }).downloadAttachment(account, attachment)).rejects.toThrow("boundary");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
