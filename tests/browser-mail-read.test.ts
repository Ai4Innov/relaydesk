import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserBridge } from "../src/main/browser/bridge";
import type { BrowserCapture } from "../src/shared/browser";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const request = { accountId: "account-1", accountEmail: "owner@example.org", threadId: "18abc" };
const registration = { accountEmail: request.accountEmail, accountName: "Owner", kind: "mail" as const,
  pageUrl: "https://mail.google.com/mail/u/2/#inbox" };
const threadRegistration = { ...registration, pageUrl: "https://mail.google.com/mail/u/2/#all/18abc" };
const nativeRegistration = { ...registration, pageUrl: "https://mail.google.com/mail/u/2/#inbox/FMopaqueProviderRoute" };
const source = { protocol: 1, registration, tabId: 10, documentId: "original-document" };
const target = { protocol: 1, registration: threadRegistration, tabId: 11, documentId: "dedicated-document" };
const full = (): BrowserCapture => ({ ...threadRegistration, meetings: [], messages: [{
  id: "18def", threadId: request.threadId, sender: "sender@example.org", recipients: [], subject: "Fixture",
  body: "Complete fixture", html: "<p>Complete <b>fixture</b></p>", dateText: "", url: threadRegistration.pageUrl,
  unread: false, completeness: "full", attachments: [{ id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream" }],
}] });
const nativeFull = (): BrowserCapture => ({ ...full(), ...nativeRegistration,
  messages: full().messages.map(message => ({ ...message, url: nativeRegistration.pageUrl })) });
const bridges: BrowserBridge[] = [];
async function setup(onDiscover = async () => ({ accountId: request.accountId, enabled: false })) {
  const vault = new Map<string, unknown>();
  const bridge = new BrowserBridge({
    get: <T>(_collection: "secrets", id: string) => vault.get(id) as T | undefined,
    put: (_collection, id, value) => { vault.set(id, value); },
    delete: (_collection, id) => { vault.delete(id); },
  }, { extensionId, onDiscover, onCapture: async () => { throw new Error("On-demand reads must return to their caller."); },
    changed: () => {}, port: 0, refreshSettings: () => ({ paused: true, intervalSeconds: 0 }) });
  bridges.push(bridge);
  const send = (path: string, body: unknown, token?: string) => fetch(`http://127.0.0.1:${bridge.status().port}${path}`, {
    method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const pair = async () => {
    const code = await bridge.pair();
    return (await (await send("/pair", { code: code.code })).json()).token as string;
  };
  const token = await pair();
  const lease = async () => {
    const response = await send("/mail/poll", source, token);
    expect(response.status).toBe(200);
    const { job } = await response.json();
    return { requestId: job.requestId as string, lease: job.lease as string };
  };
  const bind = async (job: { requestId: string; lease: string }) => {
    const response = await send("/mail/poll", { ...target, ...job, sourceTabId: source.tabId, sourceDocumentId: source.documentId }, token);
    expect(response.status).toBe(200);
  };
  return { bridge, send, pair, token, lease, bind };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
  vi.restoreAllMocks();
});

describe("one-shot full email bridge", () => {
  it("accepts inbox freshness only on the exact leased owned inbox, not from an arbitrary full message", async () => {
    const h = await setup();
    const read = h.bridge.readMailThread({ ...request, threadId: "__relay_inbox__", inboxRefresh: true }, () => {});
    const job = await h.lease(), inbox = { ...target, registration };
    expect((await h.send("/mail/poll", { ...inbox, ...job, sourceTabId: source.tabId,
      sourceDocumentId: source.documentId }, h.token)).status).toBe(200);
    expect((await h.send("/mail/complete", { ...inbox, ...job, code: "complete", capture: full() }, h.token)).status).toBe(400);
    const capture = { ...registration, meetings: [], messages: [] };
    expect((await h.send("/mail/complete", { ...inbox, ...job, documentId: "different", code: "complete", capture }, h.token)).status).toBe(403);
    expect((await h.send("/mail/complete", { ...inbox, ...job, code: "complete", capture }, h.token)).status).toBe(200);
    expect(await read).toEqual(capture);
  });
  it("cancels an inbox lease immediately and refuses late completion", async () => {
    const h = await setup(), controller = new AbortController();
    const read = h.bridge.readMailThread({ ...request, threadId: "__relay_inbox__", inboxRefresh: true },
      () => {}, controller.signal).catch(error => error);
    const job = await h.lease(); controller.abort();
    expect((await read).message).toContain("cancelled");
    expect((await h.send("/mail/complete", { ...target, ...job, code: "unavailable" }, h.token)).status).toBe(409);
  });
  const downloadRequest = { ...request, messageProviderId: "18def", attachment: {
    metadataId: "report.pdf", name: "report.pdf", maxBytes: 25 * 1048576,
    relativePath: "RelayDesk/12345678-1234-1234-1234-123456789abc/report.pdf",
  } };
  async function attachmentLease(h: Awaited<ReturnType<typeof setup>>) {
    const job = await h.lease(), inbox = { ...target, registration };
    expect((await h.send("/mail/poll", { ...inbox, ...job, sourceTabId: source.tabId, sourceDocumentId: source.documentId }, h.token)).status).toBe(200);
    expect((await h.send("/mail/poll", { ...inbox, ...job, rowProof: {
      threadId: request.threadId, inboxUrl: registration.pageUrl, targetUrl: nativeRegistration.pageUrl
    } }, h.token)).status).toBe(200);
    return { ...target, registration: nativeRegistration, ...job };
  }
  function downloadedCapture() {
    const { metadataId, name, relativePath } = downloadRequest.attachment;
    return { ...nativeFull(), attachmentDownload: { metadataId, name, relativePath, bytes: 123, downloadId: 7 } };
  }
  it("accepts exactly one freshly authorized native attachment download, never ordinary capture paths", async () => {
    const h = await setup(), read = h.bridge.readMailThread(downloadRequest, () => {});
    const bound = await attachmentLease(h);
    const result = downloadedCapture();
    const download = result.attachmentDownload;
    expect((await h.send("/capture", result, h.token)).status).toBe(400);
    expect((await h.send("/mail/complete", { ...bound, code: "complete", capture: result }, h.token)).status).toBe(400);
    expect((await h.send("/mail/attachment/status", bound, h.token)).status).toBe(403);
    expect((await h.send("/mail/attachment/authorize", { ...bound, documentId: "other" }, h.token)).status).toBe(403);
    expect((await h.send("/mail/attachment/authorize", bound, h.token)).status).toBe(200);
    expect((await h.send("/mail/attachment/status", bound, h.token)).status).toBe(200);
    expect((await h.send("/mail/attachment/status", { ...bound, documentId: "reloaded" }, h.token)).status).toBe(403);
    expect((await h.send("/mail/attachment/status", bound, h.token)).status).toBe(200);
    expect((await h.send("/mail/attachment/authorize", bound, h.token)).status).toBe(403);
    for (const patch of [
      { relativePath: "../outside.pdf" }, { name: "different.pdf" }, { metadataId: "other-file" }, { bytes: 26 * 1048576 },
      { downloadId: -1 }, { downloadId: 1.5 }
    ]) expect((await h.send("/mail/complete", { ...bound, code: "complete",
      capture: { ...result, attachmentDownload: { ...download, ...patch } } }, h.token)).status).toBe(400);
    const otherMessage = { ...result, messages: result.messages.map(message => ({ ...message, attachments: [] })) };
    expect((await h.send("/mail/complete", { ...bound, code: "complete", capture: otherMessage }, h.token)).status).toBe(400);
    expect((await h.send("/mail/complete", { ...bound, code: "complete", capture: result }, h.token)).status).toBe(200);
    expect(await read).toEqual(result);
    expect((await h.send("/mail/complete", { ...bound, code: "complete", capture: result }, h.token)).status).toBe(409);
    expect((await h.send("/mail/attachment/status", bound, h.token)).status).toBe(409);
  });
  it.each(["authorize", "status", "complete"])("rechecks revoked attachment permission at %s", async boundary => {
    const h = await setup();
    let allowed = true;
    const read = h.bridge.readMailThread(downloadRequest, () => { if (!allowed) throw new Error("Revoked"); }).catch(error => error);
    const bound = await attachmentLease(h);
    if (boundary !== "authorize") expect((await h.send("/mail/attachment/authorize", bound, h.token)).status).toBe(200);
    allowed = false;
    const download = downloadedCapture().attachmentDownload;
    const body = boundary !== "complete" ? bound : { ...bound, code: "complete", capture: { ...nativeFull(), attachmentDownload: download } };
    expect((await h.send(boundary !== "complete" ? `/mail/attachment/${boundary}` : "/mail/complete", body, h.token)).status).toBe(403);
    expect((await read).message).toContain("authorized");
  });
  it("bounds only attachment reads to five minutes without coalescing different file jobs", async () => {
    const h = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const read = h.bridge.readMailThread(downloadRequest, () => {}).catch(error => error);
    await expect(h.bridge.readMailThread(request, () => {})).rejects.toThrow("different browser read");
    const response = await h.send("/mail/poll", source, h.token);
    const { job } = await response.json();
    expect(job.expiresAt - Date.now()).toBe(300_000);
    await vi.advanceTimersByTimeAsync(300_001);
    expect((await read).message).toContain("timed out");
  });
  it.each(["attachment-unavailable", "attachment-size-limit", "attachment-dangerous", "attachment-interrupted",
    "attachment-path-mismatch", "attachment-authorization-denied"])("accepts the bounded companion failure code %s without capture", async code => {
    const h = await setup(), read = h.bridge.readMailThread(downloadRequest, () => {}).catch(error => error);
    const bound = await attachmentLease(h);
    expect((await h.send("/mail/complete", { ...bound, code, capture: downloadedCapture() }, h.token)).status).toBe(400);
    expect((await h.send("/mail/complete", { ...bound, code }, h.token)).status).toBe(200);
    expect((await read).message).toContain(code);
  });
  it("never accepts the unknown-size capability without explicit desktop approval", async () => {
    const h = await setup();
    await expect(h.bridge.readMailThread({ ...downloadRequest, attachment: {
      ...downloadRequest.attachment, approved: false, allowUnknownSize: true
    } }, () => {})).rejects.toThrow("explicit approval");
  });
  it("exposes only guarded metadata to previously discovered clients and reserves a wake without accepting URLs", async () => {
    const h = await setup(), other = await h.pair();
    let allowed = true;
    const pending = h.bridge.readMailThread(request, () => { if (!allowed) throw new Error("Excluded"); }).catch(error => error);
    expect((await h.send("/mail/pending", { protocol: 1 })).status).toBe(401);
    expect(await (await h.send("/mail/pending", { protocol: 1 }, h.token)).json()).toEqual({ pending: [] });
    await h.send("/discover", registration, h.token);
    const { pending: hints } = await (await h.send("/mail/pending", { protocol: 1 }, h.token)).json();
    expect(hints).toHaveLength(1);
    expect(Object.keys(hints[0]).sort()).toEqual(["accountEmail", "accountId", "expiresAt", "requestId", "state"]);
    expect(hints[0]).toMatchObject({ accountId: request.accountId, accountEmail: request.accountEmail, state: "pending" });
    expect(await (await h.send("/mail/pending", { protocol: 1 }, other)).json()).toEqual({ pending: [] });
    const wake = { protocol: 1, requestId: hints[0].requestId, code: "wake" };
    expect((await h.send("/mail/dispatch", wake, other)).status).toBe(403);
    expect((await h.send("/mail/pending", { protocol: 1, accountEmail: "arbitrary@example.org" }, h.token)).status).toBe(400);
    expect((await h.send("/mail/dispatch", { ...wake, url: "https://example.org" }, h.token)).status).toBe(400);
    expect((await h.send("/mail/dispatch", wake, h.token)).status).toBe(200);
    await h.send("/discover", registration, other);
    expect(await (await h.send("/mail/pending", { protocol: 1 }, other)).json()).toEqual({ pending: [] });
    expect(await (await h.send("/mail/poll", source, other)).json()).toEqual({ job: null });
    expect((await h.send("/mail/dispatch", { ...wake, code: "interrupted" }, other)).status).toBe(403);
    allowed = false;
    expect(await (await h.send("/mail/pending", { protocol: 1 }, h.token)).json()).toEqual({ pending: [] });
    expect((await pending).message).toContain("authorized");
    expect((await h.send("/mail/dispatch", wake, h.token)).status).toBe(409);
  });
  it("rechecks every original permission callback before returning pending wake hints", async () => {
    const h = await setup(); await h.send("/discover", registration, h.token);
    const first = vi.fn(), second = vi.fn();
    const read = h.bridge.readMailThread(request, first);
    expect(h.bridge.readMailThread(request, second)).toBe(read);
    const result = read.catch(error => error);
    second.mockImplementation(() => { throw new Error("Source removed"); });
    expect(await (await h.send("/mail/pending", { protocol: 1 }, h.token)).json()).toEqual({ pending: [] });
    expect(first).toHaveBeenCalledTimes(2);
    expect((await result).message).toContain("authorized");
  });
  it("rejects expired or unrelated bootstrap request IDs without leasing a different queued thread", async () => {
    const h = await setup(); await h.send("/discover", registration, h.token);
    const result = h.bridge.readMailThread(request, () => {}).catch(error => error);
    const { pending: hints } = await (await h.send("/mail/pending", { protocol: 1 }, h.token)).json();
    expect((await h.send("/mail/poll", { ...source, wakeRequestId: hints[0].requestId }, h.token)).status).toBe(403);
    await h.send("/mail/dispatch", { protocol: 1, requestId: hints[0].requestId, code: "wake" }, h.token);
    expect(await (await h.send("/mail/poll", { ...source, wakeRequestId: "0".repeat(32) }, h.token)).json()).toEqual({ job: null });
    await h.send("/mail/dispatch", { protocol: 1, requestId: hints[0].requestId, code: "interrupted" }, h.token);
    expect((await result).message).toContain("interrupted");
  });
  it.each(["unclaimed", "document-not-ready", "read-in-progress"] as const)("reports the %s timeout stage without extending the deadline", async stage => {
    const h = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const result = h.bridge.readMailThread(request, () => {}).catch(error => error);
    if (stage !== "unclaimed") {
      const job = await h.lease();
      if (stage === "read-in-progress") await h.bind(job);
    }
    await vi.advanceTimersByTimeAsync(90001);
    expect((await result).message).toContain(`timed out (${stage})`);
  });
  it("binds an exact inbox row proof before accepting its canonical provider route in the same dedicated document", async () => {
    const h = await setup(), pending = h.bridge.readMailThread(request, () => {});
    const job = await h.lease(), inbox = { ...target, registration };
    expect((await h.send("/mail/poll", { ...inbox, ...job, sourceTabId: source.tabId, sourceDocumentId: source.documentId }, h.token)).status).toBe(200);
    const completed = { ...target, registration: nativeRegistration, ...job, code: "complete", capture: nativeFull() };
    expect((await h.send("/mail/complete", completed, h.token)).status).toBe(400);
    const rowProof = { threadId: request.threadId, inboxUrl: registration.pageUrl, providerThreadId: "thread-f:native",
      targetUrl: nativeRegistration.pageUrl };
    for (const bad of [
      { ...inbox, documentId: "other" }, { ...inbox, tabId: source.tabId },
      { ...inbox, rowProof: { ...rowProof, threadId: "wrong" } },
      { ...inbox, rowProof: { ...rowProof, targetUrl: "https://mail.google.com/mail/u/3/#inbox/other" } },
      { ...inbox, rowProof: { ...rowProof, targetUrl: "https://mail.google.com/mail/u/2/#settings/general" } },
    ]) expect((await h.send("/mail/poll", { ...inbox, ...job, rowProof, ...bad }, h.token)).status).toBe(403);
    expect((await h.send("/mail/poll", { ...inbox, ...job, rowProof }, h.token)).status).toBe(200);
    expect((await h.send("/mail/poll", { ...inbox, ...job, rowProof }, h.token)).status).toBe(403);
    expect((await h.send("/mail/complete", { ...completed, documentId: "reloaded-document" }, h.token)).status).toBe(403);
    const changed = { ...nativeFull(), pageUrl: "https://mail.google.com/mail/u/2/#inbox/AnotherOpaqueRoute",
      messages: nativeFull().messages.map(message => ({ ...message, url: "https://mail.google.com/mail/u/2/#inbox/AnotherOpaqueRoute" })) };
    expect((await h.send("/mail/complete", { ...completed, registration: { ...registration, pageUrl: changed.pageUrl }, capture: changed }, h.token)).status).toBe(400);
    expect((await h.send("/mail/complete", completed, h.token)).status).toBe(200);
    expect(await pending).toEqual(nativeFull());
  });
  it("deduplicates, binds a dedicated document, returns HTML and attachments without requiring AI or automatic capture", async () => {
    const h = await setup(), guard = vi.fn();
    const pending = h.bridge.readMailThread(request, guard);
    expect(h.bridge.readMailThread(request, guard)).toBe(pending);
    const job = await h.lease();
    await h.bind(job);
    expect((await h.send("/mail/complete", { ...target, ...job, code: "complete", capture: full() }, h.token)).status).toBe(200);
    expect(await pending).toEqual(full());
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect((await h.send("/mail/complete", { ...target, ...job, code: "complete", capture: full() }, h.token)).status).toBe(409);
  });
  it("rejects unauthenticated requests and wrong client, source tab, document and lease bindings", async () => {
    const h = await setup(), other = await h.pair();
    const pending = h.bridge.readMailThread(request, () => {}).catch(error => error);
    expect((await h.send("/mail/poll", source)).status).toBe(401);
    const job = await h.lease();
    const binding = { ...target, ...job, sourceTabId: source.tabId, sourceDocumentId: source.documentId };
    for (const [payload, token] of [
      [binding, other], [{ ...binding, sourceTabId: 99 }, h.token],
      [{ ...binding, sourceDocumentId: "other" }, h.token], [{ ...binding, lease: "0".repeat(64) }, h.token],
      [{ ...binding, tabId: source.tabId }, h.token],
      [{ ...binding, registration: { ...threadRegistration, pageUrl: "https://mail.google.com/mail/u/3/#all/18abc" } }, h.token],
    ] as const) expect((await h.send("/mail/poll", payload, token)).status).toBe(403);
    await h.bind(job);
    for (const payload of [{ ...target, tabId: 99 }, { ...target, documentId: "other" }, source]) {
      expect((await h.send("/mail/complete", { ...payload, ...job, code: "complete", capture: full() }, h.token)).status).toBe(403);
    }
    await h.bridge.stop();
    expect((await pending).message).toContain("stopped");
  });
  it("rejects preview, wrong account/thread/route, duplicate IDs, blank and oversized HTML results", async () => {
    const h = await setup(), pending = h.bridge.readMailThread(request, () => {}).catch(error => error);
    const job = await h.lease();
    await h.bind(job);
    const base = full();
    const variants = [
      { ...base, accountEmail: "other@example.org" },
      { ...base, messages: [{ ...base.messages[0], threadId: "other" }] },
      { ...base, messages: [{ ...base.messages[0], url: "https://mail.google.com/mail/u/3/#all/18abc" }] },
      { ...base, messages: [{ ...base.messages[0], completeness: "preview", html: undefined, attachments: undefined }] },
      { ...base, messages: [{ ...base.messages[0], html: "" }] },
      { ...base, messages: [{ ...base.messages[0], html: "a".repeat(1_000_001) }] },
      { ...base, messages: [base.messages[0], base.messages[0]] },
    ];
    for (const capture of variants) expect((await h.send("/mail/complete", { ...target, ...job, code: "complete", capture }, h.token)).status).toBe(400);
    await h.bridge.stop();
    await pending;
  });
  it("checks source permission before queueing, leasing and completion, cancelling denied reads", async () => {
    const h = await setup();
    await expect(h.bridge.readMailThread(request, () => { throw new Error("Excluded."); })).rejects.toThrow("Excluded");
    let allowed = true;
    const guard = () => { if (!allowed) throw new Error("Excluded."); };
    let pending = h.bridge.readMailThread(request, guard).catch(error => error);
    allowed = false;
    expect((await h.send("/mail/poll", source, h.token)).status).toBe(403);
    expect((await pending).message).toContain("authorized");
    allowed = true;
    pending = h.bridge.readMailThread(request, guard).catch(error => error);
    const job = await h.lease();
    await h.bind(job);
    allowed = false;
    expect((await h.send("/mail/complete", { ...target, ...job, code: "complete", capture: full() }, h.token)).status).toBe(403);
    expect((await pending).message).toContain("authorized");
  });
  it("revokes outstanding leases and fails only with bounded aggregate diagnostics", async () => {
    const h = await setup();
    let pending = h.bridge.readMailThread(request, () => {}).catch(error => error);
    const job = await h.lease();
    expect((await h.send("/mail/complete", { ...source, ...job, code: "partial",
      diagnostics: { containers: 2, bodies: 1, senders: 2, threadMarkers: 0 } }, h.token)).status).toBe(200);
    expect((await pending).message).toContain("containers=2, bodies=1, senders=2, threadMarkers=0");
    pending = h.bridge.readMailThread(request, () => {}).catch(error => error);
    await h.bridge.revoke();
    expect((await pending).message).toContain("revoked");
    expect((await h.send("/mail/poll", source, h.token)).status).toBe(401);
  });
  it("limits unique requests to three and expires all at 90 seconds without a queue", async () => {
    const h = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const reads = ["a", "b", "c"].map(threadId => h.bridge.readMailThread({ ...request, threadId }, () => {}).catch(error => error));
    await expect(h.bridge.readMailThread({ ...request, threadId: "d" }, () => {})).rejects.toThrow("Three");
    await vi.advanceTimersByTimeAsync(90001);
    for (const result of await Promise.all(reads)) expect(result.message).toContain("timed out");
    const next = h.bridge.readMailThread(request, () => {}).catch(error => error);
    await h.bridge.stop();
    expect((await next).message).toContain("stopped");
  });
  it("cannot issue a stale lease after revocation during asynchronous account validation", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const h = await setup(async () => { entered(); await wait; return { accountId: request.accountId, enabled: true }; });
    const pending = h.bridge.readMailThread(request, () => {}).catch(error => error);
    const poll = h.send("/mail/poll", source, h.token).catch(() => undefined);
    await reached;
    await h.bridge.revoke();
    release();
    await poll;
    expect((await pending).message).toContain("revoked");
  });
});

const directory = resolve(import.meta.dirname, "..", "browser-extension");
const require = createRequire(import.meta.url);
const { createBridge } = require(resolve(directory, "background.js"));

describe("dedicated full email worker", () => {
  async function worker(options: { interact?: boolean; switchTab?: boolean; mismatch?: boolean; inbox?: boolean } = {}) {
    let activate!: (info: { tabId: number; windowId: number }) => void;
    const job = { protocol: 1, requestId: "a".repeat(32), lease: "b".repeat(64),
      input: options.inbox ? { ...request, threadId: "__relay_inbox__", inboxRefresh: true } : request, expiresAt: Date.now() + 90000 };
    const tabs = new Map<number, any>([[10, { id: 10, windowId: 5, url: registration.pageUrl, active: true }]]);
    let bridge: any;
    const chrome = {
      runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}` },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({ token: "paired" }), remove: async () => {} } },
      tabs: {
        onActivated: { addListener: (fn: typeof activate) => { activate = fn; } }, onRemoved: { addListener: () => {} },
        get: vi.fn(async (id: number) => tabs.get(id)),
        query: vi.fn(async () => [...tabs.values()].filter(tab => tab.active)),
        create: vi.fn(async (input: any) => {
          const tab = { ...input, id: 11 };
          tabs.set(11, tab);
          if (input.active) { tabs.get(10).active = false; activate({ tabId: 11, windowId: 5 }); }
          return tab;
        }),
        update: vi.fn(async (id: number) => { tabs.get(id).active = true; }),
        remove: vi.fn(async (id: number) => { tabs.delete(id); }),
        sendMessage: vi.fn(async (_id: number, message: any) => {
          if (message.action === "mail-read-status") return { ok: true, value: { dirty: Boolean(options.interact),
            registration: { ...registration, pageUrl: tabs.get(11).url },
            diagnostics: { containers: 1, bodies: 1, senders: 1, threadMarkers: 0, rows: 2, matchingRows: 1 } } };
          if (options.inbox) return { ok: true, value: { code: "complete",
            capture: { ...registration, messages: [], meetings: [] }, interacted: false } };
          await bridge.handle({ type: "mail-row-proof", payload: { registration, requestId: job.requestId, lease: job.lease,
            rowProof: { threadId: request.threadId, inboxUrl: registration.pageUrl } } },
          { id: extensionId, tab: tabs.get(11), url: registration.pageUrl, frameId: 0, documentId: target.documentId });
          tabs.get(11).url = nativeRegistration.pageUrl;
          if (options.switchTab) { tabs.get(11).active = false; tabs.get(10).active = true; activate({ tabId: 10, windowId: 5 }); }
          return { ok: true, value: { code: "complete", capture: nativeFull(), interacted: Boolean(options.interact) } };
        }),
      },
    };
    let leased = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/discover")) return Response.json({ accountId: request.accountId, enabled: false });
      if (url.endsWith("/mail/poll")) {
        if (body.rowProof) return Response.json({ authorized: true });
        if (!body.requestId && leased) return Response.json({ job: null });
        leased = true;
        return Response.json({ job });
      }
      return Response.json({ accepted: true });
    });
    bridge = createBridge(chrome, fetch);
    const sender = (id: number, value: typeof registration, documentId: string) => ({
      id: extensionId, tab: tabs.get(id), url: value.pageUrl, frameId: 0, documentId,
    });
    await bridge.handle({ type: "discover", payload: registration }, sender(10, registration, source.documentId));
    await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledTimes(1));
    const dedicated = { ...registration, ...(options.mismatch ? { accountEmail: "other@example.org" } : {}) };
    expect(await bridge.handle({ type: "discover", payload: dedicated }, sender(11, dedicated, target.documentId)))
      .toMatchObject({ mailReadTab: true });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/mail/complete"))).toBe(true));
    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());
    return { chrome, fetch };
  }
  it("uses the verified numeric account route in a new tab and sends an exact-document command", async () => {
    const h = await worker();
    expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: registration.pageUrl, active: false, windowId: 5 });
    expect(h.chrome.tabs.sendMessage).toHaveBeenCalledWith(11, expect.objectContaining({ action: "mail-read" }), { documentId: target.documentId });
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    const uploaded = h.fetch.mock.calls.find(([url]) => url.endsWith("/mail/complete"))!;
    expect(JSON.parse(String(uploaded[1].body))).toMatchObject({ tabId: 11, documentId: target.documentId, capture: nativeFull() });
  });
  it("uses the same bounded owned-tab path for inbox acknowledgement without a conversation row click", async () => {
    const h = await worker({ inbox: true });
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(h.chrome.tabs.create).toHaveBeenCalledWith({ url: registration.pageUrl, active: false, windowId: 5 });
    const uploaded = h.fetch.mock.calls.find(([url]) => url.endsWith("/mail/complete"))!;
    expect(JSON.parse(String(uploaded[1].body))).toMatchObject({ code: "complete",
      tabId: 11, documentId: target.documentId, capture: { ...registration, messages: [], meetings: [] } });
    expect(h.chrome.tabs.update).not.toHaveBeenCalled();
  });
  it("never restores selection after the user switches tabs and never closes an interacted tab", async () => {
    const switched = await worker({ switchTab: true });
    expect(switched.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(switched.chrome.tabs.update).not.toHaveBeenCalled();
    const edited = await worker({ interact: true });
    expect(edited.chrome.tabs.remove).not.toHaveBeenCalled();
    expect(edited.chrome.tabs.update).not.toHaveBeenCalled();
    expect(JSON.parse(String(edited.fetch.mock.calls.find(([url]) => url.endsWith("/mail/complete"))![1].body)).code).toBe("interrupted");
  });
  it("rejects wrong-account redirection before requesting or uploading content", async () => {
    const h = await worker({ mismatch: true });
    expect(h.chrome.tabs.sendMessage.mock.calls.some(([, message]) => message.action === "mail-read")).toBe(false);
    expect(JSON.parse(String(h.fetch.mock.calls.find(([url]) => url.endsWith("/mail/complete"))![1].body))).toMatchObject({
      code: "account-mismatch", tabId: 10, documentId: source.documentId,
      diagnostics: { containers: 1, bodies: 1, senders: 1, threadMarkers: 0, rows: 2, matchingRows: 1 },
    });
  });
  it("does not open a late leased tab after pairing is forgotten during polling", async () => {
    let release!: (value: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const chrome = {
      runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}` },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({ token: "paired" }), remove: async () => {} } },
      tabs: { get: async () => ({ id: 10, url: registration.pageUrl, windowId: 5 }),
        create: vi.fn(), query: async () => [] },
    };
    const fetch = vi.fn(async (url: string) => url.endsWith("/discover")
      ? Response.json({ accountId: request.accountId, enabled: false }) : response);
    const bridge = createBridge(chrome, fetch);
    await bridge.handle({ type: "discover", payload: registration }, { id: extensionId, tab: { id: 10, url: registration.pageUrl },
      url: registration.pageUrl, frameId: 0, documentId: source.documentId });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/mail/poll"))).toBe(true));
    await bridge.handle({ type: "forget" }, { id: extensionId, url: chrome.runtime.getURL("popup.html") });
    release(Response.json({ job: { protocol: 1, requestId: "a".repeat(32), lease: "b".repeat(64),
      input: request, expiresAt: Date.now() + 90000 } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe.skipIf(!existsSync(chromium.executablePath()) && process.env.RELAY_EXTENSION_TEST_EDGE !== "1"
  && process.env.RELAY_EXTENSION_TEST_CHROME !== "1")("real DOM full email reading", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true,
    ...(process.env.RELAY_EXTENSION_TEST_CHROME === "1" ? { channel: "chrome" }
      : process.env.RELAY_EXTENSION_TEST_EDGE === "1" ? { channel: "msedge" } : {}) }); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });
  const header = `<header id="gb"><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@example.org)">Account</a></header>`;
  const message = (id = "18def", body = "<p>Complete <b>fixture</b></p>") => `<div class="adn" data-legacy-message-id="${id}">
    <div class="gE"><span class="gD" email="sender@example.org">Sender</span></div><div class="ii"><div class="a3s">${body}</div></div>
    <div class="aQH"><div class="modern-tile"><span class="aV3">report.pdf</span></div></div></div>`;
  async function load(content: string) {
    page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
    await page.goto(threadRegistration.pageUrl);
    await page.setContent(`${header}<main role="main"><h2 class="hP">Fixture</h2>${content}</main>`);
    await page.addScriptTag({ path: resolve(directory, "extractors.js") });
  }
  const read = () => page.evaluate(input => (globalThis as any).RelayExtractors.mail(document, location.href, input), request);
  const row = (id: string, subject = "Identical subject") => `<tr class="zA"><td><span email="sender@example.org">Sender</span></td>
    <td><span class="bog" data-legacy-thread-id="${id}" data-thread-id="thread-f:${id}">${subject}</span><span class="y2">Preview</span></td></tr>`;
  async function loadInbox(rows: string) {
    await load(`<table><tbody>${rows}</tbody></table>`);
    await page.evaluate(() => { history.replaceState(null, "", "#inbox"); });
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
  }
  it("awaits the trusted header, main and exact row beyond the former twelve-second row budget", async () => {
    await loadInbox("");
    await page.evaluate(({ header, html, row }) => {
      const start = Date.now(), clock = performance.now();
      Date.now = () => start + Math.floor((performance.now() - clock) * 10);
      document.querySelector("#gb")!.remove();
      document.querySelector("main")!.remove();
      setTimeout(() => document.body.insertAdjacentHTML("afterbegin", header), 150);
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<main role="main"><table><tbody></tbody></table></main>`), 350);
      setTimeout(() => {
        document.querySelector("tbody")!.innerHTML = row;
        document.querySelector(".bog")!.addEventListener("mouseup", () => {
          location.hash = "#inbox/FMopaqueProviderRoute";
          document.querySelector("main")!.innerHTML = html;
        });
      }, 1600);
    }, { header, html: message(), row: row(request.threadId) });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 60000
    }, { authorizeRow: async () => {} }), request);
    expect(result.code).toBe("complete");
    expect(result.diagnostics).toMatchObject({ readPhase: 6, identityReady: 1, pageBusy: 0 });
  });
  it.each(["missing", "mismatch"])("never accepts an unverified account while its header is %s", async state => {
    await loadInbox(row(request.threadId));
    await page.evaluate(({ state, header }) => {
      document.querySelector("#gb")!.remove();
      (globalThis as any).clicks = 0;
      document.querySelector(".bog")!.addEventListener("mouseup", () => (globalThis as any).clicks++);
      if (state === "mismatch") setTimeout(() =>
        document.body.insertAdjacentHTML("afterbegin", header.replace("owner@example.org", "other@example.org")), 200);
    }, { state, header });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 650
    }, { authorizeRow: async () => {} }), request);
    expect(result.code).toBe(state === "missing" ? "partial" : "account-mismatch");
    expect(result.capture).toBeUndefined();
    expect(await page.evaluate(() => (globalThis as any).clicks)).toBe(0);
  });
  it("waits for Gmail loading to finish and requires elapsed stable body time despite rapid DOM mutations", async () => {
    await load(message("18def", "<p>Still loading</p>"));
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
    await page.evaluate(() => {
      document.querySelector("main")!.setAttribute("aria-busy", "true");
      let n = 0;
      const timer = setInterval(() => { document.querySelector("main")!.setAttribute("data-render", String(n++)); }, 10);
      setTimeout(() => {
        document.querySelector(".a3s")!.innerHTML = "<p>Finished body</p>";
        document.querySelector("main")!.removeAttribute("aria-busy");
      }, 1300);
      setTimeout(() => clearInterval(timer), 2600);
    });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 5000
    }), request);
    expect(result).toMatchObject({ code: "complete", capture: { messages: [{ body: "Finished body" }] } });
    expect(result.diagnostics.stableBodyMs).toBeGreaterThanOrEqual(1000);
  });
  it.each(["waiting", "authorizing", "authorization-stalled"])("stops an aborted read while %s without late native clicks", async phase => {
    await loadInbox(phase === "waiting" ? "" : row(request.threadId));
    const result = await page.evaluate(async ({ input, phase, row }) => {
      const controller = new AbortController();
      (globalThis as any).clicks = 0;
      const abort = () => controller.abort();
      if (phase === "waiting") setTimeout(() => {
        abort();
        document.querySelector("tbody")!.innerHTML = row;
        document.querySelector(".bog")!.addEventListener("mouseup", () => (globalThis as any).clicks++);
      }, 100);
      else document.querySelector(".bog")!.addEventListener("mouseup", () => (globalThis as any).clicks++);
      return await (globalThis as any).RelayMailRead.execute({ input, expiresAt: Date.now() + 5000 }, {
        signal: controller.signal, authorizeRow: async () => {
          if (phase === "authorization-stalled") {
            setTimeout(abort, 100);
            return await new Promise(() => {});
          }
          abort();
        }
      });
    }, { input: request, phase, row: row(request.threadId) });
    expect(result.code).toBe("interrupted");
    expect(await page.evaluate(() => (globalThis as any).clicks)).toBe(0);
  });
  it("cancels content-script work only for the matching extension request and lease", async () => {
    await loadInbox("");
    await page.evaluate(() => {
      (globalThis as any).chrome = { runtime: { id: "fixture-extension",
        onMessage: { addListener: (fn: any) => { (globalThis as any).receive = fn; } },
        sendMessage: async () => ({ ok: true, value: { enabled: false } }) } };
    });
    await page.addScriptTag({ path: resolve(directory, "content.js") });
    const result = await page.evaluate(async input => {
      const receive = (globalThis as any).receive, sender = { id: "fixture-extension" };
      const job = { input, expiresAt: Date.now() + 5000, requestId: "request", lease: "lease" };
      let settled = false;
      const result = new Promise<any>(resolve => receive({ type: "relay-tab", action: "mail-read", job }, sender,
        (value: any) => { settled = true; resolve(value); }));
      receive({ type: "relay-tab", action: "mail-read-cancel", requestId: "request", lease: "other" }, sender, () => {});
      receive({ type: "relay-tab", action: "mail-read-cancel", requestId: "request", lease: "lease" }, { id: "other" }, () => {});
      await new Promise(resolve => setTimeout(resolve, 100));
      const premature = settled;
      receive({ type: "relay-tab", action: "mail-read-cancel", requestId: "request", lease: "lease" }, sender, () => {});
      return { premature, response: await result };
    }, request);
    expect(result).toMatchObject({ premature: false, response: { ok: true, value: { code: "interrupted" } } });
  });
  it("awaits native Refresh and stable new inbox rows before acknowledging freshness", async () => {
    await loadInbox(row("old"));
    await page.evaluate(html => {
      const button = document.createElement("button"); button.setAttribute("aria-label", "Refresh");
      button.addEventListener("click", () => {
        button.setAttribute("aria-disabled", "true");
        setTimeout(() => {
          document.querySelector("tbody")!.innerHTML = html;
          button.setAttribute("aria-disabled", "false");
        }, 50);
      });
      document.querySelector("main")!.prepend(button);
    }, row("new-reply", "Urgent new request"));
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 5000
    }), request);
    expect(result).toMatchObject({ code: "complete", capture: { pageUrl: registration.pageUrl,
      messages: [{ threadId: "new-reply", completeness: "preview", subject: "Urgent new request" }] } });
  });
  it.each([false, true])("does not acknowledge an inbox without a refresh response, including button-only styling: %s", async styled => {
    await loadInbox(row("old"));
    await page.evaluate(styled => {
      const button = document.createElement("button"); button.setAttribute("aria-label", "Refresh");
      if (styled) button.addEventListener("mouseup", () => { button.className = "pressed"; });
      document.querySelector("main")!.prepend(button);
    }, styled);
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 800
    }), request);
    expect(result.code).toBe("partial");
    expect(result.capture).toBeUndefined();
  });
  it.each(["click", "mouseup"])("acknowledges unchanged inbox rows after Gmail's external loading indicator completes on %s", async event => {
    await loadInbox(row("old"));
    await page.evaluate(event => {
      const status = document.createElement("div"); status.id = "loading"; status.style.display = "none";
      status.textContent = "Loading...";
      document.body.append(status);
      const button = document.createElement("button"); button.setAttribute("aria-label", "Refresh");
      button.addEventListener(event, () => {
        status.style.display = "block";
        setTimeout(() => { status.style.display = "none"; }, 500);
      });
      document.querySelector("main")!.prepend(button);
    }, event);
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 5000
    }), request);
    expect(result).toMatchObject({ code: "complete", capture: { messages: [{ threadId: "old" }] } });
  });
  it.each(["success", "cached", "failed", "old", "other-host", "other-operation"])(
    "accepts only a new successful native inbox-view response without repainting: %s", async mode => {
      await loadInbox(row("old"));
      await page.evaluate(mode => {
        const entries: object[] = [];
        Object.defineProperty(performance, "getEntriesByType", { value: () => entries });
        const button = document.createElement("button"); button.setAttribute("aria-label", "Refresh");
        button.addEventListener("mouseup", () => {
          const startTime = mode === "old" ? 0 : performance.now();
          entries.push({ initiatorType: "fetch", startTime, responseEnd: startTime + 1,
            responseStatus: mode === "failed" ? 503 : 200, transferSize: mode === "cached" ? 0 : 100,
            name: mode === "other-host" ? "https://example.org/sync/u/0/i/bv"
              : `https://mail.google.com/sync/u/0/i/${mode === "other-operation" ? "log" : "bv"}` });
        });
        document.querySelector("main")!.prepend(button);
      }, mode);
      const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
        input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 2000
      }), request);
      expect(result.code).toBe(mode === "success" ? "complete" : "partial");
      if (mode !== "success") expect(result.capture).toBeUndefined();
    });
  it("does not label a conversation page fresh even when a Refresh control exists", async () => {
    await loadInbox(row("old"));
    await page.evaluate(() => history.replaceState(null, "", "#all/18abc"));
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 5000
    }), request);
    expect(result.code).toBe("interrupted");
  });
  it("does not acknowledge stale rows when native Refresh reports a connection failure", async () => {
    await loadInbox(row("old"));
    await page.evaluate(() => {
      const button = document.createElement("button"); button.setAttribute("aria-label", "Refresh");
      button.addEventListener("click", () => {
        const alert = document.createElement("div"); alert.setAttribute("role", "alert");
        alert.textContent = "You are offline";
        document.querySelector("main")!.append(alert);
      });
      document.querySelector("main")!.prepend(button);
    });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input: { ...input, inboxRefresh: true, threadId: "__relay_inbox__" }, expiresAt: Date.now() + 5000
    }), request);
    expect(result.code).toBe("unavailable");
    expect(result.capture).toBeUndefined();
  });
  it.each(["click", "mouseup"])("opens the exact row once via %s and waits for delayed native navigation", async event => {
    await loadInbox(row("other") + row(request.threadId));
    await page.evaluate(({ input, html, event }) => {
      const globals = globalThis as any;
      globals.clicked = [];
      for (const subject of document.querySelectorAll(".bog")) subject.addEventListener(event, () => {
        globals.clicked.push(subject.getAttribute("data-legacy-thread-id"));
        setTimeout(() => {
          location.hash = "#inbox/FMopaqueProviderRoute";
          setTimeout(() => { document.querySelector("main")!.innerHTML = `<h2 class="hP">Full thread</h2>${html}`; }, 650);
        }, 600);
      });
      globals.authorization = [];
      globals.result = () => globals.RelayMailRead.execute({ input, expiresAt: Date.now() + 5000 }, {
        authorizeRow: async (registration: any, proof: any) => { globals.authorization.push({ registration, proof }); }
      });
    }, { input: request, html: message(), event });
    const result = await page.evaluate(() => (globalThis as any).result());
    expect(result.code).toBe("complete");
    expect(result.capture).toMatchObject({ pageUrl: nativeRegistration.pageUrl, accountEmail: request.accountEmail,
      messages: [{ threadId: request.threadId, id: "18def", completeness: "full", html: "<p>Complete <b>fixture</b></p>",
        attachments: [{ name: "report.pdf" }] }] });
    expect(await page.evaluate(() => (globalThis as any).clicked)).toEqual([request.threadId]);
    expect(await page.evaluate(() => (globalThis as any).authorization)).toEqual([{
      registration: { ...registration }, proof: { threadId: request.threadId, inboxUrl: registration.pageUrl, providerThreadId: "thread-f:18abc" }
    }]);
  });
  it("fails with aggregate row counts when the exact archived thread is not loaded; matching subject is not enough", async () => {
    await loadInbox(row("other") + `<tr class="zA" hidden><td><span class="bog" data-legacy-thread-id="18abc">Hidden exact subject</span></td></tr>`);
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 650
    }, { authorizeRow: () => { throw new Error("Must not authorize an unrelated row."); } }), request);
    expect(result).toMatchObject({ code: "unsupported", diagnostics: { rows: 1, matchingRows: 0, containers: 0, bodies: 0 } });
    expect(result.capture).toBeUndefined();
  });
  it.each(["View entire message", "Afficher l'intégralité du message"])("does not label a Gmail-clipped body complete (%s)", async label => {
    await load(message() + `<div class="ii"><a href="https://mail.google.com/mail/u/0/?view=lg">${label}</a></div>`);
    const error = await page.evaluate(input => {
      try { (globalThis as any).RelayExtractors.mail(document, location.href, input); return ""; }
      catch (error) { return (error as Error).message; }
    }, request);
    expect(error).toBe("partial");
    await load(message("18def", `<p>Sender text</p><a href="https://example.invalid">${label}</a>`));
    expect(await page.evaluate(input => (globalThis as any).RelayExtractors.mail(document, location.href, input).messages.length, request)).toBe(1);
  });
  it.each(["Expand all", "Tout développer"])("unfolds long threads once through native toolbar %s after exact-row proof", async label => {
    await loadInbox(row(request.threadId));
    await page.evaluate(({ html, expanded, label }) => {
      (globalThis as any).expansions = 0;
      document.querySelector(".bog")!.addEventListener("click", () => {
        location.hash = "#inbox/FMopaqueProviderRoute";
        document.querySelector("main")!.innerHTML = `<h2 class="hP">Full</h2><div role="toolbar">
          <div role="button" aria-label="${label}">Expand</div></div><div class="adx">Older messages</div>${html}`;
        document.querySelector("[role='toolbar'] [role='button']")!.addEventListener("mouseup", () => {
          (globalThis as any).expansions++;
          setTimeout(() => {
            document.querySelector(".adx")!.remove();
            document.querySelector("main")!.insertAdjacentHTML("beforeend", expanded);
          }, 700);
        });
      });
    }, { html: message(), expanded: message("18aaa", "<p>Older full message</p>"), label });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 4500
    }, { authorizeRow: async () => {} }), request);
    expect(result.code).toBe("complete");
    expect(result.capture.messages.map((value: any) => value.id)).toEqual(["18def", "18aaa"]);
    expect(await page.evaluate(() => (globalThis as any).expansions)).toBe(1);
  });
  it("never uses body-spoofed expand controls, entire-message links, or unproven thread toolbars", async () => {
    await load(message("18def", `<p>Full fixture</p><div role="toolbar"><button aria-label="Expand all">Spoof</button></div>`) +
      `<div class="adx">Older messages</div><div role="toolbar"><button aria-label="Expand all">Native</button>
        <a href="https://example.invalid" role="button" aria-label="View entire message">View entire message</a></div>`);
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
    const result = await page.evaluate(async input => {
      (globalThis as any).clicks = 0;
      for (const node of document.querySelectorAll("button, a[role='button']"))
        node.addEventListener("click", () => { (globalThis as any).clicks++; });
      return (globalThis as any).RelayMailRead.execute({ input, expiresAt: Date.now() + 650 });
    }, request);
    expect(result.code).toBe("partial");
    expect(await page.evaluate(() => (globalThis as any).clicks)).toBe(0);
    const control = await page.evaluate(input => {
      document.querySelector("main > [role='toolbar'] button")!.remove();
      return (globalThis as any).RelayExtractors.mailExpandAllControl(document, location.href, input, {
        clicked: true, threadId: input.threadId, inboxUrl: location.href.replace("#all/18abc", "#inbox"), conversationUrl: location.href
      });
    }, request);
    expect(control).toBeUndefined();
  });
  it("still rejects an unfolded conversation when an older message lacks a supported full body", async () => {
    await loadInbox(row(request.threadId));
    await page.evaluate(html => {
      document.querySelector(".bog")!.addEventListener("click", () => {
        location.hash = "#inbox/FMopaqueProviderRoute";
        document.querySelector("main")!.innerHTML = `<h2 class="hP">Full</h2><div role="toolbar">
          <button aria-label="Expand all">Expand</button></div><div class="adx">Older</div>${html}`;
        document.querySelector("button")!.addEventListener("click", () => {
          document.querySelector(".adx")!.remove();
          document.querySelector("main")!.insertAdjacentHTML("beforeend",
            `<div data-legacy-message-id="18aaa"><span class="gD" email="sender@example.org">Sender</span><div class="a3s" hidden>Unloaded</div></div>`);
        });
      });
    }, message());
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 1800
    }, { authorizeRow: async () => {} }), request);
    expect(result.code).toBe("partial");
    expect(result.capture).toBeUndefined();
    expect(result.diagnostics).toMatchObject({ containers: 2, bodies: 1 });
  });
  it("does not click after row authorization is revoked or the row identity changes", async () => {
    await loadInbox(row(request.threadId));
    const result = await page.evaluate(input => {
      (globalThis as any).clicks = 0;
      document.querySelector(".bog")!.addEventListener("click", () => { (globalThis as any).clicks++; });
      return (globalThis as any).RelayMailRead.execute({ input, expiresAt: Date.now() + 1000 }, {
        authorizeRow: async () => { document.querySelector(".bog")!.setAttribute("data-legacy-thread-id", "changed"); }
      });
    }, request);
    expect(result.code).toBe("interrupted");
    expect(await page.evaluate(() => (globalThis as any).clicks)).toBe(0);
  });
  it.each(["different-account", "second-navigation", "conflicting-dom-id"])("rejects %s after the authorized native click", async kind => {
    await loadInbox(row(request.threadId));
    await page.evaluate(({ html, kind }) => {
      document.querySelector(".bog")!.addEventListener("click", () => {
        history.replaceState(null, "", kind === "different-account" ? "/mail/u/3/#inbox/FMopaqueProviderRoute" : "#inbox/FMopaqueProviderRoute");
        document.querySelector("main")!.innerHTML = `<h2 class="hP"${kind === "conflicting-dom-id" ? ' data-legacy-thread-id="other"' : ""}>Full</h2>${html}`;
        if (kind === "second-navigation") setTimeout(() => { location.hash = "#inbox/AnotherThread"; }, 900);
      });
    }, { html: message(), kind });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({
      input, expiresAt: Date.now() + 4000
    }, { authorizeRow: async () => {} }), request);
    expect(result.code).toBe("thread-mismatch");
    expect(result.capture).toBeUndefined();
    expect(result.diagnostics).toHaveProperty("containers", 1);
  });
  it("rejects duplicate exact rows, forged body rows, and a native subject link to another account", async () => {
    await loadInbox(row(request.threadId) + row(request.threadId));
    await expect(page.evaluate(input => (globalThis as any).RelayExtractors.exactMailRow(document, location.href, input), request)).rejects.toThrow("unsupported");
    await page.locator("main").evaluate((main, html) => { main.innerHTML = `<div class="a3s"><table>${html}</table></div>`; }, row(request.threadId));
    expect(await page.evaluate(input => (globalThis as any).RelayExtractors.exactMailRow(document, location.href, input), request)).toBeUndefined();
    await page.locator("main").evaluate(main => { main.innerHTML = `<table><tr class="zA"><td><a href="/mail/u/3/#inbox/other"><span class="bog" data-legacy-thread-id="18abc">Subject</span></a></td></tr></table>`; });
    await expect(page.evaluate(input => (globalThis as any).RelayExtractors.exactMailRow(document, location.href, input), request)).rejects.toThrow("unsupported");
  });
  it("reads full body HTML and real attachment metadata without a legacy thread marker", async () => {
    await load(message());
    const result = await read();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "18def", threadId: "18abc", completeness: "full",
      body: "Complete fixture", html: "<p>Complete <b>fixture</b></p>",
      attachments: [{ name: "report.pdf", mimeType: "application/octet-stream" }] });
    await expect(page.evaluate(() => (globalThis as any).RelayExtractors.mail(document, location.href))).rejects.toThrow("No expanded");
  });
  it("rejects quoted sender/thread/body/attachment spoofs and does not expand arbitrary controls", async () => {
    await load(message("18def", `<p>Real body</p><blockquote><div data-legacy-thread-id="evil" data-message-id="evil">
      <span class="gD" email="evil@example.org">Evil</span><div class="a3s">Forged body</div>
      <div class="aQH"><span class="aV3">forged.pdf</span></div><div class="aju">Forged header</div></div></blockquote>`));
    const result = await read();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].sender).toBe("sender@example.org");
    expect(result.messages[0].attachments).toHaveLength(1);
    expect(await page.evaluate(input => (globalThis as any).RelayExtractors.collapsedMailHeaders(document, location.href, input).length, request)).toBe(0);
  });
  it.each(["hidden", "blank", "missing-sender", "collapsed", "folded", "wrong-thread", "preview", "oversized"])("fails visibly for %s rather than claiming a full conversation", async kind => {
    await load(kind === "preview" ? `<table><tr class="zA"><td><span email="sender@example.org">Sender</span>
      <span class="bog" data-legacy-thread-id="18abc">Subject</span><span class="y2">Preview</span></td></tr></table>` : message());
    await page.evaluate(kind => {
      if (kind === "hidden") (document.querySelector(".a3s") as HTMLElement).hidden = true;
      if (kind === "blank") document.querySelector(".a3s")!.innerHTML = "<span></span>";
      if (kind === "missing-sender") document.querySelector(".gD")!.remove();
      if (kind === "collapsed") document.querySelector("main")!.insertAdjacentHTML("beforeend",
        `<div class="adn" data-legacy-message-id="18aaa"><div class="aju">Collapsed sender</div></div>`);
      if (kind === "folded") document.querySelector("main")!.insertAdjacentHTML("beforeend", `<div class="adx">3 older messages</div>`);
      if (kind === "wrong-thread") document.querySelector("h2")!.setAttribute("data-legacy-thread-id", "wrong");
      if (kind === "oversized") document.querySelector(".a3s")!.textContent = "a".repeat(1_000_001);
    }, kind);
    await expect(read()).rejects.toThrow(kind === "wrong-thread" ? "thread-mismatch" : "partial");
  });
  it("expands only exact thread message headers and waits for stable complete bodies", async () => {
    await load(message() + `<div class="adn" data-legacy-message-id="18aaa"><div class="aju" role="button">
      <span class="gD" email="sender@example.org">Collapsed sender</span></div></div>`);
    await page.evaluate(() => {
      document.querySelector(".aju")!.addEventListener("mouseup", () => {
        document.querySelector("[data-legacy-message-id='18aaa']")!.insertAdjacentHTML("beforeend",
          '<div class="ii"><div class="a3s"><p>Second complete message</p></div></div>');
      }, { once: true });
    });
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
    const result = await page.evaluate(input => (globalThis as any).RelayMailRead.execute({ input, expiresAt: Date.now() + 5000 }), request);
    expect(result.code).toBe("complete");
    expect(result.capture.messages).toHaveLength(2);
    expect(result.interacted).toBe(false);
  });
});
