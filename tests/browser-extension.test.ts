import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserCapture, BrowserRegistration } from "../src/shared/browser";
import { BrowserBridge } from "../src/main/browser/bridge";

const directory = resolve(import.meta.dirname, "..", "browser-extension");
const require = createRequire(import.meta.url);
interface Extraction {
  messages: BrowserCapture["messages"];
  meetings: BrowserCapture["meetings"];
  coverage: string;
}
interface Extractors {
  pageKind(url: string): "mail" | "calendar";
  identity(document: Document, url: string): BrowserRegistration;
  identityDiagnostics(document: Document, url: string): {
    ariaAnchors: number;
    visibleAnchors: number;
    trustedAccountHrefs: number;
    matchingLabels: number;
    eligibleAnchors: number;
    excludedAncestors: { any: number; main: number; dialog: number; message: number; event: number };
  };
  extract(document: Document, registration: BrowserRegistration): Extraction;
  mail(document: Document, url: string): Extraction;
  calendar(document: Document, url: string): Extraction;
  safeMeetUrl(url: string, pageUrl: string): string | undefined;
}
const extractors: Extractors = require(resolve(directory, "extractors.js"));
const MAIL = "https://mail.google.com/mail/u/0/#inbox";
const CALENDAR = "https://calendar.google.com/calendar/u/0/r/agenda";
const ID = "haiiamalgpmpjeaaldpdopnaogallplh";
const registration: BrowserRegistration = { accountEmail: "owner@example.org", accountName: "Owner", pageUrl: MAIL, kind: "mail" };

function mockChrome(initialToken: string | undefined = "paired-token") {
  const state: { token?: string; [key: string]: unknown } = { token: initialToken };
  return {
    state,
    runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path}` },
    storage: { local: {
      setAccessLevel: vi.fn(async (_options: { accessLevel: string }) => undefined),
      get: vi.fn(async (_key: string | string[]) => ({ ...state })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
      remove: vi.fn(async (key: string) => { delete state[key]; })
    } },
    tabs: {
      get: vi.fn(async (_id: number) => ({ id: 7, url: MAIL })),
      query: vi.fn(async (_query?: unknown) => [{ id: 7, url: MAIL }]),
      create: vi.fn(async (_options: { url: string; active: boolean }) => ({ id: 99 })),
      sendMessage: vi.fn(async () => ({ ok: true, value: { status: "Synthetic capture complete." } }))
    }
  };
}
type Sender = { id: string; url: string; tab?: { id: number; url: string }; frameId?: number };
const tabSender: Sender = { id: ID, url: MAIL, tab: { id: 7, url: MAIL }, frameId: 0 };
const popupSender: Sender = { id: ID, url: `chrome-extension://${ID}/popup.html` };
interface Command { type: string; payload?: BrowserRegistration | BrowserCapture; code?: string; action?: string }
const background: {
  createBridge(chrome: ReturnType<typeof mockChrome>, fetch: typeof globalThis.fetch): {
    handle(command: Command, sender: Sender): Promise<unknown>
  }
} = require(resolve(directory, "background.js"));
function setup(initialToken: string | undefined = "paired-token") {
  const chrome = mockChrome(initialToken);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ accountId: "account", enabled: true }));
  const bridge = background.createBridge(chrome, fetch);
  return { chrome, fetch, handle: bridge.handle };
}
function capture(): BrowserCapture {
  return { ...registration, messages: [{ id: "message-1", threadId: "thread-1", subject: "Fixture", sender: "sender@example.org",
    recipients: [], body: "Synthetic body", dateText: "Yesterday", url: MAIL, unread: false, completeness: "full" }], meetings: [] };
}

describe("browser extension manifest and URL boundaries", () => {
  it("pins the stable public key and least-privilege isolated content scripts", () => {
    const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
    const hash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
    const extensionId = [...hash].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
    expect(extensionId).toBe(ID);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "alarms", "downloads"]);
    expect(manifest.optional_permissions).toEqual(["scripting"]);
    expect(manifest.optional_host_permissions).toEqual(["https://ogs.google.com/*"]);
    expect(manifest.host_permissions).toEqual(["https://mail.google.com/*", "https://calendar.google.com/*", "https://web.whatsapp.com/*", "http://127.0.0.1:43891/*"]);
    expect(manifest.content_scripts[0]).toMatchObject({ world: "ISOLATED", all_frames: false });
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts[0].js]) {
      expect(existsSync(resolve(directory, file))).toBe(true);
    }
    expect(existsSync(resolve(directory, "accounts.js"))).toBe(true);
  });
  it.each([
    "https://mail.google.com.evil.example/mail/u/0", "http://mail.google.com/mail/u/0",
    "https://evil.example/mail/u/0", "https://mail.google.com:444/mail/u/0",
    "https://owner@mail.google.com/mail/u/0", "https://calendar.google.com/mail/u/0",
    "https://mail.google.com/login", "data:text/html,mail.google.com"
  ])("rejects unsupported page %s", url => expect(() => extractors.pageKind(url)).toThrow());
  it("accepts only exact-host HTTPS Google Meet codes without tracking parameters", () => {
    expect(extractors.safeMeetUrl("https://meet.google.com/abc-defg-hij?authuser=1", CALENDAR)).toBe("https://meet.google.com/abc-defg-hij");
    for (const url of ["https://meet.google.com.evil.example/abc-defg-hij", "http://meet.google.com/abc-defg-hij",
      "https://meet.google.com:444/abc-defg-hij", "https://evil@meet.google.com/abc-defg-hij",
      "https://meet.google.com/url?next=evil", "javascript:alert(1)", "https://google.com/url?q=https://meet.google.com/abc-defg-hij"]) {
      expect(extractors.safeMeetUrl(url, CALENDAR)).toBeUndefined();
    }
  });
});

describe("browser extension privileged worker", () => {
  it("opens WhatsApp in the same profile without changing pairing or requesting credentials", async () => {
    const { chrome, handle, fetch } = setup();
    await handle({ type: "open-whatsapp" }, popupSender);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://web.whatsapp.com/", active: false });
    expect(chrome.state.token).toBe("paired-token");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("binds WhatsApp capture grants to the verified own phone and individually selected chat", async () => {
    const { chrome, handle, fetch } = setup();
    const url = "https://web.whatsapp.com/";
    chrome.tabs.get.mockResolvedValue({ id: 7, url });
    const sender = { ...tabSender, url, tab: { id: 7, url } };
    const account: BrowserRegistration = { accountEmail: "+33612345678", accountName: "WhatsApp",
      pageUrl: url, kind: "whatsapp", chat: { id: "33699999999@c.us", name: "Alice" } };
    const payload: BrowserCapture = { ...account, messages: [{ ...capture().messages[0],
      id: "false_33699999999@c.us_ABC", threadId: account.chat!.id, url }], meetings: [] };
    await handle({ type: "discover", payload: account }, sender);
    await expect(handle({ type: "capture", payload: { ...payload, chat: { id: "447700900123@c.us", name: "Alice" } } }, sender))
      .rejects.toThrow("selection");
    fetch.mockImplementation(async endpoint => Response.json(String(endpoint).endsWith("/capture")
      ? { accepted: true } : { accountId: "whatsapp", enabled: true }));
    await handle({ type: "capture", payload }, sender);
    const uploaded = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
    expect(uploaded).toMatchObject({ accountEmail: account.accountEmail, kind: "whatsapp", chat: account.chat });
    await expect(handle({ type: "discover", payload: { ...account, accountEmail: "fake@example.org" } }, sender)).rejects.toThrow("registration");
  });
  it("opens deduplicated background account views without reloading forms or opening messages", async () => {
    const { chrome, handle, fetch } = setup();
    chrome.tabs.query.mockResolvedValue([
      { id: 1, url: `${MAIL}/private-thread?compose=draft` },
      { id: 2, url: "https://mail.google.com/mail/u/0/#drafts" },
      { id: 3, url: "https://calendar.google.com/calendar/u/1/r/eventedit/private-event" }
    ]);
    await expect(handle({ type: "fresh-account-views" }, tabSender)).rejects.toThrow("restricted");
    await expect(handle({ type: "fresh-account-views" }, popupSender)).resolves.toMatchObject({ opened: 2 });
    expect(chrome.tabs.create.mock.calls).toEqual([
      [{ url: MAIL, active: false }],
      [{ url: "https://calendar.google.com/calendar/u/1/#agenda", active: false }]
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("pairs from the popup only and never returns the token to content scripts", async () => {
    const { chrome, fetch, handle } = setup();
    fetch.mockResolvedValueOnce(Response.json({ token: "new-pair-token" }));
    await expect(handle({ type: "pair", code: " 123456 " }, tabSender)).rejects.toThrow("restricted");
    expect(fetch).not.toHaveBeenCalled();
    await expect(handle({ type: "pair", code: " 123456 " }, popupSender)).resolves.toEqual({ paired: true });
    expect(chrome.state.token).toBe("new-pair-token");
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:43891/pair");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ code: "123456" });
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json" });
    await expect(handle({ type: "state" }, popupSender)).resolves.toEqual({ paired: true });
    await expect(handle({ type: "state" }, { ...popupSender, tab: { id: 8, url: popupSender.url } })).resolves.toEqual({ paired: true });
  });
  it("re-pairs itself from the installed folder secret after its storage was reset, unless the user forgot the pairing", async () => {
    const secret = "a".repeat(64);
    const chrome = mockChrome();
    delete chrome.state.token;
    const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith("/relay-pairing.json")
      ? Response.json({ version: 1, secret, port: 43891 })
      : String(input).endsWith("/pair") ? Response.json({ token: "auto-token" }) : Response.json({ accountId: "account", enabled: true }));
    const { handle } = background.createBridge(chrome, fetch);
    await expect(handle({ type: "state" }, popupSender)).resolves.toEqual({ paired: true });
    expect(chrome.state.token).toBe("auto-token");
    const pairCall = fetch.mock.calls.find(call => String(call[0]).endsWith("/pair"))!;
    expect(JSON.parse(String(pairCall[1]?.body))).toEqual({ bootstrap: secret });
    await expect(handle({ type: "forget" }, popupSender)).resolves.toEqual({ paired: false });
    const forgotten = mockChrome();
    delete forgotten.state.token;
    forgotten.state.autoPairOff = true;
    const quiet = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: "never" }));
    await expect(background.createBridge(forgotten, quiet).handle({ type: "state" }, popupSender)).resolves.toEqual({ paired: false });
    expect(quiet).not.toHaveBeenCalled();
  });
  it.each([false, true])("pairs through the real HTTP bridge without any account link or provider tab (unrelated tab=%s)", async unrelatedTab => {
    const secrets = new Map<string, unknown>();
    const onDiscover = vi.fn(async () => ({ accountId: "unused", enabled: false }));
    const onCapture = vi.fn(async () => {});
    const server = new BrowserBridge({
      get: <T>(_collection: "secrets", id: string) => secrets.get(id) as T | undefined,
      put: <T>(_collection: "secrets", id: string, value: T) => { secrets.set(id, value); },
      delete: (_collection: "secrets", id: string) => { secrets.delete(id); }
    }, { extensionId: ID, port: 0, onDiscover, onCapture, changed: () => {} });
    try {
      const pairing = await server.pair();
      const chrome = mockChrome();
      delete chrome.state.token;
      chrome.tabs.query.mockResolvedValue(unrelatedTab ? [{ id: 7, url: "https://example.org/" }] : []);
      const transport = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const original = new URL(String(input));
        if (original.href === `chrome-extension://${ID}/relay-pairing.json`) return new Response("", { status: 404 });
        if (original.hostname !== "127.0.0.1" || original.pathname !== "/pair")
          throw new Error("Unexpected provider request during profile-only pairing");
        return globalThis.fetch(`http://127.0.0.1:${server.status().port}${original.pathname}`, {
          ...init, headers: { ...init?.headers, Origin: `chrome-extension://${ID}` }
        });
      });
      const worker = background.createBridge(chrome, transport);
      await expect(worker.handle({ type: "pair", code: pairing.code }, popupSender)).resolves.toEqual({ paired: true });
      await expect(worker.handle({ type: "state" }, popupSender)).resolves.toEqual({ paired: true });
      expect(server.status().paired).toBe(true);
      expect(transport.mock.calls.filter(call => String(call[0]).startsWith("http://")).length).toBe(1);
      expect(onDiscover).not.toHaveBeenCalled();
      expect(onCapture).not.toHaveBeenCalled();
      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.state.token).toBeTruthy();
    } finally { await server.stop(); }
  });
  it("sends discovery metadata only even when the caller supplies content", async () => {
    const { fetch, handle } = setup();
    await expect(handle({ type: "discover", payload: capture() }, tabSender)).resolves.toEqual({ accountId: "account", enabled: true });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(registration);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", headers: { Authorization: "Bearer paired-token" } });
  });
  it("preserves only a validated bridge background-capture flag", async () => {
    const { fetch, handle } = setup();
    fetch.mockResolvedValueOnce(Response.json({
      accountId: "account",
      enabled: true,
      backgroundCapture: true,
      refreshIntervalSeconds: 300,
    }));
    await expect(handle({ type: "discover", payload: registration }, tabSender)).resolves.toEqual({
      accountId: "account",
      enabled: true,
      backgroundCapture: true,
      refreshIntervalSeconds: 300,
    });
    for (const backgroundCapture of ["true", 1, null]) {
      fetch.mockResolvedValueOnce(Response.json({ accountId: "account", enabled: true, backgroundCapture }));
      await expect(handle({ type: "discover", payload: registration }, tabSender)).rejects.toThrow("invalid source-selection");
    }
  });
  it("requires prior selection and rechecks it before forwarding content", async () => {
    const { fetch, handle } = setup();
    await expect(handle({ type: "capture", payload: capture() }, tabSender)).rejects.toThrow("selection");
    expect(fetch).not.toHaveBeenCalled();
    await handle({ type: "discover", payload: registration }, tabSender);
    fetch.mockResolvedValueOnce(Response.json({ accountId: "account", enabled: false }));
    await expect(handle({ type: "capture", payload: capture() }, tabSender)).rejects.toThrow("not selected");
    expect(fetch.mock.calls.every(call => String(call[0]).endsWith("/discover"))).toBe(true);
  });
  it("uploads a selected capture once, using the agreed contract", async () => {
    const { fetch, handle } = setup();
    await handle({ type: "discover", payload: registration }, tabSender);
    fetch.mockResolvedValueOnce(Response.json({ accountId: "account", enabled: true })).mockResolvedValueOnce(Response.json({ accepted: true }));
    await expect(handle({ type: "capture", payload: capture() }, tabSender)).resolves.toEqual({ accepted: true });
    expect(fetch.mock.calls[2][0]).toBe("http://127.0.0.1:43891/capture");
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual(capture());
    await expect(handle({ type: "capture", payload: capture() }, tabSender)).rejects.toThrow("selection");
  });
  it.each([
    { ...tabSender, frameId: 2 }, { ...tabSender, id: "foreign" },
    { ...tabSender, url: "https://evil.example/mail/u/0" }, popupSender,
    { ...tabSender, tab: { id: 7, url: CALENDAR } }
  ])("rejects forged or cross-frame content senders", async sender => {
    const { fetch, handle } = setup();
    await expect(handle({ type: "discover", payload: registration }, sender)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects wrong page types and navigation races", async () => {
    const { chrome, fetch, handle } = setup();
    await expect(handle({ type: "discover", payload: { ...registration, kind: "calendar" } }, tabSender)).rejects.toThrow("page type");
    chrome.tabs.get.mockResolvedValueOnce({ id: 7, url: "https://mail.google.com/mail/u/1/#inbox" });
    await expect(handle({ type: "discover", payload: registration }, tabSender)).rejects.toThrow("changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not reuse grants across identities or slots", async () => {
    const { handle } = setup();
    await handle({ type: "discover", payload: registration }, tabSender);
    await expect(handle({ type: "capture", payload: { ...capture(), accountEmail: "different@example.org" } }, tabSender)).rejects.toThrow("selection");
  });
  it("rejects oversized captures and mismatched content kinds before upload", async () => {
    const { fetch, handle } = setup();
    const payloads: BrowserCapture[] = [
      { ...capture(), messages: Array.from({ length: 201 }, () => capture().messages[0]) },
      { ...capture(), meetings: [{ id: "event", title: "Event", whenText: "Tomorrow", description: "", location: "", url: MAIL }] },
      { ...capture(), messages: [{ ...capture().messages[0], body: "x".repeat(2 * 1024 * 1024) }] }
    ];
    for (const payload of payloads) {
      await handle({ type: "discover", payload: registration }, tabSender);
      await expect(handle({ type: "capture", payload }, tabSender)).rejects.toThrow(/too many|too large/);
    }
    expect(fetch.mock.calls.every(call => String(call[0]).endsWith("/discover"))).toBe(true);
  });
  it("clears only revoked auth, preserving pairing on outages and source errors", async () => {
    const { chrome, fetch, handle } = setup();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(handle({ type: "discover", payload: registration }, tabSender)).rejects.toThrow("unavailable");
    expect(chrome.state.token).toBe("paired-token");
    for (const status of [400, 403, 409, 423, 500, 503]) {
      fetch.mockResolvedValueOnce(Response.json({ error: "Synthetic service error" }, { status }));
      await expect(handle({ type: "discover", payload: registration }, tabSender)).rejects.toThrow(String(status));
      expect(chrome.state.token).toBe("paired-token");
    }
    fetch.mockResolvedValueOnce(Response.json({ error: "Revoked" }, { status: 401 }));
    await expect(handle({ type: "discover", payload: registration }, tabSender)).rejects.toThrow("revoked");
    expect(chrome.state.token).toBeUndefined();
  });
  it("does not forget an existing pairing on an incorrect new code", async () => {
    const { chrome, fetch, handle } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: "Wrong code" }, { status: 401 }));
    await expect(handle({ type: "pair", code: "wrong" }, popupSender)).rejects.toThrow("401");
    expect(chrome.state.token).toBe("paired-token");
  });
  it("reloads only background provider tabs left without a live content script after an update", async () => {
    const chrome = mockChrome();
    const tabs = [
      { id: 1, url: MAIL, active: false },
      { id: 2, url: MAIL, active: true },
      { id: 3, url: MAIL, active: false },
      { id: 4, url: "https://calendar.google.com/calendar/u/0/r/eventedit/abc", active: false },
    ];
    const reload = vi.fn(async (_id: number) => undefined);
    Object.assign(chrome.tabs, { reload, query: vi.fn(async () => tabs), get: vi.fn(async (id: number) => ({ ...tabs.find(tab => tab.id === id)!, active: false })) });
    chrome.tabs.sendMessage.mockImplementation((async (id: number) => {
      if (id === 3) return { ok: true, value: {} };
      throw new Error("No receiver");
    }) as never);
    const worker = background.createBridge(chrome, vi.fn()) as unknown as {
      recoverOrphanedTabs(): Promise<{ reloaded: number; deferred: number }>; reloadDeferredTabs(): Promise<void> };
    await expect(worker.recoverOrphanedTabs()).resolves.toEqual({ reloaded: 1, deferred: 2 });
    expect(reload.mock.calls.map(call => call[0])).toEqual([1]);
    await worker.reloadDeferredTabs();
    expect(reload.mock.calls.map(call => call[0])).toEqual([1, 2]);
  });
  it("offers an actionable reload error when the tab has no content script", async () => {
    const { chrome, handle } = setup();
    chrome.tabs.sendMessage.mockRejectedValueOnce(new Error("No receiver"));
    await expect(handle({ type: "current-tab", action: "capture" }, popupSender)).rejects.toThrow("Reload");
  });
  it("can ask every open Gmail and Calendar tab to disclose metadata and reports reload guidance for failures", async () => {
    const { chrome, handle } = setup();
    chrome.tabs.query.mockImplementation(async query => {
      const hasUrlFilter = typeof query === "object" && query !== null && "url" in query;
      return hasUrlFilter ? [{ id: 7, url: MAIL }, { id: 8, url: CALENDAR }] : [{ id: 7, url: MAIL }];
    });
    chrome.tabs.sendMessage
      .mockResolvedValueOnce({ ok: true, value: { status: "owner@example.org: source selected. Manual refresh only." } })
      .mockRejectedValueOnce(new Error("No receiver"));
    await expect(handle({ type: "discover-open-tabs" }, popupSender)).resolves.toEqual({
      attempted: 2,
      discovered: 1,
      failed: 1,
      message: expect.stringMatching(/Asked 2 open supported tabs.*1 responded; 1 failed\..*Reload failed tabs after the extension update/),
    });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(1, 7, { type: "relay-tab", action: "connect" }, { frameId: 0 });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 8, { type: "relay-tab", action: "connect" }, { frameId: 0 });
  });
});

interface FixtureState {
  enabled: boolean;
  backgroundCapture?: boolean;
  refreshIntervalSeconds: number;
  refreshRequestedAt: number;
  discoverDelayMs: number;
  calls: Array<{ type: string; payload: BrowserRegistration | BrowserCapture }>;
  extractionCalls: number;
  listener?: (message: { type: string; action: string }, sender: { id: string }, respond: (response: { ok: boolean; value?: unknown; error?: string }) => void) => boolean;
}
declare global {
  interface Window {
    RelayExtractors: Extractors;
    relayFixture: FixtureState;
    relayPopupFixture: {
      paired: boolean;
      calls: Array<{ type: string; action?: string; code?: string }>;
    };
    relayPermissionEvents: Array<{ kind: string; value: unknown }>;
  }
}
const browserAvailable = existsSync(chromium.executablePath()) || process.env.RELAY_EXTENSION_TEST_EDGE === "1";
it.skipIf(process.env.RELAY_EXTENSION_TEST_EDGE !== "1")("loads the actual MV3 worker and popup under the pinned ID in an isolated Edge profile", async () => {
  const profile = await mkdtemp(join(tmpdir(), "relay-extension-fixture-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, channel: "msedge", args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    expect(worker.url()).toBe(`chrome-extension://${ID}/background.js`);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${ID}/popup.html`);
    await expect.poll(() => page.locator("#pair-state").textContent(), { timeout: 5000 }).toContain("Not paired");
    await expect.poll(() => page.locator("#status").textContent(), { timeout: 5000 }).toContain("Account discovery and capture are separate");
    expect(await page.locator("#code").getAttribute("autocomplete")).toBe("off");
    const fixture = await context.newPage();
    await fixture.route("**/*", route => route.fulfill({
      contentType: "text/html", body: '<!doctype html><html><body><header id="gb"><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Fixture (fixture@example.org)">Account</a></header><main role="main">Synthetic page</main></body></html>'
    }));
    await fixture.goto(MAIL);
    await fixture.locator("#relay-desk-coverage").waitFor();
    expect(await fixture.evaluate(() => typeof window.RelayExtractors)).toBe("undefined");
    // The real popup, worker, and isolated content script communicate without a desktop token.
    // No HTTP call is permitted before pairing, and no message content is extracted.
    await page.evaluate(() => document.getElementById("connect")!.click());
    await expect.poll(() => page.locator("#status").textContent(), { timeout: 5000 }).toContain("Pair with Relay Desk first");
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
it.skipIf(process.env.RELAY_EXTENSION_TEST_EDGE !== "1" || process.env.RELAY_EXTENSION_TEST_BRIDGE !== "1")("pairs, discovers, captures, and handles revocation through real extension fetch and the real HTTP bridge", async () => {
  const secrets = new Map<string, unknown>();
  const discoveries: BrowserRegistration[] = [];
  const captures: BrowserCapture[] = [];
  let selected = false;
  const bridge = new BrowserBridge({
    get: <T>(_collection: "secrets", id: string) => secrets.get(id) as T | undefined,
    put: <T>(_collection: "secrets", id: string, value: T) => { secrets.set(id, value); },
    delete: (_collection: "secrets", id: string) => { secrets.delete(id); }
  }, {
    extensionId: ID,
    onDiscover: async payload => {
      discoveries.push(payload);
      return { accountId: `browser:google:${payload.accountEmail}`, enabled: selected };
    },
    onCapture: async payload => {
      if (!selected) throw new Error("Select this source before capturing.");
      captures.push(payload);
    },
    changed: () => undefined
  });
  const profile = await mkdtemp(join(tmpdir(), "relay-extension-http-fixture-"));
  let context: BrowserContext | undefined;
  try {
    // This opt-in owns the fixed port only if free; it never connects to or stops an existing desktop service.
    const pairing = await bridge.pair();
    context = await chromium.launchPersistentContext(profile, {
      headless: true, channel: "msedge", args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`]
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${ID}/popup.html`);
    await expect.poll(() => popup.locator("#pair-state").textContent(), { timeout: 5000 }).toContain("Not paired");
    const fixture = await context.newPage();
    await fixture.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><header id="gb"><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Fixture (fixture@example.org)">Account</a></header><main role="main"><table><tbody><tr class="zA"><td><span email="sender@example.org">Sender</span></td><td><span class="bog" data-legacy-thread-id="http-thread">Synthetic HTTP fixture</span><span class="y2">Synthetic preview</span></td><td class="xW"><span title="Yesterday">Yesterday</span></td></tr></tbody></table></main></body></html>'
    }));
    await fixture.goto(MAIL);
    await fixture.locator("#relay-desk-coverage").waitFor();
    await popup.evaluate(code => {
      (document.getElementById("code") as HTMLInputElement).value = code;
      (document.getElementById("pair-form") as HTMLFormElement).requestSubmit();
    }, pairing.code);
    await expect.poll(() => popup.locator("#pair-state").textContent(), { timeout: 10000 }).toContain("Paired with");
    await expect.poll(() => discoveries.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(bridge.status().paired).toBe(true);
    expect(discoveries[0]).toEqual({ accountEmail: "fixture@example.org", accountName: "Fixture", pageUrl: MAIL, kind: "mail" });
    expect(captures).toHaveLength(0);
    await expect.poll(() => popup.locator("#status").textContent()).toContain("Browser profile paired");
    await popup.evaluate(() => document.getElementById("connect")!.click());
    await expect.poll(() => popup.locator("#status").textContent()).toContain("capture is not enabled");
    selected = true;
    await popup.evaluate(() => document.getElementById("capture")!.click());
    await expect.poll(() => captures.length, { timeout: 10000 }).toBe(1);
    await expect.poll(() => popup.locator("#status").textContent()).toContain("captured at");
    expect(captures[0]).toMatchObject({
      accountEmail: "fixture@example.org", pageUrl: MAIL, kind: "mail", meetings: [],
      messages: [{ threadId: "http-thread", subject: "Synthetic HTTP fixture", body: "Synthetic preview", completeness: "preview" }]
    });
    expect(new URL(captures[0].messages[0].url).pathname).toBe(new URL(MAIL).pathname);
    await bridge.revoke();
    await popup.evaluate(() => document.getElementById("connect")!.click());
    await expect.poll(() => popup.locator("#pair-state").textContent(), { timeout: 10000 }).toContain("Not paired");
    expect(bridge.status().paired).toBe(false);
  } finally {
    try { await context?.close(); }
    finally {
      try { await bridge.stop(); }
      finally { await rm(profile, { recursive: true, force: true }); }
    }
  }
});
describe.skipIf(!browserAvailable)("browser extension isolated DOM fixtures (no signed-in profile)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) });
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });

  const header = (email = "owner@example.org") => `<header id="gb"><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Owner (${email})">Account</a></header>`;
  const inbox = `<main role="main"><table><tbody><tr class="zA zE"><td><span email="sender@example.org">Sender</span></td><td><span class="bog" data-legacy-thread-id="thread-one">Synthetic subject</span><span class="y2">Preview only</span></td><td class="xW"><span title="Yesterday at 9:00">Yesterday</span></td></tr></tbody></table></main>`;
  const conversation = `<main role="main"><h2 class="hP" data-legacy-thread-id="thread-one">Synthetic subject</h2><div class="adn" data-message-id="message-one"><div class="gE"><span class="gD" email="sender@example.org">Sender</span><span class="g2" email="recipient@example.org">Recipient</span><span class="g3" title="Yesterday at 9:00">Yesterday</span></div><div class="ii"><div class="a3s">Full visible body <b>with text</b><span hidden>hidden secret</span></div></div></div><div class="adn" data-message-id="collapsed"><span class="gD" email="sender@example.org">Sender</span><div class="a3s" hidden>Collapsed body</div></div></main>`;

  async function load(html: string, url = MAIL) {
    page = await browser.newPage();
    // All navigation is fulfilled locally. No fixture can contact a live provider.
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
    await page.goto(url);
    await page.setContent(html);
    await page.addScriptTag({ path: resolve(directory, "extractors.js") });
  }
  async function readIdentity(url = MAIL) {
    return page.evaluate(url => window.RelayExtractors.identity(document, url), url);
  }
  async function readCapture(url = MAIL) {
    return page.evaluate(url => {
      const registration = window.RelayExtractors.identity(document, url);
      return window.RelayExtractors.extract(document, registration);
    }, url);
  }
  async function installContent(enabled: boolean, options: {
    backgroundCapture?: boolean;
    refreshIntervalSeconds?: number;
    refreshRequestedAt?: number;
    discoverDelayMs?: number;
    visibilityState?: DocumentVisibilityState;
  } = {}) {
    await page.evaluate(({ enabled, id, backgroundCapture, refreshIntervalSeconds, refreshRequestedAt, discoverDelayMs, visibilityState }) => {
      window.relayFixture = {
        enabled,
        backgroundCapture,
        refreshIntervalSeconds,
        refreshRequestedAt,
        discoverDelayMs,
        calls: [],
        extractionCalls: 0,
      };
      const extract = window.RelayExtractors.extract;
      window.RelayExtractors.extract = (...args) => { window.relayFixture.extractionCalls++; return extract(...args); };
      Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState });
      Object.defineProperty(window, "chrome", { value: { runtime: {
        id,
        sendMessage: async (message: FixtureState["calls"][number]) => {
          window.relayFixture.calls.push(structuredClone(message));
          if (message.type === "discover" && window.relayFixture.discoverDelayMs > 0) {
            await new Promise(resolve => window.setTimeout(resolve, window.relayFixture.discoverDelayMs));
          }
          return {
            ok: true,
            value: message.type === "discover"
              ? {
                accountId: "account",
                enabled: window.relayFixture.enabled,
                ...(window.relayFixture.backgroundCapture === undefined
                  ? {}
                  : { backgroundCapture: window.relayFixture.backgroundCapture }),
                refreshIntervalSeconds: window.relayFixture.refreshIntervalSeconds,
                refreshRequestedAt: window.relayFixture.refreshRequestedAt,
              }
              : { accepted: true }
          };
        },
        onMessage: { addListener: (listener: FixtureState["listener"]) => { window.relayFixture.listener = listener; } }
      } } });
    }, {
      enabled,
      id: ID,
      backgroundCapture: options.backgroundCapture,
      refreshIntervalSeconds: options.refreshIntervalSeconds ?? 60,
      refreshRequestedAt: options.refreshRequestedAt ?? 0,
      discoverDelayMs: options.discoverDelayMs ?? 0,
      visibilityState: options.visibilityState ?? "visible",
    });
    await page.addScriptTag({ path: resolve(directory, "content.js") });
  }
  async function command(action: string) {
    return page.evaluate(({ action, id }) => new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve, reject) => {
      if (!window.relayFixture.listener) return reject(new Error("Content listener missing"));
      window.relayFixture.listener({ type: "relay-tab", action }, { id }, resolve);
    }), { action, id: ID });
  }

  it("identifies email, not numeric account slots, and merges Gmail/Calendar identity", async () => {
    await load(header("Work@Example.org") + inbox);
    expect((await readIdentity()).accountEmail).toBe("work@example.org");
    expect((await readIdentity("https://mail.google.com/mail/u/8/#inbox")).accountEmail).toBe("work@example.org");
    expect((await readIdentity(CALENDAR)).accountEmail).toBe("work@example.org");
    await page.locator("#gb a").evaluate(node => node.setAttribute("aria-label", "Google Account: Personal (personal@example.org)"));
    expect((await readIdentity()).accountEmail).toBe("personal@example.org");
  });
  it("ignores malicious mail HTML, forged headers, hidden accounts, and switcher choices", async () => {
    await load(header() + `<main role="main"><div class="a3s">${header("attacker@example.org")}<a aria-label="Google Account: Forged (forged@example.org)" href="https://accounts.google.com/">Forged</a></div></main><div role="dialog">${header("switcher@example.org")}</div><div hidden>${header("hidden@example.org")}</div>`);
    expect((await readIdentity()).accountEmail).toBe("owner@example.org");
    await page.locator("body > header").evaluate(node => node.remove());
    await expect(readIdentity()).rejects.toThrow("confidently");
  });
  it("reports aggregate-only trusted-header diagnostics without exposing account or URL values", async () => {
    await load(`<main role="main">${header("main-secret@example.org")}</main>
      <div role="dialog">${header("dialog-secret@example.org")}</div>
      <header id="gb"><a href="https://accounts.google.com.evil.example/private?token=secret" aria-label="Google Account: Wrong Host (wrong-secret@example.org)">Account</a></header>
      <div hidden>${header("hidden-secret@example.org")}</div>`);
    expect(await page.evaluate(url => window.RelayExtractors.identityDiagnostics(document, url), MAIL)).toEqual({
      ariaAnchors: 4,
      visibleAnchors: 3,
      trustedAccountHrefs: 3,
      matchingLabels: 4,
      eligibleAnchors: 0,
      excludedAncestors: { any: 2, main: 1, dialog: 1, message: 0, event: 0 }
    });
    let message = "";
    try {
      await readIdentity();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Diagnostic counts (no account values)");
    expect(message).toContain("#gb aria anchors=4; visible=3; trusted accounts.google.com href=3; known label pattern=4; eligible=0");
    expect(message).toContain("excluded ancestors(any=2, main=1, dialog=1, message=0, event=0)");
    expect(message).not.toMatch(/main-secret|dialog-secret|wrong-secret|hidden-secret|evil\.example|token=secret/);
    await installContent(false);
    const response = await command("connect");
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Diagnostic counts (no account values)");
    expect(response.error).not.toMatch(/secret@example|evil\.example|token=secret/);
  });
  it("recognizes Google's membership suffix when the signed-in header finishes loading", async () => {
    await load(header() + inbox);
    await page.locator("#gb a").evaluate(node => {
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", "Google Account: Owner (owner@example.org), Google membership");
    });
    expect((await readIdentity()).accountEmail).toBe("owner@example.org");
    expect((await readCapture()).messages).toHaveLength(1);
  });
  it("recognizes the no-href account button only in Google's top-level banner", async () => {
    const button = '<header id="gb" role="banner"><a role="button" aria-label=" Google Account: Owner (owner@example.org)">Account</a></header>';
    await load(button + inbox);
    expect((await readIdentity()).accountEmail).toBe("owner@example.org");
    await page.locator("#gb a").evaluate(node => node.setAttribute("aria-label", "Compte\u00a0Google\u00a0: Owner (\u202aowner@example.org\u202c)"));
    expect((await readIdentity()).accountEmail).toBe("owner@example.org");
    await page.locator("#gb a").evaluate(node => node.setAttribute("href", "https://evil.example/"));
    await expect(readIdentity()).rejects.toThrow("Cannot confidently");
    for (const wrapper of ["<main role='main'>", "<div role='dialog'>", "<div class='a3s'>", "<div data-legacy-message-id='x'>"]) {
      await load(wrapper + button + (wrapper.startsWith("<main") ? "</main>" : "</div>"));
      await expect(readIdentity()).rejects.toThrow("Cannot confidently");
    }
    await load(button.replace('role="banner"', "") + inbox);
    await expect(readIdentity()).rejects.toThrow("Cannot confidently");
  });
  it("opens only the trusted top-header account menu without navigating existing frames", async () => {
    await load(`${header()}<main role="main"><iframe src="https://ogs.google.com/u/0/widget/account?origin=mail"></iframe></main><iframe id="account-menu" src="https://ogs.google.com/u/0/widget/account?origin=mail"></iframe>`);
    await page.locator("#gb a").evaluate(node => {
      node.setAttribute("aria-expanded", "false");
      node.addEventListener("click", event => {
        event.preventDefault();
        const expanded = node.getAttribute("aria-expanded") === "true";
        node.setAttribute("aria-expanded", String(!expanded));
        node.setAttribute("data-clicks", String(Number(node.getAttribute("data-clicks") || "0") + 1));
      });
    });
    await installContent(false);
    const opened = await command("discover-accounts");
    expect(opened).toMatchObject({ ok: true, value: { accountEmail: "owner@example.org", kind: "mail" } });
    expect(await page.locator("#gb a").getAttribute("data-clicks")).toBe("1");
    expect(await page.locator("#account-menu").getAttribute("src")).toBe("https://ogs.google.com/u/0/widget/account?origin=mail");
    expect((await command("close-account-menu")).ok).toBe(true);
    expect(await page.locator("#gb a").getAttribute("data-clicks")).toBe("2");
  });
  it("fails closed for wrong header destinations, absent headers, ambiguous identities and wrong hosts", async () => {
    await load(header() + inbox);
    await expect(readIdentity("https://mail.google.com.evil.example/mail/u/0")).rejects.toThrow("supported");
    await page.locator("#gb a").evaluate(node => node.setAttribute("href", "https://accounts.google.com.evil.example/"));
    await expect(readIdentity()).rejects.toThrow("confidently");
    await page.locator("#gb a").evaluate(node => node.setAttribute("href", "https://accounts.google.com/"));
    await page.locator("#gb").evaluate(node => {
      const second = node.firstElementChild!.cloneNode(true) as HTMLElement;
      second.setAttribute("aria-label", "Google Account: Other (other@example.org)");
      node.append(second);
    });
    await expect(readIdentity()).rejects.toThrow("confidently");
  });
  it("extracts inbox previews read-only with stable thread IDs and honest date text", async () => {
    await load(header() + inbox);
    const result = await readCapture();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ threadId: "thread-one", subject: "Synthetic subject", sender: "sender@example.org", body: "Preview only",
      dateText: "Yesterday at 9:00", unread: true, completeness: "preview" });
    expect(result.messages[0].receivedAt).toBeUndefined();
    expect(result.coverage).toContain("not full");
  });
  it("captures expanded bodies as plain visible text, not hidden/collapsed content or spoofed metadata", async () => {
    await load(header() + conversation);
    await page.locator(".a3s").first().evaluate(node => {
      const fake = document.createElement("span");
      fake.className = "gD"; fake.setAttribute("email", "fake@example.org");
      fake.textContent = "A sender-looking string in message text";
      node.append(fake);
    });
    const result = await readCapture();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "message-one", threadId: "thread-one", sender: "sender@example.org", recipients: ["recipient@example.org"], completeness: "full" });
    expect(result.messages[0].html).toBeTruthy();
    expect(result.messages[0].html).not.toContain('id="gb"');
    expect(result.messages[0].body).toContain("Full visible body with text");
    expect(result.messages[0].body).not.toMatch(/hidden secret|Collapsed body|<b>/);
    expect(result.messages[0].receivedAt).toBeUndefined();
    expect(result.coverage).toContain("collapsed");
  });
  it("captures attachment names only from provider tiles outside message bodies", async () => {
    await load(header() + conversation);
    await page.locator("[data-message-id='message-one']").evaluate(node => {
      node.insertAdjacentHTML("beforeend", `<div class="aQH">
        <span class="aZo"><span class="aV3">report.pdf</span></span>
        <span class="aZo" hidden><span class="aV3">hidden.pdf</span></span>
        <span class="aZo unsupported-tile"><span class="aV3">../unsafe.pdf</span></span>
      </div>`);
      node.querySelector(".a3s")!.insertAdjacentHTML("beforeend", '<div class="aQH"><span class="aZo"><span class="aV3">forged.pdf</span></span></div>');
    });
    const unverified = await readCapture();
    expect(unverified.messages[0].attachments).toBeUndefined();
    expect(unverified.messages[0].attachmentManifestVersion).toBeUndefined();
    expect(unverified.coverage).toContain("metadata was not captured");
    await page.locator("[data-message-id='message-one'] > .aQH .unsupported-tile").evaluate(node => node.remove());
    expect((await readCapture()).messages[0]).toMatchObject({
      attachmentManifestVersion: 1,
      attachments: [{ id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream" }]
    });
  });
  it("captures modern nested calendar chips using their displayed accessible summary", async () => {
    await load(header() + `<main role="main"><div data-eventid="event-one"><button data-eventid="event-one" aria-label="9am to 10am, Project review, September 23, 2026">Project review</button></div></main>`, CALENDAR);
    const result = await readCapture(CALENDAR);
    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0]).toMatchObject({ id: "event-one", title: "9am to 10am, Project review, September 23, 2026", whenText: "9am to 10am, Project review, September 23, 2026" });
  });
  it("captures grid event text without inventing missing dates", async () => {
    await load(header() + '<main role="main"><div data-eventid="grid-event"><span>Project review</span><span>9am</span></div></main>', CALENDAR);
    const result = await readCapture(CALENDAR);
    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0].title).toContain("Project review");
    expect(result.meetings[0].whenText).toContain("9am");
    expect(result.meetings[0]).not.toHaveProperty("start");
  });
  it("preserves actual Meet destinations in visible mail without accepting lookalike or hidden links", async () => {
    await load(header() + conversation);
    await page.locator(".a3s").first().evaluate(node => {
      for (const [href, hidden] of [
        ["https://meet.google.com/abc-defg-hij?authuser=2", false],
        ["https://meet.google.com.evil.example/xyz-abcd-efg", false],
        ["https://meet.google.com/xyz-abcd-efg", true]
      ] as const) {
        const link = document.createElement("a"); link.href = href; link.hidden = hidden; link.textContent = "Join"; node.append(link);
      }
    });
    const result = await readCapture();
    expect(result.messages[0].body).toContain("Meeting link: https://meet.google.com/abc-defg-hij");
    expect(result.messages[0].body).not.toMatch(/evil\.example|xyz-abcd-efg|authuser/);
  });
  it("rejects unsupported or loading Gmail DOM rather than reporting an empty success", async () => {
    await load(header() + '<main role="main"><table><tbody><tr class="zA" data-legacy-thread-id="unpainted"><td><span email="sender@example.org">Sender</span><span class="bog" style="display:inline-block;width:20px;height:15px"></span><span class="y2" style="display:inline-block;width:20px;height:15px"></span></td></tr></tbody></table></main>');
    await expect(readCapture()).rejects.toThrow("Unsupported");
    await load(header() + '<main role="main">Loading...<div class="a3s">Your inbox is empty.</div></main>');
    await expect(readCapture()).rejects.toThrow("Unsupported");
    await page.locator("main").evaluate(node => { node.innerHTML = '<table><tbody><tr><td class="TC">Your inbox is empty.</td></tr></tbody></table>'; });
    expect((await readCapture()).coverage).toContain("explicitly");
  });
  it("extracts visible calendar events and opened details, preserving display time and exact-host Meet links", async () => {
    await load(header() + `<main role="main"><div data-eventid="event-1" aria-expanded="true" aria-label="Planning, Tomorrow, 9am to 10am"><span class="I0UMhf">Planning</span></div></main><div role="dialog"><h2 id="rAECCd">Planning</h2><div class="AzuXid">Tomorrow, 9am - 10am</div><div class="NI2kfb">Synthetic agenda</div><div class="JAPzS">Room A</div><a href="https://meet.google.com.evil.example/abc-defg-hij">Fake meet</a><a href="https://meet.google.com/abc-defg-hij?authuser=2">Join</a></div>`, CALENDAR);
    const result = await readCapture(CALENDAR);
    expect(result.meetings).toEqual([{ id: "event-1", title: "Planning", whenText: "Tomorrow, 9am - 10am", description: "Synthetic agenda",
      location: "Room A", meetingUrl: "https://meet.google.com/abc-defg-hij", url: CALENDAR }]);
    expect(result.messages).toEqual([]);
  });
  it("reports unsupported calendar views and recognizes only explicit empty states", async () => {
    await load(header() + '<main role="main">Loading...</main>', CALENDAR);
    await expect(readCapture(CALENDAR)).rejects.toThrow("Unsupported");
    await page.locator("main").evaluate(node => { node.innerHTML = '<div role="status">No events</div>'; });
    expect((await readCapture(CALENDAR)).meetings).toEqual([]);
    expect((await readCapture(CALENDAR)).coverage).toContain("explicitly");
  });
  it("retains agenda display time and any already-visible validated meeting link without opening the event", async () => {
    await load(header() + '<main role="main"><div data-eventid="agenda-1" aria-label="Planning, Monday, 9am"><span class="I0UMhf">Planning</span><a href="https://meet.google.com/abc-defg-hij">Join</a></div></main>', CALENDAR);
    const result = await readCapture(CALENDAR);
    expect(result.meetings).toEqual([{ id: "agenda-1", title: "Planning", whenText: "Planning, Monday, 9am",
      description: "", location: "", meetingUrl: "https://meet.google.com/abc-defg-hij", url: CALENDAR }]);
  });
  it("does not extract content before selection, then supports manual capture after selection", async () => {
    await load(header() + inbox);
    await installContent(false);
    expect((await command("capture")).ok).toBe(true);
    let state = await page.evaluate(() => ({ calls: window.relayFixture.calls, extractionCalls: window.relayFixture.extractionCalls }));
    expect(state.extractionCalls).toBe(0);
    expect(state.calls.length).toBeGreaterThanOrEqual(1);
    expect(state.calls.every(call => call.type === "discover")).toBe(true);
    expect(state.calls[0]).toEqual({ type: "discover", payload: registration });
    await page.evaluate(() => { window.relayFixture.enabled = true; });
    expect((await command("connect")).ok).toBe(true);
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    expect((await command("capture")).ok).toBe(true);
    state = await page.evaluate(() => ({ calls: window.relayFixture.calls, extractionCalls: window.relayFixture.extractionCalls }));
    expect(state.extractionCalls).toBe(1);
    expect(state.calls.at(-1)?.type).toBe("capture");
    const response = await command("status");
    expect(response.value).toMatchObject({ status: expect.stringContaining("1 loaded inbox preview") });
  });
  it("automatically discovers an unselected account without manual capture or content extraction", async () => {
    await load(header() + inbox);
    await installContent(false);
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length), { timeout: 5000 }).toBe(1);
    expect(await page.evaluate(() => window.relayFixture.calls)).toEqual([{ type: "discover", payload: registration }]);
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    expect((await command("status")).value).toMatchObject({ status: expect.stringContaining("capture is not enabled") });
  });
  it("does not postpone discovery indefinitely while Gmail keeps updating its DOM", async () => {
    await load(header() + inbox);
    await installContent(false);
    const timer = await page.evaluate(() => {
      const activity = document.createElement("span");
      document.body.append(activity);
      return window.setInterval(() => { activity.textContent = String(Date.now()); }, 100);
    });
    try {
      await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length), { timeout: 4000 }).toBe(1);
      expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    } finally { await page.evaluate(timer => window.clearInterval(timer), timer); }
  });
  it("uses the configured cadence for periodic capture and honors manual refresh requests between intervals", async () => {
    await load(header() + inbox);
    await installContent(true, { refreshIntervalSeconds: 3600 });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(1);
    const timer = await page.evaluate(() => {
      const activity = document.createElement("span");
      document.body.append(activity);
      return window.setInterval(() => { activity.textContent = String(Date.now()); }, 75);
    });
    try {
      await page.waitForTimeout(2500);
      expect(await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(1);
      await page.evaluate(() => { window.relayFixture.refreshRequestedAt = Date.now(); });
      await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 10000 }).toBe(2);
    } finally { await page.evaluate(timer => window.clearInterval(timer), timer); }
  });
  it("retains a hidden-tab manual refresh request until the tab becomes visible", async () => {
    await load(header() + inbox);
    await installContent(true, { refreshIntervalSeconds: 0 });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length), { timeout: 5000 }).toBe(1);
    expect(await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      window.relayFixture.refreshRequestedAt = Date.now();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(1);
  });
  it("retains a manual refresh request across metadata-only connect until the next heartbeat captures", async () => {
    await load(header() + inbox);
    await installContent(true, { refreshIntervalSeconds: 0 });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length), { timeout: 5000 }).toBe(1);
    await page.evaluate(() => { window.relayFixture.refreshRequestedAt = Date.now(); });
    expect((await command("connect")).ok).toBe(true);
    expect(await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("hashchange")));
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(1);
  });
  it("retains refresh for a newly discovered hidden account until its source is enabled", async () => {
    await load(header("new-account@example.org") + inbox);
    await installContent(false, { refreshIntervalSeconds: 0, refreshRequestedAt: 123, backgroundCapture: true, visibilityState: "hidden" });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    await page.evaluate(() => { window.relayFixture.enabled = true; window.dispatchEvent(new Event("hashchange")); });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(1);
    const first = await page.evaluate(() => window.relayFixture.calls.find(call => call.type === "capture")!.payload);
    expect(first).toMatchObject({ accountEmail: "new-account@example.org" });
    await page.locator(".y2").evaluate(node => { node.textContent = "Updated newly connected inbox"; });
    await page.evaluate(() => { window.relayFixture.refreshRequestedAt = 124; window.dispatchEvent(new Event("hashchange")); });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(2);
    const last = await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").at(-1)!.payload);
    expect(last).toMatchObject({ messages: [{ body: "Updated newly connected inbox" }] });
  });
  it("uses Gmail's own inbox refresh before capturing new account mail without reloading the page", async () => {
    await load(header("new-account@example.org") + inbox);
    await page.locator("main").evaluate(main => {
      const refresh = document.createElement("button");
      refresh.setAttribute("aria-label", "Refresh");
      refresh.textContent = "Refresh";
      refresh.onclick = () => { main.querySelector(".y2")!.textContent = "Fresh provider response"; };
      main.prepend(refresh);
    });
    await installContent(true, { refreshIntervalSeconds: 0, backgroundCapture: true, visibilityState: "hidden" });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.length)).toBeGreaterThan(0);
    await page.evaluate(() => { window.relayFixture.refreshRequestedAt = Date.now(); window.dispatchEvent(new Event("hashchange")); });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(1);
    expect(await page.evaluate(() => window.relayFixture.calls.find(call => call.type === "capture")!.payload))
      .toMatchObject({ accountEmail: "new-account@example.org", messages: [{ body: "Fresh provider response" }] });
    expect(page.url()).toBe(MAIL);
  });
  it.each([false, true])("pairs a profile with an empty optional account link without depending on current-tab discovery (%s)", async failDiscovery => {
    await load(readFileSync(resolve(directory, "popup.html"), "utf8"));
    await page.evaluate(failDiscovery => {
      window.relayPopupFixture = { paired: false, calls: [] };
      Object.defineProperty(window, "chrome", { value: { runtime: {
        sendMessage: async (message: Window["relayPopupFixture"]["calls"][number]) => {
          window.relayPopupFixture.calls.push(structuredClone(message));
          if (message.type === "pair") window.relayPopupFixture.paired = true;
          if (message.type === "state" || message.type === "pair") return { ok: true, value: { paired: window.relayPopupFixture.paired } };
          if (message.action === "connect" && failDiscovery) return { ok: false, error: "Reload this Gmail tab and retry." };
          return { ok: true, value: { status: message.action === "connect" ? "Account discovered; select its source in Relay Desk." : "Ready to pair." } };
        }
      } } });
    }, failDiscovery);
    await page.addScriptTag({ path: resolve(directory, "popup.js") });
    await expect.poll(() => page.locator("#pair-state").textContent()).toContain("Not paired");
    await page.locator("#code").fill("123456");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.poll(() => page.locator("#status").textContent()).toContain("Browser profile paired. No account link is needed.");
    expect(await page.locator("#code").inputValue()).toBe("");
    expect(await page.locator("#pair-state").textContent()).toContain("Paired with");
    const calls = await page.evaluate(() => window.relayPopupFixture.calls);
    expect(calls.filter(call => call.type === "pair")).toEqual([{ type: "pair", code: "123456" }]);
    expect(calls.some(call => call.type === "current-tab" || call.type === "add-account-link")).toBe(false);
    expect(await page.locator("#account-link").inputValue()).toBe("");
    expect(calls.some(call => call.action === "capture")).toBe(false);
  });
  it("submits a manual account link without pairing again or navigating the popup form", async () => {
    await load(readFileSync(resolve(directory, "popup.html"), "utf8"));
    await page.evaluate(() => {
      Object.defineProperty(window, "chrome", { value: { runtime: {
        sendMessage: async (message: { type: string; url?: string }) => {
          if (message.type === "state") return { ok: true, value: { paired: true } };
          if (message.type === "add-account-link") return { ok: true, value: { message: `Account verified: ${message.url}` } };
          return { ok: true, value: { status: "Ready" } };
        }
      } } });
    });
    await page.addScriptTag({ path: resolve(directory, "popup.js") });
    await expect.poll(() => page.locator("#pair-state").textContent()).toContain("Paired");
    await page.locator("summary").click();
    await page.locator("#account-link").fill("https://mail.google.com/mail/u/2/#inbox");
    await page.getByRole("button", { name: "Add account by link", exact: true }).click();
    await expect.poll(() => page.locator("#status").textContent()).toContain("Account verified: https://mail.google.com/mail/u/2/#inbox");
    expect(page.url()).toBe(MAIL);
  });
  it.each([false, true])("requests optional account-menu access directly from the popup gesture before discovery (%s)", async granted => {
    await load(`<form id="pair-form"><input id="code"><button type="submit">Pair</button></form><p id="pair-state"></p><p id="status"></p>
      <button id="connect">Connect</button><button id="discover-signed-in-accounts">Discover signed-in Google accounts</button>
      <button id="discover-open-tabs">Discover open Google accounts</button><button id="capture">Capture</button>
      <button id="reload">Reload</button><button id="fresh-account-views">Fresh</button><button id="forget">Forget</button>`);
    await page.evaluate(({ granted, id }) => {
      window.relayPermissionEvents = [];
      Object.defineProperty(window, "chrome", { value: {
        permissions: {
          request: async (request: unknown) => {
            window.relayPermissionEvents.push({ kind: "permission", value: structuredClone(request) });
            return granted;
          }
        },
        runtime: {
          id,
          reload: () => undefined,
          sendMessage: async (message: { type: string; action?: string }) => {
            window.relayPermissionEvents.push({ kind: "message", value: structuredClone(message) });
            if (message.type === "state") return { ok: true, value: { paired: true } };
            if (message.type === "current-tab") return { ok: true, value: { status: "Ready." } };
            if (message.type === "discover-signed-in-accounts") {
              return { ok: true, value: { message: "Found all signed-in candidates." } };
            }
            return { ok: true, value: {} };
          }
        }
      } });
    }, { granted, id: ID });
    await page.addScriptTag({ path: resolve(directory, "popup.js") });
    await page.getByRole("button", { name: "Discover signed-in Google accounts" }).click();
    await expect.poll(() => page.locator("#status").textContent()).toContain(granted ? "Found all signed-in candidates" : "was not granted");
    const events = await page.evaluate(() => window.relayPermissionEvents);
    const permissionIndex = events.findIndex(event => event.kind === "permission");
    const discoveryIndex = events.findIndex(event => event.kind === "message"
      && (event.value as { type?: string }).type === "discover-signed-in-accounts");
    expect(events[permissionIndex].value).toEqual({
      permissions: ["scripting"],
      origins: ["https://ogs.google.com/*"]
    });
    expect(granted ? discoveryIndex > permissionIndex : discoveryIndex === -1).toBe(true);
  });
  it.each([false, undefined])("keeps selected hidden pages metadata-only without explicit background opt-in (%s)", async backgroundCapture => {
    await load(header() + inbox);
    await installContent(true, { backgroundCapture, visibilityState: "hidden" });
    await command("capture");
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    expect(await page.evaluate(() => window.relayFixture.calls.every(call => call.type === "discover"))).toBe(true);
    expect((await command("status")).value).toMatchObject({ status: expect.stringContaining("tab stays hidden") });
  });
  it("captures changed loaded content in a hidden opted-in tab at cadence and on manual refresh", async () => {
    await load(header() + inbox);
    await installContent(true, { backgroundCapture: true, refreshIntervalSeconds: 3600, visibilityState: "hidden" });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(1);
    await page.locator(".bog").evaluate(node => { node.textContent = "Changed while hidden"; });
    await page.evaluate(() => {
      window.relayFixture.refreshRequestedAt = Date.now();
      window.dispatchEvent(new Event("hashchange"));
    });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length), { timeout: 5000 }).toBe(2);
    const state = await page.evaluate(() => ({
      extractionCalls: window.relayFixture.extractionCalls,
      last: window.relayFixture.calls.filter(call => call.type === "capture").at(-1),
    }));
    expect(state.extractionCalls).toBe(2);
    expect((state.last?.payload as BrowserCapture).messages[0].subject).toBe("Changed while hidden");
    expect((await command("status")).value).toMatchObject({ status: expect.stringContaining("Loaded hidden page DOM only") });
  });
  it("does not read a paused or disabled hidden source even when background capture is allowed", async () => {
    await load(header() + inbox);
    await installContent(false, { backgroundCapture: true, visibilityState: "hidden" });
    await page.evaluate(() => { window.relayFixture.refreshRequestedAt = Date.now(); });
    expect((await command("capture")).ok).toBe(true);
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(0);
    expect(await page.evaluate(() => window.relayFixture.calls.every(call => call.type === "discover"))).toBe(true);
    expect((await command("status")).value).toMatchObject({ status: expect.stringContaining("capture is not enabled") });
  });
  it("does not lose an in-flight manual capture when visibility changes to an opted-in hidden page", async () => {
    await load(header() + inbox);
    await installContent(true, {
      backgroundCapture: true,
      refreshIntervalSeconds: 0,
      discoverDelayMs: 250,
    });
    await expect.poll(() => page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "discover").length), { timeout: 5000 }).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const response = await command("capture");
    expect(response.ok).toBe(true);
    expect(await page.evaluate(() => window.relayFixture.calls.filter(call => call.type === "capture").length)).toBe(1);
    expect(await page.evaluate(() => window.relayFixture.extractionCalls)).toBe(1);
  });
  it("surfaces extraction errors without sending an empty capture", async () => {
    await load(header() + '<main role="main">Unknown layout</main>');
    await installContent(true);
    const response = await command("capture");
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Unsupported");
    expect(await page.evaluate(() => window.relayFixture.calls.every(call => call.type === "discover"))).toBe(true);
    expect((await command("status")).value).toMatchObject({ status: expect.stringContaining("Not captured") });
  });
});
