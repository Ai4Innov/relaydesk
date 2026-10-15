import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserRegistration } from "../src/shared/browser";

const directory = resolve(import.meta.dirname, "..", "browser-extension");
const require = createRequire(import.meta.url);
const ID = "haiiamalgpmpjeaaldpdopnaogallplh";
const MAIL = "https://mail.google.com/mail/u/0/#inbox";
const OGS = "https://ogs.google.com/u/0/widget/account?origin=https%3A%2F%2Fmail.google.com";
const popupSender = { id: ID, url: `chrome-extension://${ID}/popup.html` };

interface Sender {
  id: string;
  url: string;
  tab?: { id: number; url: string };
  frameId?: number;
  documentId?: string;
}

interface Command {
  type: string;
  url?: string;
  payload?: BrowserRegistration;
  scanId?: string;
  candidates?: Array<{ email: string; href: string }>;
  expired?: number;
}

const background: {
  createBridge(chrome: ReturnType<typeof mockChrome>["chrome"], fetch: typeof globalThis.fetch): {
    handle(command: Command, sender: Sender): Promise<unknown>;
  };
} = require(resolve(directory, "background.js"));

function mockChrome(permission = true) {
  const state: { token?: string } = { token: "paired-token" };
  const tabState = new Map<number, { id: number; url: string; active?: boolean; pinned?: boolean; pendingUrl?: string }>([[7, { id: 7, url: MAIL }]]);
  const session: Record<string, unknown> = {};
  const registered: Array<{ id: string }> = [];
  let nextTabId = 90;
  const chrome = {
    runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path}` },
    storage: { local: {
      setAccessLevel: vi.fn(async (_options: { accessLevel: string }) => undefined),
      get: vi.fn(async (_key: string) => ({ ...state })),
      set: vi.fn(async (value: { token: string }) => { state.token = value.token; }),
      remove: vi.fn(async (_key: string) => { delete state.token; })
    }, session: {
      setAccessLevel: async () => {},
      get: async (key: string) => ({ [key]: structuredClone(session[key]) }),
      set: async (values: Record<string, unknown>) => { Object.assign(session, structuredClone(values)); }
    } },
    permissions: {
      contains: vi.fn(async (_request: { permissions: string[]; origins: string[] }) => permission)
    },
    scripting: {
      executeScript: vi.fn(async (_options: unknown) => []),
      getRegisteredContentScripts: vi.fn(async (_filter: { ids: string[] }) => [...registered]),
      registerContentScripts: vi.fn(async (scripts: Array<{ id: string }>) => { registered.push(...scripts); })
    },
    tabs: {
      get: vi.fn(async (id: number) => tabState.get(id)),
      query: vi.fn(async (_query?: unknown) => [...tabState.values()]),
      create: vi.fn(async (options: { url: string; active: boolean }) => {
        const tab = { id: ++nextTabId, url: options.url };
        tabState.set(tab.id, tab);
        return tab;
      }),
      update: vi.fn(async (id: number, options: { url: string }) => {
        const tab = { id, url: options.url };
        tabState.set(id, tab);
        return tab;
      }),
      remove: vi.fn(async (id: number) => { tabState.delete(id); }),
      sendMessage: vi.fn(async (_id: number, _message: { type: string; action: string }, _options: { frameId: number }) => ({
        ok: true,
        value: {}
      }))
    }
  };
  return { chrome, state, tabState, registered, session };
}

function setup(permission = true) {
  const fixture = mockChrome(permission);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ accountId: "account", enabled: true }));
  const bridge = background.createBridge(fixture.chrome, fetch);
  return { ...fixture, fetch, handle: bridge.handle };
}

function menuSender(overrides: Partial<Sender> = {}): Sender {
  return {
    id: ID,
    url: OGS,
    tab: { id: 7, url: MAIL },
    frameId: 3,
    ...overrides
  };
}

async function startScan(handle: ReturnType<typeof setup>["handle"], chrome: ReturnType<typeof mockChrome>["chrome"]) {
  const before = chrome.tabs.sendMessage.mock.calls.filter(call => call[1].action === "discover-accounts").length;
  const scan = handle({ type: "discover-signed-in-accounts" }, popupSender);
  await vi.waitFor(() => {
    expect(chrome.tabs.sendMessage.mock.calls.filter(call => call[1].action === "discover-accounts").length).toBeGreaterThan(before);
  });
  return { scan };
}

async function submitMenu(handle: ReturnType<typeof setup>["handle"], candidates: Array<{ email: string; href: string }>, expired = 0) {
  const ready = await handle({ type: "account-menu-ready" }, menuSender()) as { scanId: string };
  await handle({ type: "account-menu", scanId: ready.scanId, candidates, expired }, menuSender());
}

describe("signed-in Google account discovery worker", () => {
  function pageStatus(h: ReturnType<typeof setup>, dirty = new Set<number>()) {
    const identities = new Map<number, BrowserRegistration>();
    h.chrome.tabs.sendMessage.mockImplementation(async (id, message) => ({
      ok: true, value: message.action === "mail-read-status" ? { dirty: dirty.has(id),
        registration: identities.get(id) } : {}
    }));
    return async (id: number, email = "owner@example.org", kind: "mail" | "calendar" | "whatsapp" = "mail") => {
      const tab = h.tabState.get(id)!;
      const registration = { accountEmail: email, accountName: "Owner", pageUrl: tab.url, kind };
      identities.set(id, registration);
      return await h.handle({ type: "discover", payload: registration },
        { id: ID, tab, url: tab.url, frameId: 0, documentId: `document-${id}` });
    };
  }

  it("coalesces simultaneous fresh-view clicks and reuses verified pages without touching original editors", async () => {
    const h = setup();
    h.tabState.get(7)!.url = "https://mail.google.com/mail/u/0/#drafts";
    h.tabState.set(8, { id: 8, url: "https://calendar.google.com/calendar/u/1/r/eventedit/private", active: true });
    const register = pageStatus(h);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      h.handle({ type: "fresh-account-views" }, popupSender)));
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(expect.objectContaining({ opened: 2 }));
    await register(91);
    await register(92, "owner@example.org", "calendar");
    for (let i = 0; i < 4; i++)
      expect(await h.handle({ type: "fresh-account-views" }, popupSender)).toMatchObject({ opened: 0, reused: 2 });
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(await h.handle({ type: "cleanup-agent-tabs" }, popupSender)).toMatchObject({ closed: 2, retained: 0 });
    expect([...h.tabState.keys()]).toEqual([7, 8]);
  });

  it("reuses a verified user page for account links without taking ownership or navigating its draft", async () => {
    const h = setup();
    h.tabState.get(7)!.url = "https://mail.google.com/mail/u/0/#drafts";
    const register = pageStatus(h, new Set([7]));
    await register(7);
    for (let i = 0; i < 5; i++)
      await expect(h.handle({ type: "add-account-link", url: "https://mail.google.com/mail/?authuser=owner%40example.org" },
        popupSender)).resolves.toMatchObject({ message: expect.stringContaining("verified") });
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    expect(await h.handle({ type: "cleanup-agent-tabs" }, popupSender)).toMatchObject({ closed: 0, retained: 0 });
    expect(h.tabState.get(7)!.url).toContain("#drafts");
  });

  it("coalesces repeated WhatsApp opening before and after own-profile verification", async () => {
    const h = setup();
    const register = pageStatus(h);
    await Promise.all(Array.from({ length: 5 }, () => h.handle({ type: "open-whatsapp" }, popupSender)));
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    await register(91, "+33612345678", "whatsapp");
    await h.handle({ type: "open-whatsapp" }, popupSender);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    expect(await h.handle({ type: "tab-management" }, popupSender)).toMatchObject({ mailOwned: 0, mailIdle: 0, viewOwned: 1, limit: 30 });
  });

  it("reuses session-owned verified account views after worker restart and repeated signed-in discovery", async () => {
    const h = setup();
    const register = pageStatus(h);
    const { scan } = await startScan(h.handle, h.chrome);
    await submitMenu(h.handle, [{ email: "owner@example.org", href: "https://mail.google.com/mail/u/2/" }]);
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
    h.tabState.get(91)!.url = "https://mail.google.com/mail/u/2/#inbox";
    await register(91);
    expect(await scan).toMatchObject({ opened: 1 });
    const restarted = background.createBridge(h.chrome, h.fetch).handle;
    for (let i = 0; i < 3; i++) {
      const next = await startScan(restarted, h.chrome);
      await submitMenu(restarted, [{ email: "owner@example.org", href: "https://mail.google.com/mail/u/7/" }]);
      expect(await next.scan).toMatchObject({ connected: 1, opened: 0 });
    }
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it("preserves owned views when status is dirty, active, pinned, pending or unavailable", async () => {
    for (const state of ["dirty", "active", "pinned", "pending", "unavailable"]) {
      const h = setup();
      h.tabState.get(7)!.url = "https://mail.google.com/mail/u/0/#drafts";
      const dirty = new Set<number>();
      const register = pageStatus(h, dirty);
      await h.handle({ type: "fresh-account-views" }, popupSender);
      await register(91);
      if (state === "dirty") dirty.add(91);
      if (state === "active") h.tabState.get(91)!.active = true;
      if (state === "pinned") h.tabState.get(91)!.pinned = true;
      if (state === "pending") h.tabState.get(91)!.pendingUrl = "https://mail.google.com/mail/u/0/#drafts";
      if (state === "unavailable") h.chrome.tabs.sendMessage.mockRejectedValue(new Error("No receiver"));
      expect(await h.handle({ type: "cleanup-agent-tabs" }, popupSender)).toMatchObject({ closed: 0, retained: 1 });
      expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
    }
  });

  it("bounds unresolved views globally and does not navigate user pages to bypass the limit", async () => {
    const h = setup();
    h.tabState.clear();
    for (let slot = 0; slot < 24; slot++)
      h.tabState.set(slot, { id: slot, url: `https://calendar.google.com/calendar/u/${slot}/r/eventedit/private`, active: true });
    expect(await h.handle({ type: "fresh-account-views" }, popupSender)).toMatchObject({ opened: 24 });
    expect(await h.handle({ type: "fresh-account-views" }, popupSender)).toMatchObject({ opened: 0, reused: 24 });
    await expect(h.handle({ type: "open-whatsapp" }, popupSender)).rejects.toThrow("tab limit reached");
    expect(await h.handle({ type: "tab-management" }, popupSender)).toMatchObject({
      debug: { lastReason: "viewCapacity", reasons: { viewCapacity: 1 } }
    });
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(24);
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    expect(await h.handle({ type: "cleanup-agent-tabs" }, popupSender)).toMatchObject({ closed: 0, retained: 24 });
  });

  it("requires the optional grant before registering or reading the account menu", async () => {
    const { chrome, handle } = setup(false);
    await expect(handle({ type: "discover-signed-in-accounts" }, popupSender)).rejects.toThrow("Optional Google account-menu access");
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("registers one fixed isolated all-frame reader with the exact ogs matches", async () => {
    const { chrome, handle } = setup();
    const { scan } = await startScan(handle, chrome);
    await submitMenu(handle, []);
    await expect(scan).resolves.toMatchObject({ candidates: 0, opened: 0 });
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([{
      id: "relay-google-account-menu",
      matches: ["https://ogs.google.com/*/widget/account*", "https://ogs.google.com/widget/account*"],
      js: ["accounts.js"],
      allFrames: true,
      runAt: "document_idle",
      world: "ISOLATED",
      persistAcrossSessions: true
    }]);
  });

  it("rejects unsolicited, top-frame, foreign, wrong-path, and wrong-profile menu messages", async () => {
    const { chrome, handle } = setup();
    await expect(handle({ type: "account-menu-ready" }, menuSender())).rejects.toThrow("No explicit");
    const { scan } = await startScan(handle, chrome);
    for (const sender of [
      menuSender({ id: "foreign" }),
      menuSender({ frameId: 0 }),
      menuSender({ url: "https://ogs.google.com/u/0/widget/account/extra" }),
      menuSender({ tab: { id: 7, url: "https://evil.example/mail/u/0/" } })
    ]) {
      await expect(handle({ type: "account-menu-ready" }, sender)).rejects.toThrow();
    }
    await submitMenu(handle, []);
    await expect(scan).resolves.toMatchObject({ opened: 0 });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("deduplicates normalized candidates, ignores numeric slots as identity, and opens canonical inactive inboxes", async () => {
    const { chrome, tabState, handle } = setup();
    const { scan } = await startScan(handle, chrome);
    await submitMenu(handle, [
      { email: "Second@Example.org", href: "https://mail.google.com/mail/u/2/" },
      { email: "second@example.org", href: "https://mail.google.com/mail/u/3/" }
    ], 1);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledTimes(1));
    const created = [...tabState.values()].find(tab => tab.id !== 7)!;
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://mail.google.com/mail/?authuser=second%40example.org#inbox",
      active: false
    });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    const registration: BrowserRegistration = {
      accountEmail: "second@example.org",
      accountName: "Second",
      pageUrl: created.url,
      kind: "mail"
    };
    await handle({ type: "discover", payload: registration }, {
      id: ID,
      url: created.url,
      tab: created,
      frameId: 0
    });
    await expect(scan).resolves.toMatchObject({
      candidates: 1,
      discovered: 1,
      opened: 1,
      expired: 1
    });
  });

  it("does not trust a candidate when the opened inbox verifies a different top-header identity", async () => {
    const { chrome, tabState, fetch, handle } = setup();
    const { scan } = await startScan(handle, chrome);
    await submitMenu(handle, [{ email: "expected@example.org", href: "https://mail.google.com/mail/u/2/" }]);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledTimes(1));
    const created = [...tabState.values()].find(tab => tab.id !== 7)!;
    await expect(handle({
      type: "discover",
      payload: { accountEmail: "wrong@example.org", accountName: "Wrong", pageUrl: created.url, kind: "mail" }
    }, {
      id: ID,
      url: created.url,
      tab: created,
      frameId: 0
    })).rejects.toThrow("redirected account was not registered");
    await expect(scan).rejects.toThrow("verified header shows wrong@example.org");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only prior top-frame verified registrations to skip an already connected email", async () => {
    const { chrome, fetch, handle } = setup();
    const owner: BrowserRegistration = {
      accountEmail: "owner@example.org",
      accountName: "Owner",
      pageUrl: MAIL,
      kind: "mail"
    };
    await handle({ type: "discover", payload: owner }, { id: ID, url: MAIL, tab: { id: 7, url: MAIL }, frameId: 0, documentId: "document-7" });
    chrome.tabs.sendMessage.mockImplementation(async (_id, message) => ({ ok: true,
      value: message.action === "mail-read-status" ? { dirty: false, registration: owner } : {} }));
    const { scan } = await startScan(handle, chrome);
    await submitMenu(handle, [{ email: "OWNER@example.org", href: "https://mail.google.com/mail/u/2/" }]);
    await expect(scan).resolves.toMatchObject({ candidates: 1, connected: 1, opened: 0 });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/discover"))).toHaveLength(1);
  });

  it("rejects chooser, query-bearing, oversized, and non-pending metadata without opening tabs", async () => {
    const { chrome, handle } = setup();
    const { scan } = await startScan(handle, chrome);
    const ready = await handle({ type: "account-menu-ready" }, menuSender()) as { scanId: string };
    await expect(handle({
      type: "account-menu",
      scanId: ready.scanId,
      candidates: [{ email: "expired@example.org", href: "https://accounts.google.com/AccountChooser?Email=expired@example.org" }],
      expired: 1
    }, menuSender())).rejects.toThrow("invalid account row");
    await expect(handle({
      type: "account-menu",
      scanId: ready.scanId,
      candidates: [{ email: "query@example.org", href: "https://mail.google.com/mail/u/2/?authuser=query@example.org" }],
      expired: 0
    }, menuSender())).rejects.toThrow("invalid account row");
    await handle({ type: "account-menu", scanId: ready.scanId, candidates: [], expired: 1 }, menuSender());
    await expect(scan).resolves.toMatchObject({ candidates: 0, expired: 1 });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("returns an actionable error when loaded Google tabs need an extension reload", async () => {
    const { chrome, handle } = setup();
    chrome.tabs.sendMessage.mockRejectedValue(new Error("No receiver"));
    await expect(handle({ type: "discover-signed-in-accounts" }, popupSender)).rejects.toThrow("Reload this Gmail, Calendar or WhatsApp Web tab");
  });

  it.each([
    ["https://mail.google.com/mail/u/2/?search=private#drafts/secret", "https://mail.google.com/mail/u/2/#inbox", "mail"],
    ["https://calendar.google.com/calendar/u/3/r/eventedit/secret?authuser=owner%40example.org", "https://calendar.google.com/calendar/u/3/?authuser=owner%40example.org#agenda", "calendar"]
  ])("adds a manual account link only after real header registration: %s", async (url, expected, kind) => {
    const { chrome, tabState, fetch, handle } = setup();
    const added = handle({ type: "add-account-link", url }, popupSender);
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalled();
    const tab = [...tabState.values()].find(value => value.id !== 7)!;
    expect(tab.url).toBe(expected);
    await handle({ type: "discover", payload: { accountEmail: "owner@example.org", accountName: "Owner", pageUrl: tab.url, kind: kind as "mail" | "calendar" } },
      { id: ID, tab, url: tab.url, frameId: 0 });
    await expect(added).resolves.toMatchObject({ message: expect.stringContaining("Account verified") });
  });

  it.each([
    "http://mail.google.com/mail/u/2/", "https://mail.google.com.evil.example/mail/u/2/",
    "https://user:pass@mail.google.com/mail/", "https://mail.google.com:8443/mail/",
    "https://accounts.google.com/Logout", "https://mail.google.com/mail/u/%32/",
    "https://mail.google.com/mail/?authuser=a&authuser=b", "https://mail.google.com/mail/u/nope/"
  ])("rejects an unsafe or ambiguous manual account link: %s", async url => {
    const { chrome, handle } = setup();
    await expect(handle({ type: "add-account-link", url }, popupSender)).rejects.toThrow();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

const browserAvailable = existsSync(chromium.executablePath()) || process.env.RELAY_EXTENSION_TEST_EDGE === "1";
describe.skipIf(!browserAvailable)("Google account menu isolated frame fixture", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reads only visible exact Gmail switch rows after an explicit child-frame handshake", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname === "ogs.google.com") {
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><body>
              <button>Active active@example.org</button>
              <a href="https://mail.google.com/mail/u/2/" aria-label="Work work@example.org">work@example.org</a>
              <a href="https://calendar.google.com/calendar/u/4/" aria-label="Calendar calendar@example.org">calendar@example.org</a>
              <a href="https://mail.google.com/mail/u/3/" aria-label="Two first@example.org second@example.org">Two emails</a>
              <a href="https://mail.google.com/mail/u/4/" hidden>hidden@example.org</a>
              <a href="https://mail.google.com.evil.example/mail/u/5/">evil@example.org</a>
              <a href="https://accounts.google.com/AccountChooser?Email=expired@example.org" aria-label="Session expired expired@example.org">Session expired</a>
              <a href="https://accounts.google.com/AccountChooser?Email=signedout@example.org">Choose an account</a>
            </body></html>`
          });
        }
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body>
            <main role="main"><a href="https://mail.google.com/mail/u/9/">fake@example.org</a></main>
            <iframe src="${OGS}"></iframe>
          </body></html>`
        });
      });
      await page.goto(MAIL);
      await expect.poll(() => page.frames().some(candidate => candidate.url().startsWith("https://ogs.google.com/"))).toBe(true);
      const target = page.frames().find(candidate => candidate.url().startsWith("https://ogs.google.com/"))!;
      await target.evaluate(id => {
        const sent: unknown[] = [];
        Object.defineProperty(window, "relayMessages", { value: sent });
        Object.defineProperty(window, "chrome", { value: { runtime: {
          id,
          sendMessage: async (message: unknown) => {
            sent.push(structuredClone(message));
            return (message as { type?: string }).type === "account-menu-ready"
              ? { ok: true, value: { scanId: "explicit-scan" } }
              : { ok: true, value: { accepted: true } };
          }
        } } });
      }, ID);
      await target.addScriptTag({ path: resolve(directory, "accounts.js") });
      await expect.poll(() => target.evaluate(() => (window as unknown as { relayMessages: unknown[] }).relayMessages.length)).toBe(2);
      expect(await target.evaluate(() => (window as unknown as { relayMessages: unknown[] }).relayMessages)).toEqual([
        { type: "account-menu-ready" },
        {
          type: "account-menu",
          scanId: "explicit-scan",
          candidates: [
            { email: "work@example.org", href: "https://mail.google.com/mail/u/2/" },
            { email: "calendar@example.org", href: "https://calendar.google.com/calendar/u/4/" }
          ],
          expired: 1
        }
      ]);
    } finally {
      await page.close();
    }
  });
});
