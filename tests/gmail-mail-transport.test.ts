import { describe, expect, it, vi } from "vitest";
import type { Account, Collection, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import { GmailMailTransport } from "../src/main/browser/mail-transport";
import { commandSchema } from "../src/main/ipc/schema";

class MemoryVault {
  data = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined { return this.data.get(`${collection}:${id}`) as T | undefined; }
  put<T>(collection: Collection, id: string, value: T): void { this.data.set(`${collection}:${id}`, value); }
  all<T>(collection: Collection): T[] {
    return [...this.data].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => value as T);
  }
}
function fixture(apiConnected = true, selected: "auto" | "companion" = "auto") {
  const vault = new MemoryVault();
  const owner: Account = { id: "browser:google:reader@example.org", provider: "gmail", connection: "browser",
    email: "reader@example.org", name: "Reader", consent: true, aiEnabled: false, status: "connected" };
  const apiAccount: Account = { ...owner, id: "gmail:reader@example.org", connection: undefined };
  const source: Source = { id: `${apiAccount.id}:INBOX`, accountId: apiAccount.id, providerId: "INBOX",
    name: "Inbox", kind: "mail", selected: true };
  vault.put("accounts", owner.id, owner);
  vault.put("sources", `${owner.id}:mail`, { ...source, id: `${owner.id}:mail`, accountId: owner.id, providerId: "mail" });
  if (apiConnected) { vault.put("accounts", apiAccount.id, apiAccount); vault.put("sources", source.id, source); }
  const capture: BrowserCapture = { accountEmail: owner.email, accountName: owner.name, kind: "mail",
    pageUrl: "https://mail.google.com/mail/#inbox", messages: [], meetings: [] };
  const api = { hasGmailReadConfiguration: vi.fn(() => true), readGmailMail: vi.fn(async () => capture) };
  const playwright = { readMailThread: vi.fn(async () => capture) };
  const companion = { readMailThread: vi.fn(async () => capture) };
  const preference = { selected };
  const transport = new GmailMailTransport(vault, api, playwright, companion, () => preference.selected);
  const input = { accountId: owner.id, accountEmail: owner.email, threadId: "abc123" };
  return { vault, owner, apiAccount, source, capture, api, playwright, companion, transport, input, preference };
}
describe("per-mailbox Gmail API preference and managed browser fallback", () => {
  it("uses explicit direct-browser mode without API configuration or managed-browser login", async () => {
    const f = fixture(true, "companion");
    f.vault.put("sources", f.source.id, { ...f.source, selected: false });
    const capture = await f.transport.readMailThread(f.input, vi.fn());
    expect(f.companion.readMailThread).toHaveBeenCalledOnce();
    expect(f.api.readGmailMail).not.toHaveBeenCalled();
    expect(f.api.hasGmailReadConfiguration).not.toHaveBeenCalled();
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
    expect(f.transport.status(f.owner).transport).toBe("companion");
    expect(f.transport.origin(capture)).toBeUndefined();
  });
  it("keeps native API account status separate from direct-browser selection", () => {
    const f = fixture(true, "companion");
    expect(f.transport.status(f.apiAccount).transport).toBe("gmail-api");
  });
  it("invalidates caches and rejects a result when reading method changes mid-read", async () => {
    const f = fixture(true, "companion"), prior = f.transport.cacheIdentity(f.owner.id);
    f.companion.readMailThread.mockImplementation(async () => {
      f.preference.selected = "auto";
      return f.capture;
    });
    await expect(f.transport.readMailThread(f.input, vi.fn())).rejects.toThrow("reading method changed");
    expect(f.transport.cacheIdentity(f.owner.id)).not.toBe(prior);
  });
  it("never substitutes API when the explicitly selected companion fails", async () => {
    const f = fixture(true, "companion");
    f.companion.readMailThread.mockRejectedValue(new Error("Page still loading"));
    await expect(f.transport.readMailThread(f.input, vi.fn())).rejects.toThrow("Page still loading");
    expect(f.api.readGmailMail).not.toHaveBeenCalled();
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
  });
  it("validates the reading-method setting and rejects arbitrary driver names", () => {
    expect(commandSchema.safeParse({ type: "settings.update", patch: { browserMailTransport: "companion" } }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "settings.update", patch: { browserMailTransport: "stealth" } }).success).toBe(false);
  });
  it("uses the same-mailbox API without AI consent and records trusted origin", async () => {
    const f = fixture();
    const capture = await f.transport.readMailThread(f.input, vi.fn());
    expect(f.api.readGmailMail).toHaveBeenCalledWith(f.apiAccount, f.source, f.input, expect.any(Function), undefined);
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
    expect(f.companion.readMailThread).not.toHaveBeenCalled();
    expect(f.transport.origin(capture)).toEqual({ accountId: f.apiAccount.id, sourceId: f.source.id });
    expect(f.transport.origin(structuredClone(capture))).toBeUndefined();
  });
  it("systematically chooses Playwright, not companion dispatch, for an unconfigured mailbox", async () => {
    const f = fixture(false);
    await f.transport.readMailThread(f.input, vi.fn());
    expect(f.playwright.readMailThread).toHaveBeenCalledOnce();
    expect(f.api.readGmailMail).not.toHaveBeenCalled();
    expect(f.companion.readMailThread).not.toHaveBeenCalled();
    expect(f.transport.origin(f.capture)).toBeUndefined();
  });
  it("does not borrow another mailbox's API connection", async () => {
    const f = fixture();
    f.vault.put("accounts", f.apiAccount.id, { ...f.apiAccount, email: "other@example.org" });
    await f.transport.readMailThread(f.input, vi.fn());
    expect(f.api.readGmailMail).not.toHaveBeenCalled();
    expect(f.playwright.readMailThread).toHaveBeenCalledOnce();
  });
  it.each(["authorization", "quota", "policy"])("surfaces API %s failures without browser fallback", async reason => {
    const f = fixture();
    f.api.readGmailMail.mockRejectedValue(new Error(reason));
    await expect(f.transport.readMailThread(f.input, vi.fn())).rejects.toThrow(reason);
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
  });
  it.each(["source", "account", "credentials"])("does not bypass an existing API connection's excluded %s", async kind => {
    const f = fixture();
    if (kind === "source") f.vault.put("sources", f.source.id, { ...f.source, selected: false });
    if (kind === "account") f.vault.put("accounts", f.apiAccount.id, { ...f.apiAccount, consent: false });
    if (kind === "credentials") f.api.hasGmailReadConfiguration.mockReturnValue(false);
    expect(f.transport.status(f.owner).transport).toBe("unavailable");
    await expect(f.transport.readMailThread(f.input, vi.fn())).rejects.toThrow(/API/);
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
  });
  it("rejects a result when API source permission changes while downloading", async () => {
    const f = fixture();
    f.api.readGmailMail.mockImplementation(async () => {
      f.vault.put("sources", f.source.id, { ...f.source, selected: false });
      return f.capture;
    });
    await expect(f.transport.readMailThread(f.input, vi.fn())).rejects.toThrow(/API/);
    expect(f.transport.origin(f.capture)).toBeUndefined();
  });
  it("rejects mismatched requested identity and cancellation before either transport", async () => {
    const f = fixture();
    await expect(f.transport.readMailThread({ ...f.input, accountEmail: "other@example.org" }, vi.fn())).rejects.toThrow(/revoked/);
    await expect(f.transport.readMailThread(f.input, vi.fn(), AbortSignal.abort())).rejects.toBeDefined();
    expect(f.api.readGmailMail).not.toHaveBeenCalled();
    expect(f.playwright.readMailThread).not.toHaveBeenCalled();
  });
  it("changes the cache identity when Gmail API becomes available", () => {
    const f = fixture(false), prior = f.transport.cacheIdentity(f.owner.id);
    f.vault.put("accounts", f.apiAccount.id, f.apiAccount);
    f.vault.put("sources", f.source.id, f.source);
    expect(f.transport.cacheIdentity(f.owner.id)).not.toBe(prior);
  });
  it("exposes only account-scoped open and close IPC, never arbitrary URLs or scripts", () => {
    expect(commandSchema.safeParse({ type: "browser.playwright.open", accountId: "known-account" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "browser.playwright.close" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "browser.playwright.open", accountId: "known-account", url: "https://example.org" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "browser.playwright.open" }).success).toBe(false);
  });
});
