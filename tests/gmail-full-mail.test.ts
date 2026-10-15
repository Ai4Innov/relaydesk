import { describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Message, Source } from "../src/shared/contracts";
import { ConnectorHub } from "../src/main/connectors";
import { GmailConnector, GMAIL_BASE, GOOGLE_CALENDAR_BASE, gmailMessage } from "../src/main/connectors/gmail";
import { HttpClient, source, type Fetch, type Json, type Page, type Vault } from "../src/main/connectors/core";
import type { Credential } from "../src/main/auth/oauth";

class MemoryVault implements Vault {
  private data = new Map<string, unknown>();
  get<T>(collection: Collection, key: string): T | undefined { return structuredClone(this.data.get(`${collection}/${key}`)) as T | undefined; }
  put<T>(collection: Collection, key: string, value: T): void { this.data.set(`${collection}/${key}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  delete(collection: Collection, key: string): void { this.data.delete(`${collection}/${key}`); }
}
const account: Account = { id: "gmail:reader@example.test", email: "reader@example.test", name: "Reader", provider: "gmail",
  status: "connected", consent: true, aiEnabled: false };
const browser: Account = { ...account, id: "browser:google:reader@example.test", connection: "browser" };
const inbox: Source = { ...source(account, "INBOX", "Inbox", "mail"), selected: true };
const browserSource: Source = { ...source(browser, "mail", "Gmail pages", "mail"), selected: true };
const input = { accountId: browser.id, accountEmail: browser.email, threadId: "t1", messageProviderId: "m1" };
const encode = (value: string) => Buffer.from(value).toString("base64url");
const html = '<html><body><h1>Complete message</h1><p style="color:red">All details &amp; links.</p></body></html>';
function nativeMessage(id = "m1", labels = ["INBOX", "UNREAD"]): Json {
  return { id, threadId: "t1", historyId: "7", internalDate: "1700000000123", labelIds: labels, snippet: "Preview snippet",
    payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Exact conversation" },
      { name: "From", value: "Sender <sender@example.test>" }, { name: "To", value: "reader@example.test" }],
      parts: [{ mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { attachmentId: "plain-body", size: 13 } },
        { mimeType: "text/html", body: { attachmentId: "html-body", size: Buffer.byteLength(html) } }
      ] }, { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "real-file", size: 12 } }] } };
}
function setup() {
  const vault = new MemoryVault();
  for (const item of [account, browser]) vault.put("accounts", item.id, item);
  for (const item of [inbox, browserSource]) vault.put("sources", item.id, item);
  vault.put<Credential>("secrets", `provider:${account.id}`, { accountId: account.id, accessToken: "synthetic-fixture-token",
    expiresAt: Date.now() + 3_600_000, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
  const state = { profile: account.email, thread: { id: "t1", messages: [nativeMessage()] } as Json,
    otherThreads: new Map<string, Json>(),
    listing: { threads: [{ id: "t1" }] } as Json, body: new Map<string, Json>([
      ["plain-body", { data: encode("Complete text"), size: 13 }], ["html-body", { data: encode(html), size: Buffer.byteLength(html) }],
      ["real-file", { data: encode("file-content"), size: 12 }]
    ]), after: (_url: URL) => {}, status: 200 };
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    let data: unknown;
    let status = state.status;
    if (parsed.pathname.endsWith("/profile")) data = { emailAddress: state.profile, historyId: "7" };
    else if (parsed.pathname.endsWith("/threads")) data = state.listing;
    else if (parsed.pathname.includes("/threads/")) data = parsed.pathname.endsWith("/t1")
      ? state.thread : state.otherThreads.get(parsed.pathname.split("/").at(-1)!);
    else if (parsed.pathname.includes("/attachments/")) data = state.body.get(parsed.pathname.split("/").at(-1)!);
    else if (parsed.pathname.endsWith("/messages/m1")) data = (state.thread.messages as Json[])[0];
    else if (parsed.pathname.endsWith("/messages")) data = { messages: [{ id: "m1" }] };
    else if (parsed.pathname.endsWith("/history")) data = { historyId: "7" };
    else { status = 404; data = {}; }
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.signal).toBeDefined();
    state.after(parsed);
    return new Response(JSON.stringify(data ?? {}), { status, headers: { "content-type": "application/json" } });
  });
  const hub = new ConnectorHub(vault, async () => {}, { fetch: fetcher });
  return { vault, state, fetcher, hub, read: (guard = () => {}, signal?: AbortSignal) => hub.readGmailMail(account, inbox, input, guard, signal) };
}

describe("API-first full Gmail transport", () => {
  it("hydrates HTML and plain body parts while preserving browser identities and attachment references", async () => {
    const h = setup(), guard = vi.fn();
    const capture = await h.read(guard);
    expect(capture).toMatchObject({ accountEmail: browser.email, kind: "mail", meetings: [],
      pageUrl: "https://mail.google.com/mail/?authuser=reader%40example.test#inbox/t1" });
    expect(capture.messages).toHaveLength(1);
    expect(capture.messages[0]).toMatchObject({ id: "m1", threadId: "t1", subject: "Exact conversation",
      sender: "Sender <sender@example.test>", recipients: [browser.email], body: "Complete text", html,
      receivedAt: "2023-11-14T22:13:20.123Z", dateText: "2023-11-14T22:13:20.123Z", completeness: "full",
      attachments: [{ id: JSON.stringify({ messageId: "m1", attachmentId: "real-file" }), name: "report.pdf", mimeType: "application/pdf", size: 12 }],
      attachmentManifestVersion: 1 });
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${GMAIL_BASE}users/me/profile`, `${GMAIL_BASE}users/me/threads/t1?format=full`,
      `${GMAIL_BASE}users/me/messages/m1/attachments/plain-body`, `${GMAIL_BASE}users/me/messages/m1/attachments/html-body` ]);
    expect(guard.mock.calls.length).toBeGreaterThan(8);
    expect(h.vault.all("messages")).toEqual([]);
  });

  it("accepts case-normalized email equality but verifies the actual authorized profile", async () => {
    const h = setup();
    h.state.profile = " Reader@Example.Test ";
    expect((await h.hub.readGmailMail(account, inbox, { ...input, accountEmail: " READER@example.test " }, () => {})).messages).toHaveLength(1);
    h.state.profile = "someone-else@example.test";
    h.fetcher.mockClear();
    await expect(h.read()).rejects.toThrow("mailbox identity");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["thread", "member-thread", "missing-message", "draft-message", "outside-inbox"])("rejects exact identity/scope failure: %s", async failure => {
    const h = setup();
    const messages = h.state.thread.messages as Json[];
    if (failure === "thread") h.state.thread.id = "other";
    if (failure === "member-thread") messages[0].threadId = "other";
    if (failure === "missing-message") messages[0].id = "other";
    if (failure === "draft-message") messages.push({ ...messages[0], id: "m2" }), messages[0].labelIds = ["DRAFT"];
    if (failure === "outside-inbox") messages[0].labelIds = ["SENT"];
    await expect(h.read()).rejects.toThrow(/identifier|boundary|Exact Gmail message|selected mail source/);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it("includes sent context in the exact selected conversation and excludes drafts", async () => {
    const h = setup();
    (h.state.thread.messages as Json[]).push(nativeMessage("m2", ["SENT"]), nativeMessage("m3", ["DRAFT"]));
    expect((await h.read()).messages.map(message => message.id)).toEqual(["m1", "m2"]);
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes("/messages/m3"))).toBe(false);
  });

  it("reads native API-owned messages without requiring a browser account or changing provider IDs", async () => {
    const h = setup();
    h.vault.delete("accounts", browser.id);
    const capture = await h.hub.readGmailMail(account, inbox, { ...input, accountId: account.id }, () => {});
    expect(capture.messages[0]).toMatchObject({ id: "m1", threadId: "t1", body: "Complete text", html,
      attachmentManifestVersion: 1, attachments: [{ id: JSON.stringify({ messageId: "m1", attachmentId: "real-file" }) }] });
    expect(capture.accountEmail).toBe(account.email);
  });

  it("allows a full native thread only within its exact selected mail label", async () => {
    const h = setup();
    const selected = { ...source(account, "Label_work", "Work", "mail"), selected: true };
    h.vault.put("sources", selected.id, selected);
    (h.state.thread.messages as Json[])[0].labelIds = ["Label_work"];
    const request = { ...input, accountId: account.id };
    const capture = await h.hub.readGmailMail(account, selected, request, () => {});
    expect(capture.messages[0].id).toBe("m1");
    expect(capture.pageUrl).toBe("https://mail.google.com/mail/?authuser=reader%40example.test#all/t1");
    (h.state.thread.messages as Json[])[0].labelIds = ["INBOX"];
    await expect(h.hub.readGmailMail(account, selected, request, () => {})).rejects.toThrow("selected mail source");
    h.vault.put("sources", selected.id, { ...selected, selected: false });
    h.fetcher.mockClear();
    await expect(h.hub.readGmailMail(account, selected, request, () => {})).rejects.toThrow("not selected");
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("does not permit Inbox refresh through a selected non-Inbox label", async () => {
    const h = setup(), selected = { ...source(account, "SENT", "Sent", "mail"), selected: true };
    h.vault.put("sources", selected.id, selected);
    await expect(h.hub.readGmailMail(account, selected,
      { ...input, accountId: account.id, inboxRefresh: true, messageProviderId: undefined }, () => {})).rejects.toThrow("source boundary");
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("returns native thread records with the exact sync/draft revision and native attachment IDs", async () => {
    const h = setup();
    h.vault.delete("accounts", browser.id);
    const second = nativeMessage("m2", ["SENT"]);
    second.historyId = "999";
    (h.state.thread.messages as Json[]).push(second, nativeMessage("m3", ["DRAFT"]));
    const page = await h.hub.readGmailThreadPage(account, inbox, "m1", () => {});
    expect(page.events).toEqual([]);
    expect(page.messages.map(message => message.providerId)).toEqual(["m1", "m2"]);
    expect(page.messages.map(message => message.revision)).toEqual(["7", "999"]);
    expect(page.messages[0]).toMatchObject({ id: `${account.id}:message:m1`, accountId: account.id, sourceId: inbox.id,
      threadId: `${account.id}:thread:t1`, body: "Complete text", html, historical: false });
    expect(page.messages[0].browser).toBeUndefined();
    expect(page.attachments[0]).toMatchObject({ accountId: account.id, messageId: page.messages[0].id,
      providerId: JSON.stringify({ messageId: "m1", attachmentId: "real-file" }), status: "pending" });
    expect(page.checkpoint).toBeUndefined();
  });

  it("rejects native thread-page refresh outside the selected source", async () => {
    const h = setup();
    (h.state.thread.messages as Json[])[0].labelIds = ["SENT"];
    await expect(h.hub.readGmailThreadPage(account, inbox, "m1", () => {})).rejects.toThrow("selected mail source");
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);
  });

  it("checks native thread-page caller permission and metadata identity before full reads", async () => {
    const h = setup();
    await expect(h.hub.readGmailThreadPage(account, inbox, "m1", () => { throw new Error("revoked native read"); }))
      .rejects.toThrow("revoked native read");
    expect(h.fetcher).not.toHaveBeenCalled();
    (h.state.thread.messages as Json[])[0].id = "different";
    await expect(h.hub.readGmailThreadPage(account, inbox, "m1", () => {})).rejects.toThrow("different message identifier");
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes("/threads/"))).toBe(false);
  });

  it.each(["credentials", "scope", "consent", "disconnected", "source", "source-owner", "source-kind", "source-label", "account-email", "browser-email"])(
    "blocks revoked or missing configuration before provider reads: %s", async failure => {
      const h = setup();
      if (failure === "credentials") h.vault.delete("secrets", `provider:${account.id}`);
      if (failure === "scope") h.vault.put("secrets", `provider:${account.id}`, { accessToken: "fixture", scopes: ["https://www.googleapis.com/auth/gmail.compose"] });
      if (failure === "consent") h.vault.put("accounts", account.id, { ...account, consent: false });
      if (failure === "disconnected") h.vault.put("accounts", account.id, { ...account, status: "disconnected" });
      if (failure === "source") h.vault.put("sources", inbox.id, { ...inbox, selected: false });
      if (failure === "source-owner") h.vault.put("sources", inbox.id, { ...inbox, accountId: "other" });
      if (failure === "source-kind") h.vault.put("sources", inbox.id, { ...inbox, kind: "calendar" });
      if (failure === "source-label") h.vault.put("sources", inbox.id, { ...inbox, providerId: "SENT" });
      if (failure === "account-email") h.vault.put("accounts", account.id, { ...account, email: "other@example.test" });
      if (failure === "browser-email") h.vault.put("accounts", browser.id, { ...browser, email: "other@example.test" });
      await expect(h.read()).rejects.toThrow(/authorization|selected|boundary/);
      expect(h.fetcher).not.toHaveBeenCalled();
    });

  it.each(["profile", "threads/t1", "attachments/plain-body"])("checks revocation after each asynchronous read: %s", async endpoint => {
    const h = setup();
    h.state.after = url => { if (url.pathname.endsWith(endpoint)) h.vault.put("accounts", account.id, { ...account, consent: false }); };
    await expect(h.read()).rejects.toThrow("authorization");
    expect(h.fetcher.mock.calls.at(-1)?.[0].toString()).toContain(endpoint);
  });

  it("honors the caller guard and cancellation without further network reads", async () => {
    const h = setup(), controller = new AbortController();
    controller.abort(new Error("read cancelled"));
    await expect(h.read(() => {}, controller.signal)).rejects.toThrow("read cancelled");
    await expect(h.read(() => { throw new Error("caller revoked"); })).rejects.toThrow("caller revoked");
    expect(h.fetcher).not.toHaveBeenCalled();
    const active = new AbortController();
    h.state.after = url => { if (url.pathname.includes("/threads/")) active.abort(new Error("cancelled during read")); };
    await expect(h.read(() => {}, active.signal)).rejects.toThrow("cancelled during read");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("propagates API authorization %s without retries or alternative reads", async status => {
    const h = setup(); h.state.status = status;
    await expect(h.read()).rejects.toMatchObject({ status });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves complete HTML beyond the old one-million-character truncation", async () => {
    const h = setup();
    const large = `<p>start</p><!--${"x".repeat(1_050_000)}--><p>THE END</p>`;
    const payload = (h.state.thread.messages as Json[])[0].payload as Json;
    ((((payload.parts as Json[])[0].parts as Json[])[1].body) as Json).size = large.length;
    h.state.body.set("html-body", { data: encode(large), size: large.length });
    expect((await h.read()).messages[0].html).toBe(large);
  });

  it("rejects over-budget captures explicitly instead of silently truncating", async () => {
    const h = setup();
    const payload = (h.state.thread.messages as Json[])[0].payload as Json;
    delete ((((payload.parts as Json[])[0].parts as Json[])[1].body) as Json).size;
    h.state.body.set("html-body", { data: encode("x".repeat(2 * 1024 * 1024 + 1)) });
    await expect(h.read()).rejects.toThrow("2 MB full-mail capture limit");
  });

  it.each(["missing", "empty", "invalid", "truncated"])("does not mark unreadable body hydration as full: %s", async mode => {
    const h = setup();
    h.state.body.set("html-body", mode === "missing" ? {} : { data: mode === "empty" ? "" : mode === "truncated" ? encode("short") : "@invalid@" });
    await expect(h.read()).rejects.toThrow(/body is unavailable|encoding/);
  });

  it("decodes supported MIME charsets without losing accented text", async () => {
    const h = setup(), payload = (h.state.thread.messages as Json[])[0].payload as Json;
    payload.parts = [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
      body: { data: Buffer.from([99, 97, 102, 233]).toString("base64url"), size: 4 } }];
    expect((await h.read()).messages[0].body).toBe("café");
  });

  it("does not claim a complete attachment manifest for inline data without native attachment IDs", async () => {
    const h = setup(), payload = (h.state.thread.messages as Json[])[0].payload as Json;
    (payload.parts as Json[]).push({ mimeType: "image/png", filename: "inline.png", body: { data: encode("inline"), size: 6 } });
    const result = (await h.read()).messages[0];
    expect(result.attachmentManifestVersion).toBeUndefined();
    expect(result.attachments).toHaveLength(1);
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes("real-file"))).toBe(false);
  });

  it("enumerates at most 50 Inbox threads as previews using authoritative dates", async () => {
    const h = setup();
    h.state.listing = { threads: Array.from({ length: 51 }, (_, index) => ({ id: `t${index + 1}` })), nextPageToken: "next-page" };
    for (let index = 2; index <= 51; index++)
      h.state.otherThreads.set(`t${index}`, { id: `t${index}`, messages: [{ ...nativeMessage(`m${index}`), threadId: `t${index}` }] });
    const capture = await h.hub.readGmailMail(account, inbox, { ...input, threadId: "", messageProviderId: undefined, inboxRefresh: true }, () => {});
    expect(capture.messages).toHaveLength(50);
    expect(capture.messages[0]).toMatchObject({ id: "thread:t1", threadId: "t1", body: "Preview snippet", completeness: "preview",
      receivedAt: "2023-11-14T22:13:20.123Z", dateText: "2023-11-14T22:13:20.123Z" });
    expect(capture.messages[0].html).toBeUndefined();
    const urls = h.fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[1].searchParams.get("labelIds")).toBe("INBOX");
    expect(urls[1].searchParams.get("maxResults")).toBe("50");
    expect(urls[2].searchParams.get("format")).toBe("metadata");
    expect(urls).toHaveLength(52);
    expect(urls.some(url => url.pathname.endsWith("/t51"))).toBe(false);
  });

  it("never fabricates the current time when Gmail omits the internal date", async () => {
    const h = setup(); delete (h.state.thread.messages as Json[])[0].internalDate;
    await expect(h.read()).rejects.toThrow();
  });

  it("hydrates attachment-backed bodies during ordinary Gmail API sync too", async () => {
    const h = setup(), pages: Page[] = [];
    const client = (base: string) => new HttpClient(base, async () => "fixture", h.fetcher);
    const connector = new GmailConnector(client(GMAIL_BASE), client(GOOGLE_CALENDAR_BASE), h.vault);
    await connector.sync(account, inbox, page => { pages.push(page); }, new AbortController().signal);
    expect(pages.flatMap(page => page.messages)[0]).toMatchObject({ body: "Complete text", html });
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes("real-file"))).toBe(false);
  });

  it("does not swallow a missing MIME body part as a deleted message during sync", async () => {
    const h = setup();
    const fetcher: Fetch = async (url, init) => String(url).endsWith("/attachments/html-body")
      ? new Response("{}", { status: 404 }) : h.fetcher(url, init);
    const client = (base: string) => new HttpClient(base, async () => "fixture", fetcher);
    const connector = new GmailConnector(client(GMAIL_BASE), client(GOOGLE_CALENDAR_BASE), h.vault);
    await expect(connector.sync(account, inbox, () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });
});

describe("same-account Gmail API attachment aliases", () => {
  function linked() {
    const h = setup(), origin = { accountId: account.id, sourceId: inbox.id };
    const native = gmailMessage(browser, browserSource, nativeMessage(), false);
    const message: Message = { ...native.message, gmailApi: origin, browser: { completeness: "full", capturedAt: "2026-01-01T00:00:00Z", dateText: "" } };
    const attachment: Attachment = { ...native.attachments[0], gmailApi: origin, browser: { source: "browser_gmail", metadataId: native.attachments[0].providerId } };
    h.vault.put("messages", message.id, message);
    h.vault.put("attachments", attachment.id, attachment);
    return { ...h, message, attachment, download: () => h.hub.downloadLinkedGmailAttachment(browser, attachment, account.id, inbox.id) };
  }
  it("downloads only the native ID on the stored, same-account message reference", async () => {
    const h = linked(), stream = await h.download();
    expect(await new Response(stream).text()).toBe("file-content");
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${GMAIL_BASE}users/me/profile`, `${GMAIL_BASE}users/me/messages/m1/attachments/real-file` ]);
  });
  it.each(["reference", "message", "api-account", "browser-consent", "browser-source", "api-source", "credentials"])("rejects invalid alias provenance: %s", async failure => {
    const h = linked();
    if (failure === "reference") h.attachment.providerId = JSON.stringify({ messageId: "other", attachmentId: "real-file" });
    if (failure === "message") h.vault.put("messages", h.message.id, { ...h.message, providerId: "other" });
    if (failure === "api-account") h.vault.put("accounts", account.id, { ...account, email: "other@example.test" });
    if (failure === "browser-consent") h.vault.put("accounts", browser.id, { ...browser, consent: false });
    if (failure === "browser-source") h.vault.put("sources", browserSource.id, { ...browserSource, selected: false });
    if (failure === "api-source") h.vault.put("sources", inbox.id, { ...inbox, selected: false });
    if (failure === "credentials") h.vault.delete("secrets", `provider:${account.id}`);
    await expect(h.download()).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("rechecks consent after a binary attachment read before returning the stream", async () => {
    const h = linked();
    h.state.after = url => { if (url.pathname.endsWith("/real-file")) h.vault.put("accounts", account.id, { ...account, consent: false }); };
    await expect(h.download()).rejects.toThrow("authorization");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it("reports read configuration as a boolean without returning credentials", () => {
    const h = linked();
    expect(h.hub.hasGmailReadConfiguration(account)).toBe(true);
    expect(h.hub.hasGmailReadConfiguration(browser)).toBe(false);
    h.vault.delete("secrets", `provider:${account.id}`);
    expect(h.hub.hasGmailReadConfiguration(account)).toBe(false);
  });
});
