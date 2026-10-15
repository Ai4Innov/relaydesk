import { describe, expect, it, vi } from "vitest";
import type { Account, Collection, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { Vault } from "../src/main/storage/vault";
import { BrowserArchive, browserAccountId } from "../src/main/browser/archive";
import { BrowserMailReader } from "../src/main/browser/mail-reader";
import { commandSchema } from "../src/main/ipc/schema";

class MemoryVault {
  data = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined { return this.data.get(`${collection}/${id}`) as T | undefined; }
  put(collection: Collection, id: string, value: unknown) { this.data.set(`${collection}/${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  transaction<T>(work: () => T): T { return work(); }
}

const email = "reader@example.org";
const accountId = browserAccountId(email);
const sourceId = `${accountId}:mail`;
const namespace = (thread: string) => `${accountId}:thread:${encodeURIComponent(thread)}`;
function payload(threadId = "thread-A", full = false): BrowserCapture {
  return {
    accountEmail: email, accountName: "Reader", kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox", meetings: [],
    messages: full ? [1, 2].map(index => ({
      id: `${threadId}-message-${index}`, threadId, subject: "Project review", sender: `author${index}@example.org`,
      recipients: [email], body: `Complete message ${index}\nAll details, not an inbox snippet.`,
      html: `<p>Complete <strong>message ${index}</strong></p><table><tr><td>All details</td></tr></table>`,
      dateText: "Today", receivedAt: `2026-09-23T0${index}:00:00Z`,
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`, unread: false, completeness: "full" as const,
      attachments: index === 2 ? [{ id: "file-1", name: "Review.pdf", mimeType: "application/pdf", size: 1234 }] : [],
    })) : [{
      id: `thread:${threadId}`, threadId, subject: "Project review", sender: "author@example.org", recipients: [email],
      body: "Only the inbox snippet", dateText: "Today", url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      unread: true, completeness: "preview",
    }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const vault = new MemoryVault();
  const flags = { paused: false, maintenance: false, epoch: 0 };
  const index = vi.fn(async (_message: Message) => undefined);
  const archive = new BrowserArchive(vault as unknown as Vault, index, vi.fn(), () => flags.paused);
  archive.discover(payload());
  vault.put("sources", sourceId, { ...vault.get<Source>("sources", sourceId), selected: true });
  const addPreview = async (thread = "thread-A") => {
    await archive.capture(payload(thread));
    return vault.all<Message>("messages").find(message => message.providerId === `thread:${thread}`)!;
  };
  const preview = await addPreview();
  const bridge = { readMailThread: vi.fn(async (_input: { accountId: string; accountEmail: string; threadId: string; messageProviderId?: string }, beforeRead: () => void) => {
    beforeRead();
    return payload(_input.threadId, true);
  }) };
  const capture = vi.fn((input: BrowserCapture) => archive.capture(input));
  const reader = new BrowserMailReader(vault, bridge, capture, () => flags.maintenance, () => flags.paused, () => flags.epoch);
  return { vault, flags, index, archive, preview, bridge, capture, reader, addPreview };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function changeAccount(f: Fixture, patch: Partial<Account>) {
  f.vault.put("accounts", accountId, { ...f.vault.get<Account>("accounts", accountId), ...patch });
}
function changeSource(f: Fixture, patch: Partial<Source>) {
  f.vault.put("sources", sourceId, { ...f.vault.get<Source>("sources", sourceId), ...patch });
}
function changePreview(f: Fixture, patch: Partial<Message>) {
  f.vault.put("messages", f.preview.id, { ...f.vault.get<Message>("messages", f.preview.id), ...patch });
}

describe("full browser email reading with the real local archive", () => {
  it("reads only the exact account/thread with AI off and persists full HTML, attachments and the independent preview", async () => {
    const f = await setup();
    const result = await f.reader.load(f.preview.id);
    expect(f.bridge.readMailThread).toHaveBeenCalledWith(
      { accountId, accountEmail: email, threadId: "thread-A" }, expect.any(Function));
    expect(result).toMatchObject({ accountId, sourceId, threadId: namespace("thread-A"), cached: false });
    expect(result.loadedAt).toEqual(expect.any(String));
    expect(result.messages).toHaveLength(2);
    const input = payload("thread-A", true);
    for (const [position, message] of result.messages.entries()) {
      expect(message).toMatchObject({
        id: `${accountId}:message:${input.messages[position].id}`, accountId, sourceId,
        threadId: namespace("thread-A"), providerId: input.messages[position].id,
        body: input.messages[position].body, html: input.messages[position].html,
        recipients: [email], browser: { completeness: "full", position },
      });
      expect(new URL(message.url).searchParams.get("authuser")).toBe(email);
      expect(f.vault.get("messages", message.id)).toEqual(message);
    }
    expect(result.attachments).toMatchObject([{
      accountId, messageId: result.messages[1].id, providerId: "file-1", name: "Review.pdf",
      mimeType: "application/pdf", size: 1234, browser: { source: "browser_gmail", metadataId: "file-1" },
    }]);
    expect(f.vault.all("attachments")).toEqual(result.attachments);
    expect(f.vault.get("messages", f.preview.id)).toEqual(f.preview);
    expect(f.vault.all("messages")).toHaveLength(3);
    expect(f.vault.get<Account>("accounts", accountId)?.aiEnabled).toBe(false);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.index).toHaveBeenCalledTimes(3);
  });

  it("passes an explicit message provider ID only for a concrete message, not a thread placeholder", async () => {
    const f = await setup();
    changePreview(f, { providerId: "explicit-message-123" });
    await f.reader.load(f.preview.id);
    expect(f.bridge.readMailThread.mock.calls[0][0]).toEqual({
      accountId, accountEmail: email, threadId: "thread-A", messageProviderId: "explicit-message-123",
    });
  });

  it("normalizes the verified capture email without mixing other accounts, sources or threads into the response", async () => {
    const f = await setup(), input = payload("thread-A", true);
    input.accountEmail = " READER@EXAMPLE.ORG ";
    f.bridge.readMailThread.mockResolvedValue(input);
    f.vault.put("messages", "other", { ...f.preview, id: "other", accountId: "other-account", browser: { ...f.preview.browser, completeness: "full" } });
    f.vault.put("messages", "other-source", { ...f.preview, id: "other-source", sourceId: "other-source", browser: { ...f.preview.browser, completeness: "full" } });
    f.vault.put("attachments", "other-file", { id: "other-file", accountId: "other-account", messageId: `${accountId}:message:thread-A-message-1` });
    await f.addPreview("thread-B");
    const result = await f.reader.load(f.preview.id);
    expect(result.messages.map(message => message.providerId)).toEqual(["thread-A-message-1", "thread-A-message-2"]);
    expect(result.attachments.map(attachment => attachment.providerId)).toEqual(["file-1"]);
  });

  it.each([
    ["wrong account", (input: BrowserCapture) => { input.accountEmail = "other@example.org"; }],
    ["wrong thread", (input: BrowserCapture) => { input.messages[1].threadId = "thread-B"; }],
    ["preview mixed into full messages", (input: BrowserCapture) => { input.messages[1].completeness = "preview"; }],
    ["empty conversation", (input: BrowserCapture) => { input.messages = []; }],
    ["wrong provider kind", (input: BrowserCapture) => { input.kind = "calendar"; }],
    ["unexpected meetings", (input: BrowserCapture) => { input.meetings = [{ id: "event", title: "Meeting", whenText: "Today", description: "", location: "", meetingUrl: "", url: input.pageUrl }]; }],
    ["duplicate provider IDs", (input: BrowserCapture) => { input.messages[1].id = input.messages[0].id; }],
  ] as const)("rejects %s before any capture", async (_name, corrupt) => {
    const f = await setup(), input = payload("thread-A", true);
    corrupt(input); f.bridge.readMailThread.mockResolvedValue(input);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("different or incomplete conversation");
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.vault.all("messages")).toEqual([f.preview]);
    expect(f.vault.all("attachments")).toEqual([]);
    expect(f.vault.all("checkpoints")).toEqual([]);
  });

  it.each([
    "other-account:thread:thread-A", `${accountId}:thread:`, `${accountId}:thread:%ZZ`,
    `${accountId}:thread:bad%2Fpath`, `${accountId}:thread:https%3A%2F%2Fevil.invalid`,
    `${accountId}:thread:${"a".repeat(257)}`,
  ])("rejects malformed namespaced thread %s without calling the bridge", async threadId => {
    const f = await setup(); changePreview(f, { threadId });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("thread identity is invalid");
    expect(f.bridge.readMailThread).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  });

  it("rejects unknown IDs and non-browser messages without external navigation", async () => {
    const f = await setup();
    await expect(f.reader.load("https://evil.invalid/thread")).rejects.toThrow("not in the local archive");
    changePreview(f, { browser: undefined });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("not in the local archive");
    expect(f.bridge.readMailThread).not.toHaveBeenCalled();
  });

  const revoked: Array<[string, (f: Fixture) => void]> = [
    ["account consent", f => changeAccount(f, { consent: false })],
    ["account disconnected", f => changeAccount(f, { status: "disconnected" })],
    ["account provider", f => changeAccount(f, { provider: "microsoft" })],
    ["account connection", f => changeAccount(f, { connection: "api" })],
    ["source selection", f => changeSource(f, { selected: false })],
    ["source account", f => changeSource(f, { accountId: "other" })],
    ["source kind", f => changeSource(f, { kind: "calendar" })],
    ["message deleted", f => changePreview(f, { deleted: true })],
    ["missing account", f => { f.vault.data.delete(`accounts/${accountId}`); }],
    ["missing source", f => { f.vault.data.delete(`sources/${sourceId}`); }],
    ["startup/shutdown maintenance", f => { f.flags.maintenance = true; }],
  ];
  it.each(revoked)("rejects %s at load start, including when full content is cached", async (_name, revoke) => {
    const f = await setup();
    await f.reader.load(f.preview.id);
    f.bridge.readMailThread.mockClear(); f.capture.mockClear(); revoke(f);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("revoked or changed");
    expect(f.bridge.readMailThread).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  });

  it.each([
    ...revoked,
    ["permission epoch changed then re-enabled", (f: Fixture) => { f.flags.epoch++; }],
    ["selected message account changed", (f: Fixture) => changePreview(f, { accountId: "other" })],
    ["selected message source changed", (f: Fixture) => changePreview(f, { sourceId: "other" })],
    ["selected message thread changed", (f: Fixture) => changePreview(f, { threadId: namespace("thread-B") })],
    ["selected message provider ID changed", (f: Fixture) => changePreview(f, { providerId: "other" })],
  ] satisfies Array<[string, (f: Fixture) => void]>)("rejects a late browser response after %s without capture", async (_name, revoke) => {
    const f = await setup(), pending = deferred<BrowserCapture>();
    f.bridge.readMailThread.mockReturnValue(pending.promise);
    const work = f.reader.load(f.preview.id);
    const check = expect(work).rejects.toThrow("revoked or changed");
    revoke(f); pending.resolve(payload("thread-A", true));
    await check;
    expect(f.capture).not.toHaveBeenCalled(); expect(f.vault.all("checkpoints")).toEqual([]);
  });

  it("provides the bridge a live permission guard, and also rechecks after asynchronous capture", async () => {
    const f = await setup();
    f.bridge.readMailThread.mockImplementation(async (_input, guard) => { f.flags.epoch++; guard(); return payload("thread-A", true); });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("revoked or changed");
    expect(f.capture).not.toHaveBeenCalled();
    f.bridge.readMailThread.mockResolvedValue(payload("thread-A", true));
    f.capture.mockImplementation(async input => { const imported = await f.archive.capture(input); f.flags.epoch++; return imported; });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("revoked or changed");
    expect(f.vault.all("checkpoints")).toEqual([]);
  });

  it("blocks uncached and forced reads during pause, allows cached local reads, and discards a response paused mid-flight", async () => {
    const f = await setup(); f.flags.paused = true;
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("paused");
    expect(f.bridge.readMailThread).not.toHaveBeenCalled();
    f.flags.paused = false;
    const result = await f.reader.load(f.preview.id);
    f.flags.paused = true;
    expect(await f.reader.load(f.preview.id)).toEqual({ ...result, cached: true });
    await expect(f.reader.load(f.preview.id, true)).rejects.toThrow("paused");
    f.flags.paused = false;
    const pending = deferred<BrowserCapture>(); f.bridge.readMailThread.mockReturnValue(pending.promise);
    const work = f.reader.load(f.preview.id, true), check = expect(work).rejects.toThrow("paused");
    f.flags.paused = true; pending.resolve(payload("thread-A", true)); await check;
    expect(f.capture).toHaveBeenCalledTimes(1);
  });

  it("reuses exactly the cached full messages and attachments, deduplicates repeat reads and supports explicit refresh", async () => {
    const f = await setup(), pending = deferred<BrowserCapture>();
    f.bridge.readMailThread.mockReturnValueOnce(pending.promise);
    const first = f.reader.load(f.preview.id), repeated = f.reader.load(f.preview.id);
    expect(f.bridge.readMailThread).toHaveBeenCalledOnce();
    pending.resolve(payload("thread-A", true));
    const [a, b] = await Promise.all([first, repeated]);
    expect(a).toEqual(b);
    expect(await f.reader.load(f.preview.id)).toEqual({ ...a, cached: true });
    expect(f.bridge.readMailThread).toHaveBeenCalledOnce();
    expect(f.capture).toHaveBeenCalledOnce();
    expect((await f.reader.load(f.preview.id, true)).cached).toBe(false);
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(2);
    expect(f.vault.all("messages")).toHaveLength(3); expect(f.vault.all("attachments")).toHaveLength(1);
  });

  it("invalidates cache when full-message attachment metadata changes and includes newly captured messages", async () => {
    const f = await setup(); await f.reader.load(f.preview.id);
    const changed = payload("thread-A", true);
    changed.messages[1].attachments!.push({ id: "file-2", name: "Followup.txt", mimeType: "text/plain" });
    await f.archive.capture(changed);
    f.bridge.readMailThread.mockResolvedValue(changed);
    expect((await f.reader.load(f.preview.id)).attachments).toHaveLength(2);
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(2);
    const added = { ...changed.messages[1], id: "new-message", body: "New reply" };
    await f.archive.capture({ ...changed, messages: [added] });
    changed.messages.push(added); f.bridge.readMailThread.mockResolvedValue(changed);
    expect((await f.reader.load(f.preview.id)).messages).toHaveLength(3);
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(3);
  });

  it("never returns a cached full message that was removed or moved to a different source", async () => {
    const f = await setup(), result = await f.reader.load(f.preview.id);
    f.vault.data.delete(`messages/${result.messages[0].id}`);
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("cache is incomplete");
    expect((await f.reader.load(f.preview.id, true)).messages).toHaveLength(2);
    f.vault.put("messages", result.messages[0].id, { ...result.messages[0], sourceId: "other" });
    await expect(f.reader.load(f.preview.id)).rejects.toThrow("cache is incomplete");
  });

  it("bounds three queued threads, serializes browser reads, permits duplicates, and frees slots after success and failure", async () => {
    const f = await setup();
    const previews = [f.preview, await f.addPreview("thread-B"), await f.addPreview("thread-C"), await f.addPreview("thread-D")];
    const waiting = new Map<string, ReturnType<typeof deferred<BrowserCapture>>>();
    f.bridge.readMailThread.mockImplementation(input => { const item = deferred<BrowserCapture>(); waiting.set(input.threadId, item); return item.promise; });
    const first = f.reader.load(previews[0].id), duplicate = f.reader.load(previews[0].id);
    const second = f.reader.load(previews[1].id), third = f.reader.load(previews[2].id);
    const failed = expect(second).rejects.toThrow("Browser tab closed");
    await expect(f.reader.load(previews[3].id)).rejects.toThrow("Three emails");
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(1);
    waiting.get("thread-A")!.resolve(payload("thread-A", true));
    await Promise.all([first, duplicate]);
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(2);
    waiting.get("thread-B")!.reject(new Error("Browser tab closed")); await failed;
    const fourth = f.reader.load(previews[3].id);
    const retry = f.reader.load(previews[1].id);
    waiting.get("thread-C")!.resolve(payload("thread-C", true)); await third;
    waiting.get("thread-D")!.resolve(payload("thread-D", true)); await fourth;
    waiting.get("thread-B")!.resolve(payload("thread-B", true)); await retry;
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(5);
    expect(f.capture).toHaveBeenCalledTimes(4);
  });

  it("propagates bridge and archive/index failures, leaves no cache, and allows retry", async () => {
    const f = await setup(), browserError = new Error("Paired browser unavailable");
    f.bridge.readMailThread.mockRejectedValueOnce(browserError);
    await expect(f.reader.load(f.preview.id)).rejects.toBe(browserError);
    expect(f.capture).not.toHaveBeenCalled();
    const indexError = new Error("Local index unavailable");
    f.index.mockRejectedValueOnce(indexError);
    await expect(f.reader.load(f.preview.id)).rejects.toBe(indexError);
    expect(f.vault.all("checkpoints")).toEqual([]);
    expect((await f.reader.load(f.preview.id)).messages).toHaveLength(2);
    expect(f.bridge.readMailThread).toHaveBeenCalledTimes(3);
  });
});

describe("full email IPC command boundary", () => {
  it("accepts only a local message ID and optional boolean refresh", () => {
    expect(commandSchema.parse({ type: "message.load", messageId: "local-message" })).toEqual({ type: "message.load", messageId: "local-message" });
    expect(commandSchema.safeParse({ type: "message.load", messageId: "local-message", refresh: true }).success).toBe(true);
    for (const extra of [{ url: "https://evil.invalid" }, { threadId: "other" }, { accountId: "other" }, { refresh: "yes" }]) {
      expect(commandSchema.safeParse({ type: "message.load", messageId: "local-message", ...extra }).success).toBe(false);
    }
    expect(commandSchema.safeParse({ type: "message.load", url: "https://evil.invalid" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "message.load", messageId: "" }).success).toBe(false);
  });
});
