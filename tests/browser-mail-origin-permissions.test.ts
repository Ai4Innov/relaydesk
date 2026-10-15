import { describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import { BrowserMailReader } from "../src/main/browser/mail-reader";

function fixture(cacheIdentity?: (accountId: string) => string) {
  const data = new Map<string, unknown>();
  const vault = {
    get<T>(collection: Collection, id: string): T | undefined { return structuredClone(data.get(`${collection}:${id}`)) as T | undefined; },
    put<T>(collection: Collection, id: string, value: T) { data.set(`${collection}:${id}`, structuredClone(value)); },
    all<T>(collection: Collection): T[] {
      return [...data].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => structuredClone(value) as T);
    }
  };
  const account: Account = { id: "browser", name: "Browser", email: "same@example.test", provider: "gmail",
    connection: "browser", consent: true, aiEnabled: false, status: "connected" };
  const api: Account = { ...account, id: "api", connection: undefined };
  const source: Source = { id: "mail", accountId: account.id, name: "Mail", providerId: "mail", selected: true, kind: "mail" };
  const apiSource: Source = { ...source, id: "api-mail", accountId: api.id };
  const gmailApi = { accountId: api.id, sourceId: apiSource.id };
  const preview: Message = { id: "preview", accountId: account.id, sourceId: source.id, providerId: "thread:thread", threadId: "browser:thread:thread",
    subject: "Preview", body: "Preview", sender: "sender@example.test", recipients: [], receivedAt: "", unread: true,
    historical: true, revision: "preview", url: "", browser: { completeness: "preview", capturedAt: "", dateText: "" } };
  const full: Message = { ...preview, id: "browser:message:full", providerId: "full", revision: "full", body: "Confidential API body", gmailApi,
    browser: { ...preview.browser!, completeness: "full" } };
  const attachment: Attachment = { id: "attachment", messageId: full.id, accountId: account.id,
    providerId: "file", name: "Confidential API file", status: "indexed", mimeType: "text/plain", gmailApi };
  for (const item of [account, api]) vault.put("accounts", item.id, item);
  for (const item of [source, apiSource]) vault.put("sources", item.id, item);
  vault.put("messages", preview.id, preview);
  vault.put("messages", full.id, full);
  vault.put("attachments", attachment.id, attachment);
  vault.put("checkpoints", `browser-mail:${preview.threadId}`, { accountId: account.id, sourceId: source.id, threadId: preview.threadId,
    messageIds: [full.id], revisions: { [preview.id]: preview.revision, [full.id]: full.revision }, loadedAt: "2026-09-26T00:00:00Z" });
  const payload: BrowserCapture = { accountEmail: account.email, accountName: account.name, kind: "mail",
    pageUrl: "https://mail.google.com/mail/u/0/#inbox/thread", meetings: [],
    messages: [{ id: "full", threadId: "thread", subject: full.subject, body: full.body, sender: full.sender, recipients: [], unread: false,
      dateText: "", url: "", completeness: "full" }] };
  const bridge = { readMailThread: vi.fn(async () => payload), cacheIdentity };
  const capture = vi.fn(async () => undefined);
  const reader = new BrowserMailReader(vault, bridge, capture, () => false, () => false, () => 0);
  return { vault, account, api, source, apiSource, gmailApi, preview, full, attachment, payload, bridge, capture, reader };
}

describe("browser mail API-origin cache protection", () => {
  it("invalidates legacy and previous-route caches and persists the new transport identity", async () => {
    let identity = "playwright:";
    const f = fixture(() => identity);
    expect(f.reader.hasCachedThread(f.preview)).toBe(false);
    expect(await f.reader.load(f.preview.id)).toMatchObject({ cached: false });
    expect(f.vault.get("checkpoints", `browser-mail:${f.preview.threadId}`)).toMatchObject({ transportIdentity: identity });
    expect(f.reader.hasCachedThread(f.preview)).toBe(true);
    expect(await f.reader.load(f.preview.id)).toMatchObject({ cached: true });
    identity = "gmail-api:api";
    expect(f.reader.hasCachedThread(f.preview)).toBe(false);
    expect(await f.reader.load(f.preview.id)).toMatchObject({ cached: false });
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(f.vault.get("checkpoints", `browser-mail:${f.preview.threadId}`)).toMatchObject({ transportIdentity: identity });
  });

  it("never serves an API cache when its preferred transport becomes unavailable", async () => {
    let identity = "gmail-api:api";
    const f = fixture(() => identity);
    await f.reader.load(f.preview.id);
    identity = "unavailable:";
    f.bridge.readMailThread.mockRejectedValue(new Error("API route unavailable"));
    expect(f.reader.hasCachedThread(f.preview)).toBe(false);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("API route unavailable");
    expect(f.vault.get("checkpoints", `browser-mail:${f.preview.threadId}`)).toMatchObject({ transportIdentity: "gmail-api:api" });
  });

  it("discards an in-flight response instead of caching it under a changed route", async () => {
    let identity = "playwright:";
    const f = fixture(() => identity);
    f.bridge.readMailThread.mockImplementation(async () => { identity = "gmail-api:api"; return f.payload; });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("revoked or changed");
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.reader.hasCachedThread(f.preview)).toBe(false);
  });

  it("allows local cached API-origin mail and attachments with both AI toggles off", async () => {
    const f = fixture();
    expect(f.reader.hasCachedThread(f.preview)).toBe(true);
    expect(await f.reader.load(f.preview.id)).toMatchObject({ cached: true, messages: [f.full], attachments: [f.attachment] });
    expect(f.bridge.readMailThread).not.toHaveBeenCalled();
  });

  it.each(["consent", "source", "identity", "owner"] as const)("rejects cached message content after %s revocation", async field => {
    const f = fixture();
    if (field === "source") f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    else if (field === "owner") f.vault.put("accounts", f.account.id, { ...f.account, consent: false });
    else f.vault.put("accounts", f.api.id, { ...f.api, ...(field === "identity" ? { email: "other@example.test" } : { consent: false }) });
    expect(f.reader.hasCachedThread(f.preview)).toBe(false);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow(/revoked|incomplete/);
    expect(f.bridge.readMailThread).not.toHaveBeenCalled();
  });

  it("omits revoked API-origin attachments when their parent is a genuine browser message", async () => {
    const f = fixture();
    f.vault.put("messages", f.full.id, { ...f.full, gmailApi: undefined });
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    const result = await f.reader.load(f.preview.id);
    expect(result.messages).toHaveLength(1);
    expect(result.attachments).toEqual([]);
  });

  it("validates the current requested record even when the caller supplies stale cache members", async () => {
    const f = fixture();
    f.vault.put("messages", f.preview.id, { ...f.preview, gmailApi: f.gmailApi });
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(f.reader.hasCachedThread(f.preview, [f.preview])).toBe(false);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("revoked");
  });

  it("rechecks both coalesced readers after API consent changes during a read", async () => {
    const f = fixture();
    let release!: (input: BrowserCapture) => void;
    f.bridge.readMailThread.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = f.reader.load(f.preview.id, true);
    const second = f.reader.load(f.preview.id, true);
    const outcomes = Promise.allSettled([first, second]);
    f.vault.put("accounts", f.api.id, { ...f.api, consent: false });
    release(f.payload);
    expect((await outcomes).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.bridge.readMailThread).toHaveBeenCalledOnce();
  });
});
