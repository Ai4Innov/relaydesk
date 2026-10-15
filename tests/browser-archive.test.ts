import { describe, expect, it, vi } from "vitest";
import type { Collection, Account, Source, Message } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { Vault } from "../src/main/storage/vault";
import { BrowserArchive, browserAccountId } from "../src/main/browser/archive";

class MemoryVault {
  data = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined { return this.data.get(`${collection}/${id}`) as T | undefined; }
  put(collection: Collection, id: string, value: unknown) { this.data.set(`${collection}/${id}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => structuredClone(value) as T); }
  transaction<T>(work: () => T): T { return work(); }
}
function capture(email = "first@example.org"): BrowserCapture {
  return { accountEmail: email, accountName: "Work", kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox",
    messages: [{ id: "same-provider-id", threadId: "thread", subject: "Synthetic", sender: "sender@example.org", recipients: [],
      body: "A private preview", dateText: "Yesterday", url: "https://mail.google.com/mail/u/0/#inbox/thread", unread: true, completeness: "preview" }],
    meetings: [] };
}
function setup() {
  const vault = new MemoryVault(), index = vi.fn(async (_message: Message) => undefined), paused = vi.fn(() => false);
  const archive = new BrowserArchive(vault as unknown as Vault, index, vi.fn(), paused);
  const enable = (email: string, kind = "mail") => {
    const id = `${browserAccountId(email)}:${kind}`;
    vault.put("sources", id, { ...vault.get<Source>("sources", id), selected: true });
  };
  return { vault, archive, index, paused, enable };
}
describe("browser archive account and consent boundaries", () => {
  it("stores the original Gmail tooltip date and preserves it when a later capture lacks a date", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture();
    payload.messages[0].dateText = "Wed, Sep 23, 2026, 5:10\u202fPM";
    archive.discover(payload); enable(payload.accountEmail); await archive.capture(payload);
    const original = vault.all<Message>("messages")[0];
    expect(original.receivedAt).toBe(new Date(2026, 8, 23, 17, 10).toISOString());
    payload.messages[0].dateText = "Today";
    await archive.capture(payload);
    expect(vault.all<Message>("messages")[0].receivedAt).toBe(original.receivedAt);
    expect(vault.all<Message>("messages")[0].revision).toBe(original.revision);
  });
  it("refuses empty unpainted previews before overwriting previously captured text", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture();
    archive.discover(payload); enable(payload.accountEmail); await archive.capture(payload);
    const original = vault.all<Message>("messages")[0];
    payload.messages[0].subject = ""; payload.messages[0].body = " ";
    await expect(archive.capture(payload)).rejects.toThrow("no readable text");
    expect(vault.all<Message>("messages")[0]).toEqual(original);
  });
  it("preserves Gmail markup across previews and does not stale drafts for presentation-only updates", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture();
    Object.assign(payload.messages[0], { completeness: "full", html: "<p>Full <b>message</b></p>" });
    archive.discover(payload); enable(payload.accountEmail); await archive.capture(payload);
    const original = vault.all<Message>("messages")[0];
    vault.put("drafts", "html-draft", { id: "html-draft", messageId: original.id, status: "local" });
    payload.messages[0].html = "<article>Full <strong>message</strong></article>";
    expect(await archive.capture(payload)).toHaveLength(0);
    await archive.capture(capture());
    const current = vault.all<Message>("messages")[0];
    expect(current.html).toBe(payload.messages[0].html);
    expect(current.revision).toBe(original.revision);
    expect(vault.get<{ status: string }>("drafts", "html-draft")?.status).toBe("local");
  });
  it("requires WhatsApp account consent and independent per-chat selection without enabling AI", async () => {
    const { archive, vault } = setup();
    const input: BrowserCapture = { accountEmail: "+33612345678", accountName: "WhatsApp +33612345678",
      pageUrl: "https://web.whatsapp.com/", kind: "whatsapp", chat: { id: "33699999999@c.us", name: "Alice" },
      messages: [{ id: "false_33699999999@c.us_ABC", threadId: "33699999999@c.us", subject: "Alice",
        sender: "Alice", recipients: ["+33612345678"], body: "A visible message", dateText: "09:20, 23/09/2026",
        url: "https://web.whatsapp.com/", unread: false, completeness: "full" }], meetings: [] };
    const access = archive.discover(input);
    const account = vault.get<Account>("accounts", access.accountId)!;
    expect(account).toMatchObject({ provider: "whatsapp", consent: false, aiEnabled: false, email: "+33612345678" });
    expect(access.enabled).toBe(false);
    const source = vault.all<Source>("sources")[0];
    expect(source).toMatchObject({ selected: false, kind: "channel", providerId: input.chat!.id });
    vault.put("sources", source.id, { ...source, selected: true });
    await expect(archive.capture(input)).rejects.toThrow("Connect");
    vault.put("accounts", account.id, { ...account, consent: true });
    expect(await archive.capture(input)).toHaveLength(1);
    expect(vault.all<Message>("messages")[0].url).toBe("https://web.whatsapp.com/");
    const other = { ...input, chat: { id: "447700900123@c.us", name: "Alice" } };
    archive.discover(other);
    await expect(archive.capture(other)).rejects.toThrow();
    expect(vault.all<Source>("sources")).toHaveLength(2);
    expect(vault.get<Account>("accounts", account.id)?.aiEnabled).toBe(false);
    archive.discover({ ...input, accountEmail: "+447700900111" });
    expect(vault.all<Account>("accounts")).toHaveLength(2);
  });
  it("refreshes unread/freshness metadata without losing full text or invalidating a reviewed draft", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture();
    payload.messages[0].completeness = "full";
    payload.messages[0].body = "Complete loaded text";
    archive.discover(payload); enable(payload.accountEmail); await archive.capture(payload);
    const original = vault.all<Message>("messages")[0];
    vault.put("drafts", "draft", { id: "draft", messageId: original.id, status: "local" });
    const preview = capture(); preview.messages[0].unread = false; preview.messages[0].dateText = "Tuesday";
    await archive.capture(preview);
    const refreshed = vault.all<Message>("messages")[0];
    expect(refreshed.body).toBe("Complete loaded text");
    expect(refreshed.unread).toBe(false);
    expect(refreshed.browser).toMatchObject({ completeness: "full", dateText: "Tuesday", position: 0 });
    expect(refreshed.revision).toBe(original.revision);
    expect(vault.get<{ status: string }>("drafts", "draft")?.status).toBe("local");
    expect(vault.get<Source>("sources", refreshed.sourceId)?.lastSync).toBe(refreshed.browser?.capturedAt);
  });
  it("records the latest inbox row order for newly arrived undated previews", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture();
    archive.discover(payload); enable(payload.accountEmail); await archive.capture(payload);
    payload.messages.unshift({ ...payload.messages[0], id: "new-arrival", body: "New inbox preview" });
    await archive.capture(payload);
    expect(vault.all<Message>("messages").find(item => item.providerId === "new-arrival")?.browser?.position).toBe(0);
    expect(vault.all<Message>("messages").find(item => item.providerId === "same-provider-id")?.browser?.position).toBe(1);
  });
  it("discovers multiple identities separately and never treats numeric account slots as identities", () => {
    const { archive, vault } = setup();
    archive.discover(capture());
    archive.discover({ ...capture("second@example.org"), pageUrl: "https://mail.google.com/mail/u/0/#inbox" });
    archive.discover({ ...capture("FIRST@example.org"), pageUrl: "https://calendar.google.com/calendar/u/2/r/agenda", kind: "calendar" });
    expect(vault.all<Account>("accounts")).toHaveLength(2);
    expect(vault.all<Source>("sources")).toHaveLength(4);
    expect(vault.all<Source>("sources").every(source => !source.selected)).toBe(true);
    expect(vault.all<Account>("accounts").every(account => !account.aiEnabled && account.connection === "browser")).toBe(true);
  });
  it("does not import unselected accounts or sources, and respects pause", async () => {
    const { archive, vault, index, enable, paused } = setup();
    await expect(archive.capture(capture())).rejects.toThrow("Connect");
    archive.discover(capture());
    await expect(archive.capture(capture())).rejects.toThrow("Select");
    enable("first@example.org"); paused.mockReturnValue(true);
    await expect(archive.capture(capture())).rejects.toThrow("paused");
    expect(vault.all("messages")).toEqual([]); expect(index).not.toHaveBeenCalled();
  });
  it("namespaces identical message identifiers by account and preserves unknown dates honestly", async () => {
    const { archive, vault, enable } = setup();
    for (const email of ["first@example.org", "second@example.org"]) {
      archive.discover(capture(email)); enable(email); await archive.capture(capture(email));
    }
    const messages = vault.all<Message>("messages");
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map(message => message.id)).size).toBe(2);
    expect(messages.every(message => message.receivedAt === "" && message.historical)).toBe(true);
    expect(messages[0].browser?.dateText).toBe("Yesterday");
    expect(new URL(messages[0].url).searchParams.get("authuser")).toBe("first@example.org");
    expect(new URL(messages[1].url).searchParams.get("authuser")).toBe("second@example.org");
    expect(messages.every(message => !new URL(message.url).pathname.includes("/u/0"))).toBe(true);
  });
  it("does not downgrade full text to a preview or repeatedly triage unchanged content", async () => {
    const { archive, vault, enable } = setup();
    const payload = capture(); payload.messages[0].completeness = "full";
    payload.messages[0].body = "Complete loaded text";
    archive.discover(payload); enable(payload.accountEmail);
    expect(await archive.capture(payload)).toHaveLength(1);
    expect(await archive.capture(payload)).toHaveLength(0);
    await archive.capture(capture());
    expect(vault.all<Message>("messages")[0].body).toBe("Complete loaded text");
  });
  it("captures meetings without invented exact times and keeps meeting IDs account-scoped", async () => {
    const { archive, vault, enable } = setup();
    for (const email of ["first@example.org", "second@example.org"]) {
      const payload: BrowserCapture = { ...capture(email), kind: "calendar", pageUrl: "https://calendar.google.com/calendar/u/0/r/agenda",
        messages: [], meetings: [{ id: "event", title: "Planning", whenText: "Tomorrow 9am", description: "", location: "",
          url: "https://calendar.google.com/calendar/u/0/r/agenda", meetingUrl: "https://meet.google.com/abc-defg-hij" }] };
      archive.discover(payload); enable(email, "calendar"); await archive.capture(payload);
    }
    expect(vault.all("browserItems")).toHaveLength(2); expect(vault.all("events")).toEqual([]);
  });
  it("does not silently reconnect a disconnected account", () => {
    const { archive, vault } = setup(); archive.discover(capture());
    const id = browserAccountId("first@example.org");
    vault.put("accounts", id, { ...vault.get<Account>("accounts", id), status: "disconnected" });
    expect(() => archive.discover(capture())).toThrow("disconnected");
  });
  it("stops a capture when its source is excluded during asynchronous indexing", async () => {
    const { archive, vault, index, enable } = setup();
    const payload = capture();
    payload.messages.push({ ...payload.messages[0], id: "second-message" });
    archive.discover(payload); enable(payload.accountEmail);
    index.mockImplementation(async () => {
      const id = `${browserAccountId(payload.accountEmail)}:mail`;
      vault.put("sources", id, { ...vault.get<Source>("sources", id), selected: false });
    });
    await expect(archive.capture(payload)).rejects.toThrow("excluded during capture");
    expect(vault.all("messages")).toHaveLength(1);
  });
});
