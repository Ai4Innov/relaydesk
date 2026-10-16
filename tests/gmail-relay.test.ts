import { describe, expect, it, vi } from "vitest";
import type { Account, Collection, Source } from "../src/shared/contracts";
import { GmailRelayConnector, GmailRelayTransport, GMAIL_RELAY_PROVIDER_ID, validateGmailRelayUrl, type GmailRelaySecret } from "../src/main/connectors/gmail-relay";
import type { Fetch, Vault, Page } from "../src/main/connectors";
import { id } from "../src/main/connectors/core";

class MemoryVault implements Vault {
  data = new Map<string, unknown>();
  get<T>(collection: Collection, key: string): T | undefined { return structuredClone(this.data.get(`${collection}:${key}`)) as T | undefined; }
  put<T>(collection: Collection, key: string, value: T): void { this.data.set(`${collection}:${key}`, structuredClone(value)); }
  all<T>(collection: Collection): T[] { return [...this.data].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => structuredClone(value) as T); }
  delete(collection: Collection, key: string): void { this.data.delete(`${collection}:${key}`); }
}
const account: Account = { id: "gmail:me@example.com", provider: "gmail", name: "Me", email: "me@example.com", status: "connected", consent: true, aiEnabled: false, connection: "relay" };
const source: Source = { id: id(account.id, "mail", GMAIL_RELAY_PROVIDER_ID), accountId: account.id, providerId: GMAIL_RELAY_PROVIDER_ID, name: "Apps Script relay", kind: "mail", selected: true };
const secret: GmailRelaySecret = { url: "https://script.google.com/macros/s/abc/exec", token: "secret-token", mailbox: "me@example.com", pollIntervalMinutes: 5 };
function json(data: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(data), { status, headers }); }
function eml(subject = "Hello") { return Buffer.from(`From: Sender <sender@example.com>\r\nTo: Me <me@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <m@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text`, "utf8"); }
function manifest(messageId = "m1", rawSize = eml().length) {
  return { schemaVersion: 1, status: "complete", gmailMessageId: messageId, gmailThreadId: "t1", mailbox: "me@example.com", internalDateMs: 1700000000000,
    headers: [{ name: "Subject", value: "Hello" }], labelIds: ["INBOX"], historyId: "h1", raw: { filename: "message.eml", driveFileId: `raw-${messageId}`, sizeBytes: rawSize },
    parts: [{ kind: "attachment", driveFileId: `att-${messageId}`, originalFilename: "report.txt", mimeType: "text/plain", sizeBytes: 5 }] };
}
function relayFetcher(options: { badSize?: boolean; duplicate?: boolean; mismatch?: boolean } = {}): Fetch {
  return vi.fn<Fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.action === "status" || !body.action) return json({ ok: true, schemaVersion: 1, mailbox: options.mismatch ? "other@example.com" : "me@example.com", status: "watching", phase: "watching", latestSeq: 2, tokenExpiresAt: "2026-12-01T00:00:00Z", tokenIsPrevious: false });
    if (body.action === "changes") return json({ ok: true, mailbox: "me@example.com", entries: [
      { seq: 1, gmailMessageId: "m1", gmailThreadId: "t1", internalDateMs: 1700000000000, manifest: manifest("m1") },
      ...(options.duplicate ? [{ seq: 2, gmailMessageId: "m1", gmailThreadId: "t1", internalDateMs: 1700000000000, manifest: manifest("m1") }] : [])
    ], nextAfter: 2, latestSeq: 2, hasMore: false });
    if (body.action === "file") {
      const bytes = String(body.fileId).startsWith("raw-") ? eml() : Buffer.from("12345");
      const size = options.badSize && String(body.fileId).startsWith("raw-") ? bytes.length + 1 : bytes.length;
      return json({ ok: true, fileId: body.fileId, name: "file", mimeType: "message/rfc822", totalSize: size, offset: body.offset, length: bytes.length, dataBase64: bytes.toString("base64") });
    }
    return json({ ok: false, error: "bad action" });
  });
}

describe("Gmail Apps Script relay", () => {
  it("validates script.google.com URLs and rejects untrusted redirect hosts", async () => {
    expect(validateGmailRelayUrl("https://script.google.com/a/macros/example.com/s/id/exec")).toContain("script.google.com");
    expect(() => validateGmailRelayUrl("http://script.google.com/macros/s/id/exec")).toThrow();
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response("", { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(new GmailRelayTransport(secret.url, "token", fetcher).request("status")).rejects.toThrow("redirect");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("posts token-protected JSON, follows only allowed Apps Script redirects, and does not leak the token in errors", async () => {
    const fetcher = vi.fn<Fetch>()
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo" } }))
      .mockResolvedValueOnce(json({ ok: false, error: "Unauthorized." }));
    const operation = new GmailRelayTransport(secret.url, "super-secret-token", fetcher).request("status");
    await expect(operation).rejects.toThrow("Unauthorized");
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("super-secret-token");
    await expect(operation).rejects.not.toThrow("super-secret-token");
  });
  it("imports a page idempotently, persists the cursor only through the callback, and records attachments", async () => {
    const vault = new MemoryVault(); vault.put("sources", source.id, source); vault.put("secrets", `gmail-relay:${source.id}`, secret);
    const pages: Page[] = [];
    await new GmailRelayConnector(vault, relayFetcher({ duplicate: true })).sync(account, source, page => {
      pages.push(page);
      for (const message of page.messages) vault.put("messages", message.id, message);
      for (const attachment of page.attachments) vault.put("attachments", attachment.id, attachment);
      if (page.checkpoint) vault.put("checkpoints", page.checkpoint.id, page.checkpoint.value);
    });
    expect(pages[0].messages).toHaveLength(1);
    expect(pages[0].attachments[0]).toMatchObject({ name: "report.txt", size: 5, status: "pending" });
    expect(vault.all("messages")).toHaveLength(1);
    expect(vault.get("checkpoints", `gmail-relay-status:${source.id}`)).toMatchObject({ cursor: 2, imported: 1 });
  });
  it("leaves the cursor unadvanced when chunked file size verification fails", async () => {
    const vault = new MemoryVault(); vault.put("sources", source.id, source); vault.put("secrets", `gmail-relay:${source.id}`, secret);
    await expect(new GmailRelayConnector(vault, relayFetcher({ badSize: true })).sync(account, source, () => { throw new Error("should not commit"); })).rejects.toThrow("size");
    expect(vault.get("checkpoints", `gmail-relay-status:${source.id}`)).toMatchObject({ cursor: 0 });
  });
  it("explains a Google HTML error page, retries it, and keeps the failure visible on the relay status", async () => {
    const vault = new MemoryVault(); vault.put("sources", source.id, source); vault.put("secrets", `gmail-relay:${source.id}`, secret);
    const base = relayFetcher();
    const fetcher = vi.fn<Fetch>(async (input, init) => JSON.parse(String(init?.body)).action === "changes"
      ? new Response("<!DOCTYPE html><html><body>Google error</body></html>", { status: 200 }) : base(input, init));
    const transport = new GmailRelayTransport(secret.url, secret.token, fetcher, async () => undefined);
    await expect(transport.request("changes", { after: 0 })).rejects.toThrow("Google error page");
    expect(fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action === "changes")).toHaveLength(4);
    const connector = new GmailRelayConnector(vault, fetcher);
    vi.spyOn(connector, "transport").mockReturnValue(transport);
    await expect(connector.sync(account, source, () => undefined)).rejects.toThrow("Google error page");
    expect(vault.get("checkpoints", `gmail-relay-status:${source.id}`)).toMatchObject({ cursor: 0, lastError: expect.stringContaining("Google error page") });
  });
  it("stops before import when the relay reports a different mailbox", async () => {
    const vault = new MemoryVault(); vault.put("sources", source.id, source); vault.put("secrets", `gmail-relay:${source.id}`, secret);
    await expect(new GmailRelayConnector(vault, relayFetcher({ mismatch: true })).sync(account, source, () => undefined)).rejects.toThrow("mailbox changed");
    expect(vault.get("checkpoints", `gmail-relay-status:${source.id}`)).toMatchObject({ stopped: true });
  });
});
