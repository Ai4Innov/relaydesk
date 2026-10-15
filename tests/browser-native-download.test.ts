import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserBridge } from "../src/main/browser/bridge";

const directory = resolve(import.meta.dirname, "..", "browser-extension");
const require = createRequire(import.meta.url);
const { createBridge, downloadAttachment, validAttachmentIntent } = require(resolve(directory, "background.js"));
const { mailAttachmentSize, nativeAttachmentUrl } = require(resolve(directory, "extractors.js"));
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const relativePath = "RelayDesk/12345678-1234-1234-1234-123456789abc/report.pdf";
const url = "https://mail.google.com/mail/u/2/?native-fixture-download";
const input = { accountId: "account", accountEmail: "owner@example.org", threadId: "18abc", messageProviderId: "18def",
  attachment: { metadataId: "report.pdf", name: "report.pdf", maxBytes: 10000, relativePath } };

describe("native download ownership and byte policy", () => {
  function fixture(itemPatch: Record<string, unknown> = {}) {
    const listeners = new Set<(value: any) => void>();
    const item = { id: 41, byExtensionId: extensionId, url, danger: "safe", state: "complete",
      filename: `C:\\Users\\Fixture\\Downloads\\${relativePath.replaceAll("/", "\\")}`,
      totalBytes: 1234, bytesReceived: 1234, fileSize: 1234, ...itemPatch };
    const chrome = { runtime: { id: extensionId }, downloads: {
      download: vi.fn(async () => 41), search: vi.fn(async () => [item]), cancel: vi.fn(async () => {}),
      open: vi.fn(), acceptDanger: vi.fn(), onChanged: {
        addListener: (fn: (value: any) => void) => listeners.add(fn),
        removeListener: (fn: (value: any) => void) => listeners.delete(fn),
      },
    } };
    const pending = { job: { input, expiresAt: Date.now() + 10000 }, attachmentProof: { url }, downloadId: undefined };
    const check = vi.fn(async () => {}), remember = vi.fn(async () => {});
    return { chrome, pending, item, listeners, check, remember,
      run: () => downloadAttachment(chrome, pending, check, remember) };
  }
  it("requests the exact native URL and staging name, returns only bounded attestation", async () => {
    const h = fixture();
    expect(await h.run()).toEqual({ metadataId: "report.pdf", name: "report.pdf", relativePath, bytes: 1234 });
    expect(h.chrome.downloads.download).toHaveBeenCalledWith({ url, filename: relativePath, saveAs: false, conflictAction: "uniquify" });
    expect(h.pending.downloadId).toBe(41);
    expect(h.remember).toHaveBeenCalledOnce();
    expect(h.chrome.downloads.cancel).not.toHaveBeenCalled();
    expect(h.chrome.downloads.open).not.toHaveBeenCalled();
    expect(h.chrome.downloads.acceptDanger).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
  it.each([
    [{ danger: "dangerous", state: "in_progress" }, "attachment-dangerous"],
    [{ danger: "accepted", state: "in_progress" }, "attachment-dangerous"],
    [{ state: "interrupted", error: "NETWORK_FAILED" }, "attachment-download-failed"],
    [{ state: "interrupted", error: "USER_CANCELED" }, "attachment-interrupted"],
    [{ totalBytes: 10001, state: "in_progress" }, "attachment-size-limit"],
    [{ bytesReceived: 10001, state: "in_progress" }, "attachment-size-limit"],
    [{ totalBytes: -1 }, "attachment-size-limit"],
    [{ filename: "C:\\Custom\\report.pdf" }, "attachment-path-mismatch"],
    [{ filename: `C:\\Users\\Fixture\\Downloads\\${relativePath.replaceAll("/", "\\").replace(".pdf", " (1).pdf")}` }, "attachment-path-mismatch"],
    [{ byExtensionId: "foreign-extension", state: "in_progress" }, "attachment-interrupted"],
    [{ id: 42, state: "in_progress" }, "attachment-interrupted"],
    [{ url: "https://example.org/file", state: "in_progress" }, "attachment-interrupted"],
    [{ finalUrl: "https://example.org/file", state: "in_progress" }, "attachment-interrupted"],
  ])("fails closed for download item %j", async (patch, code) => {
    const h = fixture(patch);
    const changes: Record<string, unknown> = patch;
    await expect(h.run()).rejects.toThrow(code);
    if (changes.byExtensionId || changes.id) expect(h.chrome.downloads.cancel).not.toHaveBeenCalled();
    else if (changes.state === "in_progress") expect(h.chrome.downloads.cancel).toHaveBeenCalledWith(41);
    expect(h.chrome.downloads.open).not.toHaveBeenCalled();
    expect(h.chrome.downloads.acceptDanger).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
  it("cancels only its remembered ID on live permission revocation", async () => {
    const h = fixture({ state: "in_progress" });
    h.check.mockImplementation(async () => {
      if (h.pending.downloadId !== undefined) throw new Error("attachment-authorization-denied");
    });
    await expect(h.run()).rejects.toThrow("attachment-authorization-denied");
    expect(h.chrome.downloads.cancel).toHaveBeenCalledExactlyOnceWith(41);
  });
  it("attests an owned zero-byte file without comparing approximate native metadata", async () => {
    const h = fixture({ bytesReceived: 0, totalBytes: 0, fileSize: 0 });
    expect(await h.run()).toEqual({ metadataId: "report.pdf", name: "report.pdf", relativePath, bytes: 0 });
    expect(h.pending.downloadId).toBe(41);
  });
  it("does not start a file after the bounded lease deadline", async () => {
    const h = fixture();
    h.pending.job.expiresAt = Date.now() - 1;
    await expect(h.run()).rejects.toThrow("attachment-interrupted");
    expect(h.chrome.downloads.download).not.toHaveBeenCalled();
    expect(h.chrome.downloads.cancel).not.toHaveBeenCalled();
  });
  it("ignores foreign download events, responds to its own byte growth and removes the listener", async () => {
    const h = fixture({ state: "in_progress" });
    const work = h.run();
    await vi.waitFor(() => expect(h.listeners.size).toBe(1));
    for (const listener of h.listeners) listener({ id: 99, state: { current: "complete" } });
    h.item.bytesReceived = 10001;
    for (const listener of h.listeners) listener({ id: 41, bytesReceived: { current: 10001 } });
    await expect(work).rejects.toThrow("attachment-size-limit");
    expect(h.chrome.downloads.cancel).toHaveBeenCalledExactlyOnceWith(41);
    expect(h.listeners.size).toBe(0);
  });
  it("blocks unsafe paths, filenames, missing message IDs, and unbounded budgets before Chrome", () => {
    expect(validAttachmentIntent(input)).toBe(true);
    for (const patch of [{ name: "../report.pdf" }, { name: "CON.pdf" }, { name: "report.pdf " },
      { relativePath: "../report.pdf" }, { relativePath: "RelayDesk/12345678-1234-1234-1234-123456789abc/other.pdf" },
      { maxBytes: 0 }, { maxBytes: Number.MAX_SAFE_INTEGER }])
      expect(validAttachmentIntent({ ...input, attachment: { ...input.attachment, ...patch } })).toBe(false);
    expect(validAttachmentIntent({ ...input, messageProviderId: "thread:18abc" })).toBe(false);
  });
  it.each([["1.5 KB", 1500], ["1,5 Mo", 1500000], ["2 KiB", 2048], ["1 024 octets", 1024], ["512 B", 512], ["0 o", 0],
    ["1\u202f024 bytes", 1024], ["2 GiB", 2147483648], ["1,234 KB", undefined],
    ["Download", undefined], ["", undefined], ["12", undefined]])("parses only unambiguous displayed sizes %s", (text, expected) => {
    expect(mailAttachmentSize(text)).toBe(expected);
  });
  it("accepts only strict native Google URLs and filename-bound wrappers", () => {
    expect(nativeAttachmentUrl(`application/pdf:report.pdf:${url}`, "report.pdf")).toBe(url);
    for (const value of [`application/pdf:other.pdf:${url}`, "https://mail.google.com.evil.invalid/file",
      "https://evil.invalid/file", "https://user@mail.google.com/file", "http://mail.google.com/file",
      "https://drive.google.com/file", "https://mail.google.com/file#fragment"])
      expect(nativeAttachmentUrl(value, "report.pdf")).toBeUndefined();
  });
});

describe("document-bound attachment authorization worker", () => {
  const registration = { kind: "mail", accountEmail: input.accountEmail, accountName: "Owner",
    pageUrl: "https://mail.google.com/mail/u/2/#inbox" };
  const conversation = { ...registration, pageUrl: "https://mail.google.com/mail/u/2/#inbox/FMnative" };
  async function worker(options: { mismatch?: string; rejectGuard?: boolean; replay?: boolean; twice?: boolean;
    realBridge?: boolean; approvedUnknown?: boolean; failedCapture?: boolean } = {}) {
    let bridge: any, nextRequest = 0, activeJob: any, leased = false;
    const jobInput = { ...input, attachment: { ...input.attachment, approved: options.approvedUnknown === true } };
    let desktop: BrowserBridge | undefined, desktopToken: string | undefined, desktopResult: Promise<unknown> | undefined;
    if (options.realBridge) {
      const records = new Map<string, unknown>();
      desktop = new BrowserBridge({
        get: <T>(_collection: "secrets", id: string) => records.get(id) as T | undefined,
        put: (_collection, id, value) => { records.set(id, value); }, delete: (_collection, id) => { records.delete(id); },
      }, { extensionId, port: 0, changed: () => {},
        onDiscover: async () => ({ accountId: input.accountId, enabled: false }),
        onCapture: async () => { throw new Error("One-shot attachments must not enter automatic capture."); } });
      const pairing = await desktop.pair();
      const response = await globalThis.fetch(`http://127.0.0.1:${desktop.status().port}/pair`, {
        method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      });
      desktopToken = (await response.json()).token;
      desktopResult = desktop.readMailThread(jobInput, () => {}).catch(error => error);
    }
    const tabs = new Map<number, any>([[10, { id: 10, windowId: 5, url: registration.pageUrl, active: true }]]);
    const completed: any[] = [], commands: string[] = [];
    const sender = (id: number) => ({ id: extensionId, tab: { ...tabs.get(id) }, frameId: 0,
      documentId: `document-${id}`, url: tabs.get(id).url });
    const discover = (id: number) => bridge.handle({ type: "discover",
      payload: { ...registration, pageUrl: tabs.get(id).url } }, sender(id));
    const chrome = {
      runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}` },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({ token: "paired" }), remove: async () => {} } },
      downloads: {
        download: vi.fn(async () => 41), cancel: vi.fn(async () => {}), open: vi.fn(), acceptDanger: vi.fn(),
        search: vi.fn(async () => [{ id: 41, byExtensionId: extensionId, url, danger: "safe", state: "complete",
          filename: `C:\\Users\\Fixture\\Downloads\\${relativePath.replaceAll("/", "\\")}`,
          totalBytes: 1234, bytesReceived: 1234, fileSize: 1234 }]),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        onActivated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() },
        get: vi.fn(async (id: number) => tabs.get(id)),
        query: vi.fn(async () => [...tabs.values()].filter(tab => tab.active)),
        create: vi.fn(async (value: any) => { const tab = { ...value, id: 11 }; tabs.set(11, tab); return tab; }),
        update: vi.fn(async (id: number, value: any) => { Object.assign(tabs.get(id), value); return tabs.get(id); }),
        remove: vi.fn(async (id: number) => tabs.delete(id)),
        sendMessage: vi.fn(async (id: number, message: any, delivery: any) => {
          if (message.action !== "connect") expect(delivery?.documentId).toBe(`document-${id}`);
          if (message.action === "connect") { await discover(id); return { ok: true, value: {} }; }
          if (message.action === "mail-read-status") return { ok: true, value: {
            dirty: false, registration: { ...registration, pageUrl: tabs.get(id).url },
          } };
          if (message.action !== "mail-read") throw new Error("Unexpected command");
          const job = message.job;
          await bridge.handle({ type: "mail-row-proof", payload: { registration, requestId: job.requestId, lease: job.lease,
            rowProof: { threadId: input.threadId, inboxUrl: registration.pageUrl } } }, sender(id));
          tabs.get(id).url = conversation.pageUrl;
          const payload: any = { registration: conversation, requestId: job.requestId, lease: job.lease,
            messageProviderId: input.messageProviderId, metadataId: input.attachment.metadataId,
            name: input.attachment.name, size: options.approvedUnknown ? undefined : 1500, url };
          const origin = sender(id);
          if (options.mismatch === "document") origin.documentId = "other";
          if (options.mismatch === "source-tab") Object.assign(origin, sender(10));
          if (options.mismatch === "name") payload.name = "other.pdf";
          if (options.mismatch === "message") payload.messageProviderId = "other";
          if (options.mismatch === "metadata") payload.metadataId = "other";
          if (options.mismatch === "size") payload.size = undefined;
          if (options.mismatch === "external") payload.url = "https://example.org/file";
          if (options.mismatch === "account") payload.registration = { ...conversation, accountEmail: "other@example.org" };
          try {
            commands.push("authorize");
            await bridge.handle({ type: "mail-attachment-authorize", payload }, origin);
            if (options.replay) await expect(bridge.handle({ type: "mail-attachment-authorize", payload }, origin))
              .rejects.toThrow("attachment-authorization-denied");
            commands.push("download");
            const attachmentDownload = await bridge.handle({ type: "mail-attachment-download", payload }, origin);
            if (options.replay) await expect(bridge.handle({ type: "mail-attachment-download", payload }, origin))
              .rejects.toThrow("attachment-authorization-denied");
            return { ok: true, value: { code: "complete", capture: { ...conversation, meetings: [], attachmentDownload,
              messages: [{ id: input.messageProviderId, threadId: input.threadId, subject: "Fixture", sender: "sender@example.org",
                recipients: [], body: "Full body", html: "<p>Full body</p>", dateText: "", url: conversation.pageUrl,
                unread: false, completeness: "full", attachments: [{ id: "report.pdf", name: "report.pdf",
                  mimeType: "application/octet-stream", ...(options.approvedUnknown ? {} : { size: 1500 }) }] }] } } };
          } catch (error) {
            return { ok: true, value: { code: (error as Error).message.startsWith("attachment-") ?
              (error as Error).message : "attachment-interrupted",
              ...(options.failedCapture ? { capture: { messages: [], meetings: [] } } : {}) } };
          }
        }),
      },
    };
    const fetch = vi.fn(async (value: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (desktop) {
        const response = await globalThis.fetch(`http://127.0.0.1:${desktop.status().port}${new URL(value).pathname}`, {
          ...init, headers: { ...init.headers, Origin: `chrome-extension://${extensionId}`, Authorization: `Bearer ${desktopToken}` },
        });
        if (value.endsWith("/mail/complete")) completed.push({ ...body, responseStatus: response.status });
        return response;
      }
      if (value.endsWith("/discover")) return Response.json({ accountId: input.accountId, enabled: false });
      if (value.endsWith("/mail/poll")) {
        if (body.rowProof) return Response.json({ authorized: true });
        if (!body.requestId) {
          if (leased) return Response.json({ job: null });
          leased = true;
          activeJob = { protocol: 1, requestId: `${++nextRequest}`.padStart(32, "a"), lease: "b".repeat(64),
            input: jobInput, expiresAt: Date.now() + 300000 };
        }
        return Response.json({ job: activeJob });
      }
      if (value.endsWith("/mail/attachment/authorize") || value.endsWith("/mail/attachment/status"))
        return Response.json({ authorized: !options.rejectGuard });
      if (value.endsWith("/mail/complete")) completed.push(body);
      return Response.json({ accepted: true });
    });
    bridge = createBridge(chrome, fetch);
    try {
      await discover(10);
      await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalledOnce());
      await discover(11);
      await vi.waitFor(() => expect(completed).toHaveLength(1));
      if (options.twice) {
        await new Promise(resolve => setTimeout(resolve, 30));
        leased = false;
        await discover(10);
        await vi.waitFor(() => expect(completed).toHaveLength(2));
      }
      if (desktop) {
        expect(completed[0].responseStatus).toBe(200);
        expect(await desktopResult).toMatchObject({ attachmentDownload: { metadataId: "report.pdf", bytes: 1234 } });
      }
      return { completed, chrome, fetch, commands };
    } finally {
      await desktop?.stop();
      await desktopResult;
    }
  }
  it("authorizes exactly once, attests the owned ID and prevents replay", async () => {
    const h = await worker({ replay: true });
    expect(h.completed[0]).toMatchObject({ code: "complete", registration: conversation,
      capture: { attachmentDownload: { metadataId: "report.pdf", name: "report.pdf", relativePath, bytes: 1234 } } });
    expect(h.fetch.mock.calls.filter(([value]) => value.endsWith("/mail/attachment/authorize"))).toHaveLength(1);
    const authorization = h.fetch.mock.calls.find(([value]) => value.endsWith("/mail/attachment/authorize"))!;
    expect(Object.keys(JSON.parse(String(authorization[1].body))).sort()).toEqual(
      ["documentId", "lease", "protocol", "registration", "requestId", "tabId"]);
    expect(h.chrome.downloads.download).toHaveBeenCalledOnce();
  });
  it("round-trips the real authenticated HTTP bridge with native proof, authorization and owned download attestation", async () => {
    const h = await worker({ realBridge: true, replay: true });
    expect(h.completed[0]).toMatchObject({ responseStatus: 200, code: "complete",
      capture: { attachmentDownload: { metadataId: "report.pdf", bytes: 1234 } } });
    expect(h.chrome.downloads.download).toHaveBeenCalledOnce();
  });
  it.each(["document", "source-tab", "name", "message", "metadata", "size", "external", "account"])("rejects wrong %s before desktop authorization or Chrome", async mismatch => {
    const h = await worker({ mismatch });
    expect(["unavailable", "unsupported", "interrupted"]).toContain(h.completed[0].code);
    expect(h.completed[0].capture).toBeUndefined();
    expect(h.chrome.downloads.download).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.filter(([value]) => value.endsWith("/mail/attachment/authorize"))).toHaveLength(0);
  });
  it("does not download after fresh desktop policy denial", async () => {
    const h = await worker({ rejectGuard: true });
    expect(h.completed[0].code).toBe("interrupted");
    expect(h.chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("never forwards a stale capture attached to a failed download result", async () => {
    const h = await worker({ mismatch: "name", failedCapture: true });
    expect(h.completed[0].code).not.toBe("complete");
    expect(h.completed[0].capture).toBeUndefined();
    expect(h.chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("uses the fresh desktop guard and actual-byte limits for explicitly approved unknown-size jobs", async () => {
    const accepted = await worker({ approvedUnknown: true });
    expect(accepted.completed[0]).toMatchObject({ code: "complete", capture: { attachmentDownload: { bytes: 1234 } } });
    expect(accepted.chrome.downloads.download).toHaveBeenCalledOnce();
    const revoked = await worker({ approvedUnknown: true, rejectGuard: true });
    expect(revoked.completed[0].code).toBe("interrupted");
    expect(revoked.chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("reuses a stable reader for sequential attachment jobs without opening or closing any files/tabs", async () => {
    const h = await worker({ twice: true });
    expect(h.completed.map(result => result.code)).toEqual(["complete", "complete"]);
    expect(h.chrome.tabs.create).toHaveBeenCalledOnce();
    expect(h.chrome.downloads.download).toHaveBeenCalledTimes(2);
    expect(h.chrome.downloads.open).not.toHaveBeenCalled();
    expect(h.chrome.downloads.acceptDanger).not.toHaveBeenCalled();
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled();
  });
});

describe.skipIf(!existsSync(chromium.executablePath()) && process.env.RELAY_EXTENSION_TEST_EDGE !== "1")("isolated native attachment DOM", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) }); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); });
  const tile = (name = "report.pdf", link = url, size = "1.5 KB") =>
    `<div class="aQH"><span class="aZo" data-download-url="application/pdf:${name}:${link}">
      <span class="aV3">${name}</span><span class="SaH2Ve">${size}</span></span></div>`;
  async function load(attachment = tile(), body = "<p>Full body</p>", id = "18def") {
    page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body></body></html>" }));
    await page.goto("https://mail.google.com/mail/u/2/#all/18abc");
    await page.setContent(`<header id="gb"><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@example.org)">Account</a></header>
      <main role="main"><h2 class="hP">Fixture</h2><div data-legacy-message-id="${id}" data-legacy-thread-id="18abc">
      <span class="gD" email="sender@example.org">Sender</span><div class="ii"><div class="a3s">${body}</div></div>${attachment}</div></main>`);
    await page.addScriptTag({ path: resolve(directory, "extractors.js") });
  }
  const selected = () => page.evaluate(request => {
    try {
      const result = (globalThis as any).RelayExtractors.mailAttachment(document, location.href, request);
      return { metadata: result.metadata, url: result.url };
    } catch (error) { return { error: (error as Error).message }; }
  }, input);
  it("binds a visible native tile to the exact full message and preserves its displayed size", async () => {
    await load();
    expect(await selected()).toEqual({ metadata: { id: "report.pdf", name: "report.pdf",
      mimeType: "application/octet-stream", size: 1500 }, url });
  });
  it("reads a native wrapper's download URL and size outside its nested preview anchor", async () => {
    await load(`<div class="aQH"><span class="aZo" data-download-url="application/pdf:report.pdf:${url}">
      <a class="aQy" href="https://mail.google.com/mail/u/2/#attachment-preview"><span class="aV3">report.pdf</span></a>
      <span class="SaH2Ve">1,5 Ko</span></span></div>`);
    expect(await selected()).toEqual({ metadata: { id: "report.pdf", name: "report.pdf",
      mimeType: "application/octet-stream", size: 1500 }, url });
  });
  it("captures native metadata even without a supported download link, preserving unknown size", async () => {
    await load(`<div class="aQH"><span class="aZo"><a class="aQy"><span class="aV3">report.pdf</span></a></span></div>`);
    const captured = await page.evaluate(request => (globalThis as any).RelayExtractors.mail(document, location.href, request), input);
    expect(captured.messages[0].attachments).toEqual([{ id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream" }]);
    expect(await selected()).toHaveProperty("error", "attachment-size-limit");
  });
  it("permits an unknown displayed size only for an explicit backend-approved unknown-size job", async () => {
    await load(tile("report.pdf", url, ""));
    expect(await selected()).toHaveProperty("error", "attachment-size-limit");
    const selectedWithApproval = await page.evaluate(request => {
      const result = (globalThis as any).RelayExtractors.mailAttachment(document, location.href, request);
      return { metadata: result.metadata, url: result.url };
    }, { ...input, attachment: { ...input.attachment, approved: true } });
    expect(selectedWithApproval).toEqual({ metadata: { id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream" }, url });
  });
  it("keeps a displayed zero-byte size known rather than requiring unknown-size approval", async () => {
    await load(tile("report.pdf", url, "0 B"));
    expect(await selected()).toEqual({ metadata: { id: "report.pdf", name: "report.pdf",
      mimeType: "application/octet-stream", size: 0 }, url });
  });
  it("refreshes attachment metadata when native tiles arrive after the initial full message", async () => {
    await load("");
    const read = () => page.evaluate(request => (globalThis as any).RelayExtractors.mail(document, location.href, request), input);
    expect((await read()).messages[0]).toMatchObject({ attachments: [], attachmentManifestVersion: 1 });
    await page.evaluate(html => { document.querySelector("[data-legacy-message-id]")!.insertAdjacentHTML("beforeend", html); }, tile());
    expect((await read()).messages[0]).toMatchObject({ attachmentManifestVersion: 1,
      attachments: [{ id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream", size: 1500 }] });
  });
  it.each([
    `<div class="aQH"><span class="aZo"><span class="aV3"></span>Unreadable filename</span></div>`,
    `<div class="aQH" aria-busy="true">${tile()}</div>`,
    `<div class="aQH"><div role="progressbar">Loading attachments</div></div>`,
    `<div class="aQH"><span class="unknown-native-widget">Unrecognized attachment tile</span></div>`,
  ])("never versions an incomplete or unsupported native attachment manifest", async html => {
    await load(html);
    const captured = await page.evaluate(request => (globalThis as any).RelayExtractors.mail(document, location.href, request), input);
    expect(captured.messages[0].attachmentManifestVersion).toBeUndefined();
    expect(captured.messages[0].attachments).toBeUndefined();
    expect(captured.coverage).toContain("metadata was not captured");
    expect(await selected()).toHaveProperty("error", "attachment-unavailable");
  });
  it("preserves both duplicate metadata entries, but refuses ambiguous name-based downloads", async () => {
    await load(tile() + tile());
    const captured = await page.evaluate(request => (globalThis as any).RelayExtractors.mail(document, location.href, request), input);
    expect(captured.messages[0].attachments).toHaveLength(2);
    expect(new Set(captured.messages[0].attachments.map((attachment: any) => attachment.id)).size).toBe(2);
    expect(await selected()).toHaveProperty("error", "attachment-unavailable");
  });
  it.each(["body", "external", "duplicate", "wrong-message", "unknown-size", "large-size", "wrong-name"])("rejects %s rather than silently binding another file", async variant => {
    await load(variant === "body" ? "" : variant === "external" ? tile("report.pdf", "https://evil.invalid/file") :
      variant === "duplicate" ? tile() + tile() : variant === "unknown-size" ? tile("report.pdf", url, "") :
      variant === "large-size" ? tile("report.pdf", url, "10 MB") : variant === "wrong-name" ? tile("other.pdf") : tile(),
    variant === "body" ? `<p>Full body</p>${tile()}` : "<p>Full body</p>", variant === "wrong-message" ? "other" : "18def");
    expect(await selected()).toHaveProperty("error", ["unknown-size", "large-size"].includes(variant) ?
      "attachment-size-limit" : "attachment-unavailable");
  });
  it("rechecks native node and URL after one-shot authorization before starting a download", async () => {
    await load();
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
    const result = await page.evaluate(async request => {
      const calls: string[] = [];
      const value = await (globalThis as any).RelayMailRead.execute({ input: request, expiresAt: Date.now() + 5000 }, {
        attachmentCommand: async (type: string) => {
          calls.push(type);
          document.querySelector(".aZo")!.setAttribute("data-download-url", "application/pdf:report.pdf:https://mail.google.com/changed");
          return { authorized: true };
        },
      });
      return { calls, value };
    }, input);
    expect(result.calls).toEqual(["mail-attachment-authorize"]);
    expect(result.value.code).toBe("attachment-interrupted");
    expect(result.value.capture).toBeUndefined();
  });
  it("returns file attestation only after a successful native authorize/download exchange", async () => {
    await load();
    await page.addScriptTag({ path: resolve(directory, "mail-read.js") });
    const result = await page.evaluate(async ({ request, relativePath }) => {
      const calls: any[] = [];
      const value = await (globalThis as any).RelayMailRead.execute({ input: request, expiresAt: Date.now() + 5000 }, {
        attachmentCommand: async (type: string, payload: any) => {
          calls.push({ type, payload });
          return type === "mail-attachment-authorize" ? { authorized: true } :
            { metadataId: "report.pdf", name: "report.pdf", relativePath, bytes: 1234 };
        },
      });
      return { calls, value };
    }, { request: input, relativePath });
    expect(result.calls.map(call => call.type)).toEqual(["mail-attachment-authorize", "mail-attachment-download"]);
    expect(result.calls[0].payload).toMatchObject({ messageProviderId: "18def", metadataId: "report.pdf", name: "report.pdf", size: 1500, url });
    expect(result.value).toMatchObject({ code: "complete", capture: {
      attachmentDownload: { metadataId: "report.pdf", name: "report.pdf", relativePath, bytes: 1234 },
      messages: [{ attachmentManifestVersion: 1,
        attachments: [{ id: "report.pdf", name: "report.pdf", mimeType: "application/octet-stream", size: 1500 }] }],
    } });
  });
});
