import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { BrowserBridge } from "../src/main/browser/bridge";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const directory = resolve(import.meta.dirname, "..", "browser-extension");
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
const hostPrefixes: string[] = manifest.host_permissions.map((pattern: string) => pattern.replace(/\*$/, ""));
const input = { accountId: "mail-owner", accountEmail: "owner@example.org", threadId: "18abc" };
const inbox = "https://mail.google.com/mail/u/2/#inbox";
const canonical = "https://mail.google.com/mail/?authuser=owner%40example.org#inbox";
const registration = { kind: "mail", accountEmail: input.accountEmail, accountName: "Owner", pageUrl: inbox };
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
});

// A fresh VM runs the manifest's actual service-worker entry point, including its
// runtime and alarm listeners. Storage/tabs/alarms survive VM termination, pages
// do not send a discover heartbeat unless a test explicitly releases their header.
async function fixture() {
  const vault = new Map<string, unknown>();
  let captureEnabled = false;
  const bridge = new BrowserBridge({
    get: <T>(_collection: "secrets", id: string) => vault.get(id) as T | undefined,
    put: (_collection, id, value) => { vault.set(id, value); },
    delete: (_collection, id) => { vault.delete(id); },
  }, {
    extensionId, port: 0, changed: () => {},
    refreshSettings: () => ({ paused: true, intervalSeconds: 0 }),
    onDiscover: async value => ({ accountId: value.accountEmail === input.accountEmail ? input.accountId : "mail-other", enabled: captureEnabled }),
    onCapture: async () => { throw new Error("Wake must never enable capture."); },
  });
  const code = await bridge.pair();
  const base = `http://127.0.0.1:${bridge.status().port}`;
  expect(bridge.status().port).not.toBe(43891);
  async function post(path: string, body: unknown, token?: string) {
    return fetch(`${base}${path}`, { method: "POST", headers: {
      Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body) });
  }
  const token = (await (await post("/pair", { code: code.code })).json()).token;
  const stored: Record<string, any> = { token };
  const tabs = new Map<number, any>([[10, { id: 10, windowId: 5, url: inbox, active: true, discarded: true }]]);
  const dirty = new Set<number>(), readyPages = new Set<number>();
  const accounts = new Map<number, string>();
  const slots = new Map([[input.accountEmail, 2], ["other@example.org", 3]]);
  const calls: Array<{ path: string; body: any }> = [];
  const reads: Promise<any>[] = [];
  let inFlight = 0, nextTab = 100, deferRead = false;
  let receive: (message: any, sender: any, respond: (value: any) => void) => void;
  let alarm: (value: { name: string }) => void;
  let activated: (value: any) => void, removed: (id: number) => void, updated: (id: number, change: any) => void;
  let timers = new Set<ReturnType<typeof setTimeout>>();
  let onCreate: ((tab: any) => Promise<void>) | undefined;
  function exposedTab(tab: any) {
    const exposed = { ...tab };
    for (const key of ["url", "pendingUrl"]) {
      if (typeof exposed[key] !== "string" || !hostPrefixes.some(prefix => exposed[key].startsWith(prefix)))
        delete exposed[key];
    }
    return exposed;
  }
  function navigate(id: number, url: string) {
    const tab = tabs.get(id);
    Object.assign(tab, { url, status: "complete" });
    delete tab.pendingUrl;
    const exposed = exposedTab(tab);
    updated(id, { status: "complete", ...(exposed.url ? { url: exposed.url } : {}) });
  }
  const chrome = {
    runtime: {
      id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (fn: typeof receive) => { receive = fn; } },
    },
    alarms: {
      create: vi.fn(async () => {}),
      onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } },
    },
    storage: { local: {
      setAccessLevel: vi.fn(async () => {}),
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])])),
      set: vi.fn(async (value: any) => { Object.assign(stored, structuredClone(value)); }),
      remove: async (key: string) => { delete stored[key]; },
    }, session: {
      setAccessLevel: vi.fn(async () => {}),
      get: async (_key: string) => ({ mailWork: structuredClone(stored.mailWork) }),
      set: vi.fn(async (value: any) => { Object.assign(stored, structuredClone(value)); }),
    } },
    tabs: {
      onActivated: { addListener: (fn: typeof activated) => { activated = fn; } },
      onRemoved: { addListener: (fn: typeof removed) => { removed = fn; } },
      onUpdated: { addListener: (fn: typeof updated) => { updated = fn; } },
      get: vi.fn(async (id: number) => {
        if (!tabs.has(id)) throw new Error("Tab closed");
        return exposedTab(tabs.get(id));
      }),
      query: vi.fn(async (query: any) => [...tabs.values()].filter(tab =>
        (!query.active || tab.active) && (!query.windowId || tab.windowId === query.windowId)).map(exposedTab)),
      create: vi.fn(async (value: any) => {
        const tab = { windowId: 5, status: "complete", ...value, id: nextTab++ };
        if (tab.active) for (const current of tabs.values()) current.active = false;
        tabs.set(tab.id, tab);
        if (tab.active) activated({ tabId: tab.id, windowId: tab.windowId });
        if (onCreate) await onCreate(tab);
        return exposedTab(tab);
      }),
      update: vi.fn(async (id: number, value: any) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab closed");
        Object.assign(tab, value);
        if (value.url) navigate(id, value.url);
        if (value.active) {
          for (const current of tabs.values()) if (current.id !== id) current.active = false;
          activated({ tabId: id, windowId: tab.windowId });
        }
        return exposedTab(tab);
      }),
      remove: vi.fn(async (id: number) => { tabs.delete(id); removed(id); }),
      sendMessage: vi.fn(async (id: number, message: any, options: any) => {
        if (!readyPages.has(id)) throw new Error("Page is asleep or its header is not ready");
        if (options?.documentId && options.documentId !== `document-${id}`) throw new Error("Document changed");
        const page = { ...registration, accountEmail: accounts.get(id) || input.accountEmail, pageUrl: tabs.get(id).url };
        if (message.action === "mail-read-status") return { ok: true, value: { dirty: dirty.has(id), registration: page } };
        if (message.action === "connect") {
          await discover(id);
          return { ok: true, value: {} };
        }
        if (message.action === "mail-read") {
          if (deferRead) return await new Promise<any>(() => {});
          await deliver({ type: "mail-row-proof", payload: { registration: page, requestId: message.job.requestId,
            lease: message.job.lease, rowProof: { threadId: message.job.input.threadId, inboxUrl: page.pageUrl } } }, id);
          tabs.get(id).url = page.pageUrl.replace("#inbox", "#inbox/FMnative");
          return { ok: true, value: { code: "complete", capture: { ...page, pageUrl: tabs.get(id).url,
            meetings: [], messages: [{ id: "18def", threadId: message.job.input.threadId, sender: "sender@example.org",
              recipients: [], subject: "Fixture", body: "Full body", html: "<p>Full body</p>", dateText: "",
              url: tabs.get(id).url, unread: false, completeness: "full", attachments: [] }] } } };
        }
        throw new Error("Unexpected page command");
      }),
    },
  };
  async function deliver(message: any, id?: number) {
    const sender = id === undefined ? { id: extensionId, url: chrome.runtime.getURL("popup.html") } :
      { id: extensionId, tab: { ...tabs.get(id) }, url: tabs.get(id).url, frameId: 0, documentId: `document-${id}` };
    return new Promise<any>((resolve, reject) => receive(message, sender, result =>
      result.ok ? resolve(result.value) : reject(new Error(result.error))));
  }
  async function discover(id: number, email = accounts.get(id) || input.accountEmail, kind = "mail") {
    const current = new URL(tabs.get(id).url);
    if (kind === "mail" && current.pathname === "/mail/" && current.searchParams.has("authuser")) {
      const slot = slots.get(current.searchParams.get("authuser")!) ?? 0;
      navigate(id, `https://mail.google.com/mail/u/${slot}/#inbox`);
    }
    readyPages.add(id); accounts.set(id, email);
    return await deliver({ type: "discover", payload: { ...registration, kind, accountEmail: email, pageUrl: tabs.get(id).url } }, id);
  }
  async function drain() {
    for (let stable = 0; stable < 3;) { await delay(); stable = inFlight ? 0 : stable + 1; }
  }
  function start() {
    for (const timer of timers) clearTimeout(timer);
    timers = new Set();
    const ownTimers = timers;
    const context = createContext({
      chrome, URL, TextEncoder, AbortController, console, Date,
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(() => { ownTimers.delete(timer); fn(); }, ms);
        ownTimers.add(timer); return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); ownTimers.delete(timer); },
      fetch: async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: JSON.parse(String(init.body)) });
        inFlight++;
        try {
          // Never contact the URL embedded in the production worker.
          return await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Origin: `chrome-extension://${extensionId}` } });
        } finally { inFlight--; }
      },
      importScripts: (...names: string[]) => {
        for (const name of names) runInContext(readFileSync(resolve(directory, name), "utf8"), context);
      },
    });
    runInContext(readFileSync(resolve(directory, "background.js"), "utf8"), context);
  }
  function queue(value = input, guard = () => {}) {
    const result = bridge.readMailThread(value, guard).catch(error => error);
    reads.push(result); return result;
  }
  async function tick() { alarm({ name: "relay-mail-dispatch" }); await drain(); }
  async function seed() { await discover(10); await drain(); }
  start(); await drain();
  cleanup.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    await bridge.stop(); await Promise.all(reads);
  });
  return { bridge, post, token, stored, tabs, chrome, calls, dirty, readyPages, accounts, slots, queue, discover, deliver, drain, tick, seed,
    loading: (id: number) => { tabs.get(id).status = "loading"; updated(id, { status: "loading" }); },
    restart: async () => { start(); await drain(); }, defer: () => { deferRead = true; },
    enableCapture: () => { captureEnabled = true; }, navigate,
    onCreate: (callback: (tab: any) => Promise<void>) => { onCreate = callback; } };
}

describe("independent MV3 full-email dispatch", () => {
  it.each([
    ["wake", "connection"], ["wake", "header"], ["wake", "timeout"],
    ["reader", "connection"], ["reader", "header"], ["reader", "timeout"]
  ])("retries transient %s %s readiness in the same tab without heartbeat or lease replay", async (stage, failure) => {
    const h = await fixture(); await h.seed();
    const send = h.chrome.tabs.sendMessage.getMockImplementation()!;
    const tabId = stage === "wake" ? 100 : 101;
    let failures = 0;
    h.chrome.tabs.sendMessage.mockImplementation(async (...args) => {
      if (args[0] === tabId && args[1].action === "mail-read-status" && failures++ === 0) {
        if (failure === "connection") throw new Error("Could not establish connection. Receiving end does not exist.");
        if (failure === "timeout") return await new Promise<any>(() => {});
        return { ok: true, value: { dirty: false } };
      }
      return await send(...args);
    });
    h.onCreate(async tab => { h.readyPages.add(tab.id); });
    const result = h.queue(); await h.tick();
    await vi.waitFor(() => expect(h.calls.some(call => call.path === "/mail/complete")).toBe(true), { timeout: 7000 });
    expect((await result).messages).toHaveLength(1);
    expect(failures).toBeGreaterThan(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId)).toHaveLength(1);
    expect(h.calls.filter(call => call.path === "/mail/dispatch" &&
      ["delivery-failed", "interrupted", "account-mismatch"].includes(call.body.code))).toHaveLength(0);
  }, 10000);
  it("cancels a running exact-document reader when its permission is revoked during readiness waits", async () => {
    const h = await fixture(); await h.seed();
    let allowed = true;
    h.defer();
    const result = h.queue(input, () => { if (!allowed) throw new Error("Revoked"); });
    await h.tick(); await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    const delivered = h.chrome.tabs.sendMessage.mock.calls.find(([, message]) => message.action === "mail-read")!;
    expect(delivered).toBeDefined();
    allowed = false;
    await h.tick();
    expect((await result).message).toContain("authorized");
    expect(h.chrome.tabs.sendMessage).toHaveBeenCalledWith(101, {
      type: "relay-tab", action: "mail-read-cancel", requestId: delivered[1].job.requestId, lease: delivered[1].job.lease
    }, { documentId: "document-101" });
    expect(h.calls.filter(call => call.path === "/mail/complete")).toHaveLength(0);
  });
  it("retries final owned-document inspection without rebinding or replaying the read", async () => {
    const h = await fixture(); await h.seed();
    const send = h.chrome.tabs.sendMessage.getMockImplementation()!;
    let inspected = 0;
    h.chrome.tabs.sendMessage.mockImplementation(async (...args) => {
      if (args[0] === 101 && args[1].action === "mail-read-status" && ++inspected === 2)
        throw new Error("Could not establish connection. Receiving end does not exist.");
      return await send(...args);
    });
    h.onCreate(async tab => { h.readyPages.add(tab.id); });
    const result = h.queue(); await h.tick();
    await vi.waitFor(() => expect(h.calls.some(call => call.path === "/mail/complete")).toBe(true), { timeout: 5000 });
    expect((await result).messages).toHaveLength(1);
    expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId)).toHaveLength(1);
    expect(h.chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === "mail-read")).toHaveLength(1);
  });
  it("retains a journaled bootstrap across a transient initial tabs.get failure instead of failing delivery", async () => {
    const h = await fixture(); await h.seed();
    const get = h.chrome.tabs.get.getMockImplementation()!;
    let attempts = 0;
    h.chrome.tabs.get.mockImplementation(async id => {
      if (id === 100 && attempts++ === 0) throw new Error("Tab initialization is pending");
      return await get(id);
    });
    h.onCreate(async tab => { h.readyPages.add(tab.id); });
    const result = h.queue(); await h.tick();
    await vi.waitFor(() => expect(h.calls.some(call => call.path === "/mail/complete")).toBe(true), { timeout: 5000 });
    expect((await result).messages).toHaveLength(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(h.calls.some(call => call.path === "/mail/dispatch" && call.body.code === "delivery-failed")).toBe(false);
  });
  it("creates Gmail directly with host-only permissions while unrelated about:blank URLs stay redacted", async () => {
    const h = await fixture(); await h.seed();
    expect(manifest.permissions).not.toContain("tabs");
    h.tabs.set(90, { id: 90, windowId: 5, url: "about:blank", pendingUrl: "about:blank", active: false });
    const blank = await h.chrome.tabs.get(90);
    expect(blank).not.toHaveProperty("url");
    expect(blank).not.toHaveProperty("pendingUrl");
    expect((await h.chrome.tabs.query({})).find(tab => tab.id === 90)).not.toHaveProperty("url");
    const result = h.queue(); await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: canonical, active: false, windowId: 5 });
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    expect(h.stored.mailWork.wakes[0]).toMatchObject({ tabId: 100, creating: false, targetUrl: canonical });
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
    expect(h.chrome.tabs.create.mock.calls.every(([value]) => value.url.startsWith("https://mail.google.com/"))).toBe(true);
    expect(h.chrome.tabs.update.mock.calls.every(([, value]) => !("url" in value))).toBe(true);
    expect(h.tabs.get(90).url).toBe("about:blank");
  });

  describe("bounded session-owned tab reuse", () => {
    async function completed() {
      const h = await fixture(); await h.seed();
      const result = h.queue(); await h.tick();
      await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
      expect((await result).messages).toHaveLength(1);
      return h;
    }

    it("reuses the same distinct bootstrap/reader for repeated reads, including after worker restart", async () => {
      const h = await completed();
      for (let i = 0; i < 8; i++) {
        if (i === 3) await h.restart();
        const result = h.queue({ ...input, threadId: `18abc${i}` }); await h.tick();
        expect((await result).messages[0].threadId).toBe(`18abc${i}`);
      }
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
      expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
      expect(h.tabs.get(10).active).toBe(true);
      const bindings = h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId);
      expect(bindings).toHaveLength(9);
      expect(bindings.every(call => call.body.sourceTabId === 100 && call.body.tabId === 101 &&
        call.body.sourceDocumentId === "document-100" && call.body.documentId === "document-101")).toBe(true);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 2, mailIdle: 2, viewOwned: 0, limit: 30 });
    });

    it.each(["activated", "dirty", "pinned", "navigated", "pending", "wrong-account", "unavailable"] as const)(
      "never reuses or closes a %s reader", async state => {
        const h = await completed();
        const oldUrl = h.tabs.get(101).url;
        if (state === "activated") {
          await h.chrome.tabs.update(101, { active: true });
          await h.chrome.tabs.update(10, { active: true });
        }
        if (state === "dirty") h.dirty.add(101);
        if (state === "pinned") h.tabs.get(101).pinned = true;
        if (state === "navigated") h.navigate(101, "https://mail.google.com/mail/u/2/#drafts");
        if (state === "pending") Object.assign(h.tabs.get(101), { pendingUrl: "https://mail.google.com/mail/u/3/#drafts", status: "loading" });
        if (state === "wrong-account") h.accounts.set(101, "other@example.org");
        if (state === "unavailable") h.readyPages.delete(101);
        const result = h.queue({ ...input, threadId: "18ddd" }); await h.tick();
        expect(h.chrome.tabs.create).toHaveBeenCalledTimes(3);
        await h.discover(102); await h.drain();
        expect((await result).messages).toHaveLength(1);
        await h.deliver({ type: "cleanup-agent-tabs" });
        expect(h.tabs.has(101)).toBe(true);
        expect(h.tabs.has(10)).toBe(true);
        expect(h.tabs.get(101).url).toBe(state === "navigated" ? "https://mail.google.com/mail/u/2/#drafts" : oldUrl);
        expect(h.chrome.tabs.update.mock.calls.some(([id, update]) => id === 101 && update.url)).toBe(false);
      });

    it("retains failed reads as owned, reusable tabs rather than treating an exception as interaction", async () => {
      const h = await completed();
      const send = h.chrome.tabs.sendMessage.getMockImplementation()!;
      h.chrome.tabs.sendMessage.mockImplementation(async (...args) => {
        if (args[1].action === "mail-read") throw new Error("Transient read failure");
        return await send(...args);
      });
      const failed = h.queue(); await h.tick();
      expect((await failed).message).toContain("interrupted");
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 2, mailIdle: 2 });
      h.chrome.tabs.sendMessage.mockImplementation(send);
      const result = h.queue(); await h.tick();
      expect((await result).messages).toHaveLength(1);
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    });

    it("waits for document completion before binding a header that arrives while the dedicated tab is loading", async () => {
      const h = await fixture(); await h.seed();
      h.onCreate(async tab => { if (tab.id === 101) tab.status = "loading"; });
      const result = h.queue(); await h.tick();
      await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
      expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId)).toHaveLength(0);
      expect(h.calls.filter(call => call.path === "/mail/complete")).toHaveLength(0);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({
        debug: { roles: { reader: 1, wake: 1, view: 0 }, busy: 2, loading: 1, bound: 2, protected: 0 }
      });
      h.navigate(101, inbox); await h.drain();
      expect((await result).messages).toHaveLength(1);
      expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId)).toHaveLength(1);
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    });

    it("does not label Chrome same-document loading notifications as user interaction", async () => {
      const h = await completed();
      const send = h.chrome.tabs.sendMessage.getMockImplementation()!;
      h.chrome.tabs.sendMessage.mockImplementation(async (...args) => {
        const value = await send(...args);
        if (args[1].action === "mail-read") {
          h.loading(args[0]);
          await delay();
          h.navigate(args[0], h.tabs.get(args[0]).url);
          await delay();
        }
        return value;
      });
      for (let i = 0; i < 3; i++) {
        const result = h.queue(); await h.tick();
        expect((await result).messages).toHaveLength(1);
      }
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({
        debug: { protected: 0, dirty: 0, bound: 2, sameUrl: 2, statusUnavailable: 0, identityMismatch: 0 }
      });
    });

    it("returns diagnostic counters only, including document-targeted status delivery failure", async () => {
      const h = await completed();
      h.readyPages.delete(101);
      const status = await h.deliver({ type: "tab-management" });
      expect(status.debug).toMatchObject({ roles: { reader: 1, wake: 1, view: 0 }, busy: 0, protected: 0, loading: 0,
        bound: 2, sameUrl: 2, statusUnavailable: 1, pending: 0, active: 0, pinned: 0, dirty: 0,
        identityMismatch: 0, unbound: 0, reservations: 0 });
      expect(JSON.stringify(status)).not.toContain("example.org");
      expect(JSON.stringify(status)).not.toContain("https:");
      expect(status.debug.lastReason).toBe("none");
      expect(Object.values(status.debug.reasons).every(value => value === 0)).toBe(true);
      const { lastReason, reasons, ...counts } = status.debug;
      expect(Object.values(counts).every(value => typeof value === "number" || value === status.debug.roles)).toBe(true);
    });

    it("bounds a never-settling inspector, retains its ownership and releases the cleanup queue", async () => {
      const h = await completed();
      const send = h.chrome.tabs.sendMessage.getMockImplementation()!;
      let late!: (value: any) => void;
      h.chrome.tabs.sendMessage.mockImplementation(async (...args) => {
        if (args[0] === 101 && args[1].action === "mail-read-status")
          return await new Promise(resolve => { late = resolve; });
        return await send(...args);
      });
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 1, retained: 1 });
      expect(h.tabs.has(101)).toBe(true);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({
        mailOwned: 1, mailIdle: 0, debug: { statusUnavailable: 1 }
      });
      late({ ok: true, value: { dirty: false, registration: { ...registration, pageUrl: h.tabs.get(101).url } } });
      await delay();
      expect(h.tabs.has(101)).toBe(true); // A late clean response cannot close it.
      h.chrome.tabs.sendMessage.mockImplementation(send);
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 1, retained: 0 });
    });

    it("expires popup work queued behind a stalled tab creation without executing cleanup later", async () => {
      const h = await completed();
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      h.onCreate(async () => { entered(); await wait; });
      const opening = h.deliver({ type: "open-whatsapp" });
      await reached;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const cleanup = h.deliver({ type: "cleanup-agent-tabs" }).catch(error => error);
        const status = h.deliver({ type: "tab-management" }).catch(error => error);
        await vi.advanceTimersByTimeAsync(10001);
        expect((await cleanup).message).toContain("timed out");
        expect((await status).message).toContain("timed out");
        release();
        await opening;
        await vi.advanceTimersByTimeAsync(1);
        expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
        expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 2, viewOwned: 1 });
      } finally {
        release();
        vi.useRealTimers();
      }
    });

    it("keeps source, dedicated document and fresh header identity separated across accounts", async () => {
      const h = await completed();
      const other = { accountId: "mail-other", accountEmail: "other@example.org", threadId: "18ccc" };
      h.tabs.set(20, { id: 20, url: "https://mail.google.com/mail/u/3/#inbox", windowId: 5, active: false });
      await h.discover(20, other.accountEmail); await h.drain();
      const result = h.queue(other); await h.tick();
      await h.discover(102, other.accountEmail); await h.drain();
      await h.discover(103, other.accountEmail); await h.drain();
      expect((await result).accountEmail).toBe(other.accountEmail);
      for (const account of [input, other, input, other]) {
        const next = h.queue(account); await h.tick();
        expect((await next).accountEmail).toBe(account.accountEmail);
      }
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(4);
      const bindings = h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId);
      for (const { body } of bindings) {
        const source = body.registration.accountEmail === input.accountEmail ? 100 : 102;
        expect(body).toMatchObject({ sourceTabId: source, tabId: source + 1,
          sourceDocumentId: `document-${source}`, documentId: `document-${source + 1}` });
      }
    });

    it("preserves a dedicated reader selected and deselected during creation without starting a read", async () => {
      const h = await fixture(); await h.seed();
      h.onCreate(async tab => {
        if (tab.id !== 101) return;
        await h.chrome.tabs.update(101, { active: true });
        await h.chrome.tabs.update(10, { active: true });
      });
      const result = h.queue(); await h.tick();
      await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
      expect((await result).message).toContain("interrupted");
      expect(h.chrome.tabs.sendMessage.mock.calls.some(([, message]) => message.action === "mail-read")).toBe(false);
      await h.deliver({ type: "cleanup-agent-tabs" });
      expect(h.tabs.has(101)).toBe(true);
    });

    it("counts unresponsive readers against the global bound across worker restart", async () => {
      const h = await completed();
      h.readyPages.delete(101);
      for (const id of [102, 103]) {
        const result = h.queue(); await h.tick(); await h.discover(id); await h.drain();
        expect((await result).messages).toHaveLength(1);
        h.readyPages.delete(id);
      }
      await h.restart();
      for (let i = 0; i < 3; i++) {
        const result = h.queue(); await h.tick();
        expect((await result).message).toContain("unavailable");
      }
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(4);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 4, mailIdle: 1,
        debug: { lastReason: "readerCapacity", reasons: { readerCapacity: 3 } } });
      await h.restart();
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({
        debug: { lastReason: "readerCapacity", reasons: { readerCapacity: 3 } }
      });
      for (const id of [101, 102, 103]) h.readyPages.add(id);
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 4, retained: 0 });
      expect([...h.tabs.keys()]).toEqual([10]);
    });

    it("counts unresponsive bootstraps and interrupted creation reservations, not just running jobs", async () => {
      const h = await fixture(); await h.seed();
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      for (let i = 0; i < 3; i++) {
        const result = h.queue(); await h.tick(); now += 46000; await h.tick();
        expect((await result).message).toContain("document-not-ready");
      }
      const result = h.queue(); await h.tick();
      expect((await result).message).toContain("delivery-failed");
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(3);
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({
        debug: { lastReason: "wakeCapacity", reasons: { wakeCapacity: 1 } }
      });
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 0, retained: 3 });
      // A crash during create before receiving the numeric ID cannot be safely
      // reconciled by matching URLs, and must continue to consume capacity.
      h.stored.mailWork.owned = h.stored.mailWork.owned.map((entry: any) =>
        ({ ...entry, tabId: undefined, creating: true }));
      await h.restart();
      const after = h.queue(); await h.tick();
      expect((await after).message).toContain("delivery-failed");
      expect(h.chrome.tabs.create).toHaveBeenCalledTimes(3);
    });

    it("expires only verified safe idle owned tabs and never restores IDs from a previous browser session", async () => {
      const h = await completed();
      delete h.stored.mailWork; // chrome.storage.session is cleared by browser restart.
      await h.restart();
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 0 });
      const result = h.queue(); await h.tick();
      await h.discover(102); await h.drain(); await h.discover(103); await h.drain();
      expect((await result).messages).toHaveLength(1);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60000);
      await h.tick();
      expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
      expect(h.chrome.tabs.remove.mock.calls.map(([id]) => id).sort()).toEqual([102, 103]);
    });

    it("recovers only legacy session-journaled tabs with original document bindings, not URL lookalikes", async () => {
      const h = await completed();
      h.tabs.set(80, { id: 80, url: h.tabs.get(101).url, active: false, windowId: 5 });
      h.readyPages.add(80);
      h.stored.mailWork = { jobs: [], wakes: [], cleanup: [
        { tabId: 100, targetUrl: inbox, accountEmail: input.accountEmail, requestId: "a".repeat(32),
          boundDocument: "document-100", interacted: false, creating: false },
        { tabId: 101, targetUrl: inbox, cleanupUrl: h.tabs.get(101).url,
          job: { input, requestId: "b".repeat(32) }, boundDocument: "document-101", interacted: false, creating: false,
          rowProof: { inboxUrl: inbox, threadId: input.threadId } }
      ] };
      await h.restart();
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 2, mailIdle: 2 });
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 2, retained: 0 });
      expect([...h.tabs.keys()]).toEqual([10, 80]);
    });

    it("retains legacy owned tabs without original document proof and never treats local-storage IDs as ownership", async () => {
      const h = await completed();
      const legacy = { tabId: 101, targetUrl: inbox, cleanupUrl: h.tabs.get(101).url,
        job: { input, requestId: "b".repeat(32) }, interacted: false, creating: false,
        rowProof: { inboxUrl: inbox, threadId: input.threadId } };
      h.stored.mailWork = { jobs: [], wakes: [], cleanup: [legacy] };
      await h.restart();
      expect(await h.deliver({ type: "tab-management" })).toMatchObject({ mailOwned: 1, mailIdle: 0 });
      await h.discover(101); await h.drain();
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 0, retained: 1 });
      h.stored.mailWork = { jobs: [], wakes: [], cleanup: [{ ...legacy, boundDocument: "document-101" }] };
      h.chrome.storage.session.get = async () => ({ mailWork: undefined });
      await h.restart();
      expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 0, retained: 0 });
      expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
    });

    it("restricts aggregate management and cleanup to the popup and retains in-use documents", async () => {
      const h = await fixture(); await h.seed();
      for (const type of ["tab-management", "cleanup-agent-tabs"])
        await expect(h.deliver({ type }, 10)).rejects.toThrow("restricted");
      h.queue(); await h.tick(); await h.discover(100); await h.drain();
      h.defer(); await h.discover(101); await h.drain();
      const result = await h.deliver({ type: "cleanup-agent-tabs" });
      expect(result.closed).toBe(1); // Idle bootstrap only; bound reader remains.
      expect(h.tabs.has(101)).toBe(true);
      expect(h.tabs.has(10)).toBe(true);
    });
  });

  it.each([true, false])("waits for direct Gmail creation to commit without blank inspection (pending URL visible: %s)", async pendingVisible => {
    const h = await fixture(); await h.seed();
    h.onCreate(async tab => {
      if (tab.id === 100) Object.assign(tab, { url: "about:blank",
        ...(pendingVisible ? { pendingUrl: canonical } : {}), status: pendingVisible ? "loading" : "complete" });
    });
    const result = h.queue(); await h.tick(); await h.tick();
    if (pendingVisible) expect(await h.chrome.tabs.get(100)).toMatchObject({ pendingUrl: canonical, status: "loading" });
    else expect(await h.chrome.tabs.get(100)).not.toHaveProperty("pendingUrl");
    expect(await h.chrome.tabs.get(100)).not.toHaveProperty("url");
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.stored.mailWork.wakes).toHaveLength(1);
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    h.navigate(100, inbox);
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
  });

  it("preserves a bootstrap activated and then deselected before tabs.create resolves", async () => {
    const h = await fixture(); await h.seed();
    h.onCreate(async tab => {
      await h.chrome.tabs.update(tab.id, { active: true });
      await h.chrome.tabs.update(10, { active: true });
    });
    const result = h.queue(); await h.tick();
    expect((await result).message).toContain("interrupted");
    expect(h.tabs.get(100)).toMatchObject({ url: canonical, active: false });
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(h.calls.filter(call => call.path === "/mail/poll")).toHaveLength(1);
    expect(h.stored.mailWork.wakes).toEqual([]);
    expect(h.stored.mailWork.cleanup).toEqual([]);
  });

  it.each(["about:blank", "https://example.org/unsaved", "https://mail.google.com/mail/u/2/#drafts"])
  ("never overwrites or closes a bootstrap navigated during creation to %s", async url => {
    const h = await fixture(); await h.seed();
    h.onCreate(async tab => {
      await h.chrome.tabs.update(tab.id, { active: true });
      h.navigate(tab.id, url);
      await h.chrome.tabs.update(10, { active: true });
    });
    const result = h.queue(); await h.tick();
    expect((await result).message).toContain("interrupted");
    expect(h.tabs.get(100).url).toBe(url);
    expect(h.chrome.tabs.update.mock.calls.every(([, value]) => !("url" in value))).toBe(true);
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(h.calls.filter(call => call.path === "/mail/poll")).toHaveLength(1);
  });

  it("journals the new tab before a header arriving during tabs.create can discover or lease", async () => {
    const h = await fixture(); await h.seed();
    let header!: Promise<any>;
    h.onCreate(async tab => {
      if (tab.id !== 100) return;
      header = h.discover(tab.id);
      await delay();
      expect(h.calls.filter(call => call.path === "/discover")).toHaveLength(1);
      expect(h.calls.filter(call => call.path === "/mail/poll")).toHaveLength(1);
    });
    const result = h.queue(); await h.tick();
    expect(await header).toMatchObject({ enabled: false, mailReadTab: true });
    expect(h.stored.mailWork.wakes[0]).toMatchObject({ tabId: 100, creating: false });
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
    expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
  });

  it("wakes a real pending queue from an alarm without Gmail heartbeats, preserving native row proof and focus", async () => {
    const h = await fixture(); await h.seed();
    h.enableCapture();
    expect(h.chrome.alarms.create).toHaveBeenCalledWith("relay-mail-dispatch", { periodInMinutes: 0.5 });
    expect(h.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    const result = h.queue();
    await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.tabs.get(100).url).toBe(canonical);
    expect(h.tabs.get(10)).toMatchObject({ url: inbox, discarded: true });
    expect(h.calls.filter(call => call.path === "/mail/poll")).toHaveLength(1); // Only the earlier seed.
    await h.tick(); await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(await h.discover(100)).toMatchObject({ enabled: false, mailReadTab: true });
    await h.drain();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    await h.discover(101); await h.drain();
    expect((await result).messages[0]).toMatchObject({ html: "<p>Full body</p>", completeness: "full" });
    expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
    expect(h.tabs.get(10).active).toBe(true);
    expect(h.calls.some(call => call.path === "/capture" || call.path.startsWith("/calendar/"))).toBe(false);
    expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.rowProof)).toHaveLength(1);
  });

  it("survives worker suspension before the queue, with no open Gmail tab", async () => {
    const h = await fixture(); await h.seed(); h.tabs.delete(10);
    const result = h.queue();
    await h.restart();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
    expect(h.tabs.size).toBe(2);
  });

  it("recovers the same deferred bootstrap after worker restart, never creating a second wake", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick();
    await h.restart(); await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
  });

  it("reports a leased worker interruption immediately rather than replaying a read after restart", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick(); await h.discover(100); await h.drain();
    h.defer(); await h.discover(101); await h.drain();
    expect(h.calls.filter(call => call.path === "/mail/poll" && call.body.sourceTabId)).toHaveLength(1);
    await h.restart();
    expect((await result).message).toContain("interrupted");
    expect(h.calls.some(call => call.path === "/mail/complete")).toBe(false);
    expect(h.chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === "mail-read")).toHaveLength(1);
    expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
  });

  it("resumes an unbound lease in its already-owned dedicated tab after worker restart", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick(); await h.discover(100); await h.drain();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    await h.restart(); await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(h.chrome.storage.session.set).toHaveBeenCalled();
    expect(h.chrome.storage.local.set.mock.calls.every(([value]) => !("mailWork" in value))).toBe(true);
  });

  it("never leases or registers an account-slot redirect and discards the stale route", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick();
    await expect(h.discover(100, "other@example.org")).rejects.toThrow("bootstrap account");
    expect((await result).message).toContain("account-mismatch");
    expect(h.calls.filter(call => call.path === "/discover")).toHaveLength(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.stored.mailRoutes).toEqual([]);
  });

  it("does not close user-interacted or navigated bootstrap tabs", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick(); h.dirty.add(100);
    await expect(h.discover(100)).rejects.toThrow("left untouched");
    expect((await result).message).toContain("interrupted");
    expect(h.tabs.has(100)).toBe(true);
    const next = h.queue(); await h.tick();
    await h.chrome.tabs.update(101, { url: "https://example.org/unsaved" });
    await h.tick();
    expect((await next).message).toContain("interrupted");
    expect(h.tabs.get(101).url).toBe("https://example.org/unsaved");
  });

  it("honors source revocation before wake and before a deferred page can lease", async () => {
    const h = await fixture(); await h.seed();
    let allowed = true;
    const guard = () => { if (!allowed) throw new Error("Excluded"); };
    const first = h.queue(input, guard); allowed = false; await h.tick();
    expect((await first).message).toContain("authorized");
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
    allowed = true;
    const second = h.queue(input, guard); await h.tick(); allowed = false;
    await expect(h.discover(100)).rejects.toThrow("no longer pending");
    expect((await second).message).toContain("authorized");
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("does not query unpaired profiles, but wakes a known bridge account on first update without a seeded route or open Google tab", async () => {
    const h = await fixture();
    delete h.stored.token;
    const before = h.calls.length; await h.tick();
    expect(h.calls).toHaveLength(before);
    h.stored.token = h.token;
    await h.post("/discover", registration, h.token); // Bridge knows account, this worker has never verified its route.
    h.tabs.clear();
    expect(h.stored.mailRoutes).toEqual([]);
    const result = h.queue(); await h.tick();
    expect(h.tabs.get(100).url).toBe(canonical);
    expect(h.calls.some(call => call.path === "/mail/poll")).toBe(false);
    expect(await h.deliver({ type: "discover", payload: { ...registration, pageUrl: canonical } }, 100))
      .toMatchObject({ enabled: false, mailReadTab: true });
    expect(h.calls.some(call => call.path === "/mail/poll")).toBe(false);
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
    expect(h.tabs.size).toBe(2);
  });

  it("routes by the known account email, not a stale numeric slot, and verifies the new numeric inbox before leasing", async () => {
    const h = await fixture(); await h.seed();
    expect(h.stored.mailRoutes[0].url).toBe(inbox);
    h.slots.set(input.accountEmail, 7);
    const result = h.queue(); await h.tick();
    expect(h.tabs.get(100).url).toBe(canonical);
    await h.discover(100); await h.drain();
    expect(h.tabs.get(101).url).toBe("https://mail.google.com/mail/u/7/#inbox");
    expect(h.stored.mailRoutes[0].url).toBe("https://mail.google.com/mail/u/7/#inbox");
    await h.discover(101); await h.drain();
    expect((await result).accountEmail).toBe(input.accountEmail);
    expect(h.tabs.get(10).url).toBe(inbox);
  });

  it("limits concurrent jobs for an account to one owned flow and handles independent accounts", async () => {
    const h = await fixture(); await h.seed();
    h.tabs.set(20, { id: 20, windowId: 5, url: "https://mail.google.com/mail/u/3/#inbox", active: false });
    await h.discover(20, "other@example.org"); await h.drain();
    h.queue(); h.queue({ ...input, threadId: "18def" });
    h.queue({ accountId: "mail-other", accountEmail: "other@example.org", threadId: "18aaa" });
    await h.tick(); await h.tick();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(h.stored.mailWork.wakes.map((wake: any) => wake.accountId).sort()).toEqual(["mail-other", "mail-owner"]);
  });

  it("dispatches the next same-account queued read on completion without waiting for any page heartbeat", async () => {
    const h = await fixture(); await h.seed();
    const first = h.queue(), second = h.queue({ ...input, threadId: "18def" });
    await h.tick(); await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await first).messages).toHaveLength(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(2);
    await h.drain();
    expect((await second).messages[0].threadId).toBe("18def");
    expect([...h.tabs.keys()]).toEqual([10, 100, 101]);
    expect(h.chrome.tabs.update).toHaveBeenCalledWith(101, { url: inbox });
    expect(h.chrome.tabs.update.mock.calls.every(([, value]) => !value.active)).toBe(true);
  });

  it("coalesces popup/provider checks, ignores arbitrary popup wake commands and wakes without Gmail discovery", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    const queries = h.calls.filter(call => call.path === "/mail/pending").length;
    await Promise.all(Array.from({ length: 10 }, () => h.deliver({ type: "state" })));
    await h.drain();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.calls.filter(call => call.path === "/mail/pending")).toHaveLength(queries + 1);
    await expect(h.deliver({ type: "mail-wake", url: "https://example.org/" })).rejects.toThrow("Unknown");
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
  });

  it("keeps unresponsive ownership across restart and cleans only after a fresh document registration", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick();
    await h.bridge.revoke(); await h.tick();
    expect((await result).message).toContain("revoked");
    expect(h.stored.mailWork.cleanup).toHaveLength(1);
    expect(h.tabs.has(100)).toBe(true);
    await h.restart();
    h.readyPages.add(100); await h.tick();
    expect(h.tabs.has(100)).toBe(true);
    await h.discover(100); await h.drain();
    expect(h.stored.mailWork.cleanup).toHaveLength(0);
    expect(await h.deliver({ type: "cleanup-agent-tabs" })).toMatchObject({ closed: 1, retained: 0 });
    expect(h.tabs.has(100)).toBe(false);
  });

  it("reports document-not-ready on the alarm for an unresponsive bootstrap instead of silently waiting 90 seconds", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 46000);
    await h.tick();
    expect((await result).message).toContain("document-not-ready");
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.stored.mailWork.cleanup).toHaveLength(1);
    h.readyPages.add(100); await h.tick();
    expect(h.tabs.has(100)).toBe(true);
    await h.discover(100); await h.drain();
    await h.deliver({ type: "cleanup-agent-tabs" });
    expect(h.tabs.has(100)).toBe(false);
  });

  it("cannot resume expired requests or emit uploads after a late header and worker restart", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue(); await h.tick();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91000);
    await h.restart();
    expect((await result).message).toContain("expired");
    expect(await h.discover(100)).toMatchObject({ enabled: false, mailReadTab: true });
    await h.drain();
    await h.deliver({ type: "cleanup-agent-tabs" });
    expect(h.tabs.has(100)).toBe(false);
    expect(h.calls.filter(call => call.path === "/discover")).toHaveLength(1);
    expect(h.calls.filter(call => call.path === "/mail/poll")).toHaveLength(1);
    expect(h.calls.some(call => call.path === "/mail/complete")).toBe(false);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("reports tab delivery errors immediately and does not keep creating tabs on subsequent alarms", async () => {
    const h = await fixture(); await h.seed();
    h.chrome.tabs.create.mockRejectedValueOnce(new Error("Browser cannot create a tab"));
    const result = h.queue(); await h.tick(); await h.tick();
    expect((await result).message).toContain("delivery-failed");
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.stored.mailWork.wakes).toEqual([]);
  });

  it("accelerates wake from a valid Calendar discover with no Gmail heartbeat", async () => {
    const h = await fixture(); await h.seed();
    const result = h.queue();
    h.tabs.set(20, { id: 20, windowId: 5, url: "https://calendar.google.com/calendar/u/2/#agenda", active: false });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    await h.discover(20, input.accountEmail, "calendar"); await h.drain();
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    await h.discover(100); await h.drain(); await h.discover(101); await h.drain();
    expect((await result).messages).toHaveLength(1);
  });
});
