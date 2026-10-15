import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { BrowserBridge } from "../src/main/browser/bridge";
import type { BrowserCalendarMove } from "../src/shared/browser-calendar";

const root = resolve(import.meta.dirname, "..");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const token = "a".repeat(64), otherToken = "b".repeat(64);
const require = createRequire(import.meta.url);
const registration = { accountEmail: "owner@example.org", accountName: "Owner",
  kind: "calendar" as const, pageUrl: "https://calendar.google.com/calendar/u/0/r/agenda" };
function move(): BrowserCalendarMove {
  return { accountId: "account", accountEmail: registration.accountEmail, itemId: "archived",
    providerId: "exact-provider-id", expectedTitle: "Tech team discussion", expectedWhenText: "September 23, 10am to 11am",
    newDate: "2026-09-23", startTime: "15:00", endTime: "16:00", timeZone: "Europe/Paris",
    notificationPolicy: "provider-default", expiresAt: new Date(Date.now() + 60_000).toISOString(), proofRevision: "revision-1" };
}
const bridges: BrowserBridge[] = [];
async function setup() {
  const values = new Map<string, unknown>();
  const vault = {
    get<T>(_collection: "secrets", id: string) { return values.get(id) as T | undefined; },
    put<T>(_collection: "secrets", id: string, value: T) { values.set(id, value); },
    delete(_collection: "secrets", id: string) { values.delete(id); }
  };
  vault.put("secrets", "browser-bridge-token", { extensionId, tokens: [token, otherToken] });
  const onDiscover = vi.fn(async () => ({ accountId: "account", enabled: true }));
  const bridge = new BrowserBridge(vault, { extensionId, port: 0, onDiscover,
    onCapture: async () => undefined, changed: () => undefined });
  bridges.push(bridge);
  await bridge.start();
  const binding = { protocol: 1, registration, tabId: 7, documentId: "document-one" };
  const send = (path: string, body: unknown, auth = token) => fetch(`http://127.0.0.1:${bridge.status().port}/calendar/${path}`, {
    method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body)
  });
  const lease = async () => {
    const response = await send("poll", binding);
    expect(response.status).toBe(200);
    const { job } = await response.json();
    return { ...binding, requestId: job.requestId, lease: job.lease };
  };
  return { bridge, binding, send, lease, onDiscover };
}
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); });

describe("reviewed calendar bridge leases", () => {
  it("advertises fresh protocol readiness without queuing or authorizing any move", async () => {
    const h = await setup();
    expect(h.bridge.status().clients?.every(client => !client.calendarActions)).toBe(true);
    expect((await h.send("poll", { ...h.binding, protocol: 2 })).status).toBe(400);
    expect(h.bridge.status().clients?.every(client => !client.calendarActions)).toBe(true);
    expect(await (await h.send("poll", h.binding)).json()).toEqual({ job: null });
    const capability = h.bridge.status().clients?.find(client => client.calendarActions)?.calendarActions;
    expect(capability).toEqual({ protocol: 1, lastSeenAt: expect.any(String), ready: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(capability!.lastSeenAt) + 30_001);
    try {
      expect(h.bridge.status().clients?.find(client => client.calendarActions)?.calendarActions?.ready).toBe(false);
    } finally { clock.mockRestore(); }
    await h.bridge.stop();
    await h.bridge.start();
    expect(h.bridge.status().clients?.every(client => !client.calendarActions)).toBe(true);
    expect(await (await h.send("poll", h.binding)).json()).toEqual({ job: null });
    await h.bridge.revoke();
    expect(h.bridge.status().clients).toBeUndefined();
  });
  it("binds one lease to client, tab, document and request; authorizes once and verifies completion", async () => {
    const h = await setup(), check = vi.fn();
    const result = h.bridge.moveCalendarEvent(move(), check);
    const lease = await h.lease();
    expect(await (await h.send("poll", h.binding, otherToken)).json()).toEqual({ job: null });
    for (const body of [{ ...lease, tabId: 8 }, { ...lease, documentId: "new-doc" }, { ...lease, requestId: "c".repeat(32) }])
      expect((await h.send("authorize", body)).status).toBe(403);
    expect((await h.send("authorize", lease, otherToken)).status).toBe(403);
    expect((await h.send("complete", { ...lease, code: "saved" })).status).toBe(403);
    const grant = await (await h.send("authorize", lease)).json();
    expect(grant).toMatchObject({ authorized: true, requestId: lease.requestId });
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 1500);
    expect((await h.send("authorize", lease)).status).toBe(409);
    expect((await h.send("complete", { ...lease, code: "saved", message: "<private data>" })).status).toBe(400);
    expect((await h.send("complete", { ...lease, code: "saved" })).status).toBe(200);
    expect(await result).toMatchObject({ status: "saved", code: "saved", requestId: lease.requestId });
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((await h.send("complete", { ...lease, code: "saved" })).status).toBe(409);
  });
  it("does not lease to a different account and bounds the active queue", async () => {
    const h = await setup();
    const result = h.bridge.moveCalendarEvent(move(), () => undefined);
    expect(await h.bridge.moveCalendarEvent(move(), () => undefined)).toMatchObject({ code: "busy" });
    expect(await (await h.send("poll", { ...h.binding, registration: { ...registration, accountEmail: "other@example.org" } })).json())
      .toEqual({ job: null });
    const lease = await h.lease();
    await h.send("complete", { ...lease, code: "event-not-found" });
    expect(await result).toMatchObject({ status: "needs-user", code: "event-not-found" });
  });
  it("rechecks reviewed permissions immediately before save and handles revocation", async () => {
    const h = await setup();
    let allowed = true;
    const result = h.bridge.moveCalendarEvent(move(), () => { if (!allowed) throw new Error("private callback detail"); });
    const lease = await h.lease();
    allowed = false;
    const denied = await h.send("authorize", lease);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private");
    expect(await result).toMatchObject({ status: "needs-user", code: "authorization-denied" });
    const next = h.bridge.moveCalendarEvent(move(), () => undefined);
    await h.lease();
    await h.bridge.revoke();
    expect(await next).toMatchObject({ code: "authorization-denied" });
  });
  it("reports uncertain on shutdown after authorization and never replays the action", async () => {
    const h = await setup();
    const result = h.bridge.moveCalendarEvent(move(), () => undefined);
    const lease = await h.lease();
    await h.send("authorize", lease);
    await h.bridge.stop();
    expect(await result).toMatchObject({ status: "uncertain", code: "save-unverified" });
    await h.bridge.start();
    expect(await (await h.send("poll", h.binding)).json()).toEqual({ job: null });
  });
  it("expires without dispatch and rejects invalid dates, intervals and time zones", async () => {
    const h = await setup();
    expect(await h.bridge.moveCalendarEvent({ ...move(), expiresAt: new Date(Date.now() + 100).toISOString() }, () => undefined))
      .toMatchObject({ status: "needs-user", code: "expired" });
    for (const patch of [{ newDate: "2026-02-30" }, { timeZone: "CET" }, { endTime: "14:00" }])
      await expect(h.bridge.moveCalendarEvent({ ...move(), ...patch }, () => undefined)).rejects.toThrow();
  });
  it("leases to only one client under concurrent polls, and rechecks source selection", async () => {
    const h = await setup();
    expect(await (await h.send("poll", h.binding)).json()).toEqual({ job: null });
    const result = h.bridge.moveCalendarEvent(move(), () => undefined);
    const responses = await Promise.all([h.send("poll", h.binding), h.send("poll", h.binding, otherToken)]);
    const jobs = await Promise.all(responses.map(response => response.json()));
    expect(jobs.filter(value => value.job)).toHaveLength(1);
    const index = jobs.findIndex(value => value.job);
    h.onDiscover.mockResolvedValue({ accountId: "account", enabled: false });
    expect((await h.send("authorize", { ...h.binding, requestId: jobs[index].job.requestId, lease: jobs[index].job.lease },
      index === 0 ? token : otherToken)).status).toBe(403);
    expect(await result).toMatchObject({ code: "authorization-denied" });
  });
});

describe("Calendar worker document binding", () => {
  it("keeps tokens out of content messages and restricts authorization to the leased document", async () => {
    const sender = { id: extensionId, url: registration.pageUrl, frameId: 0, documentId: "doc-one",
      tab: { id: 7, url: registration.pageUrl } };
    const chrome = {
      runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}` },
      storage: { local: {
        setAccessLevel: async () => undefined, get: async () => ({ token }),
        remove: async () => undefined, set: async () => undefined
      } },
      tabs: { get: vi.fn(async () => sender.tab) }
    };
    const job = { protocol: 1, requestId: "c".repeat(32), lease: "d".repeat(64), move: move() };
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/discover") ? { accountId: "account", enabled: true }
      : url.endsWith("/poll") ? { job } : url.endsWith("/authorize")
        ? { authorized: true, requestId: job.requestId, expiresAt: Date.now() + 1500 } : { accepted: true }));
    const worker = require(resolve(root, "browser-extension", "background.js")).createBridge(chrome, fetcher);
    const poll = { type: "calendar-poll", payload: { registration } };
    await expect(worker.handle(poll, sender)).rejects.toThrow("Discover");
    await worker.handle({ type: "discover", payload: registration }, sender);
    const response = await worker.handle(poll, sender);
    expect(response).toEqual({ job });
    expect(JSON.stringify(response)).not.toContain(token);
    const payload = { registration, requestId: job.requestId, lease: job.lease };
    await expect(worker.handle({ type: "calendar-authorize", payload }, { ...sender, frameId: 1 })).rejects.toThrow("top-level");
    await expect(worker.handle({ type: "calendar-authorize", payload }, { ...sender, documentId: "reloaded" })).rejects.toThrow("stale");
    await expect(worker.handle({ type: "calendar-complete", payload: { ...payload, code: "saved" } }, sender)).rejects.toThrow("Invalid");
    expect(await worker.handle({ type: "calendar-authorize", payload }, sender)).toMatchObject({ authorized: true });
    await expect(worker.handle({ type: "calendar-authorize", payload }, sender)).rejects.toThrow("consumed");
    expect(await worker.handle({ type: "calendar-complete", payload: { ...payload, code: "saved" } }, sender)).toEqual({ accepted: true });
    await expect(worker.handle({ type: "calendar-complete", payload: { ...payload, code: "saved" } }, sender)).rejects.toThrow("stale");
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/authorize"))).toHaveLength(1);
  });
});

describe("deterministic Calendar DOM moves", () => {
  let context: BrowserContext;
  let page: Page;
  const profile = resolve(root, ".calendar-actions-test-profile");
  beforeAll(async () => {
    await mkdir(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    });
  }, 30_000);
  afterAll(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
  afterEach(async () => { await page?.close(); });
  async function fixture(options: Record<string, unknown> = {}) {
    page = await context.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang='en-US'><body></body></html>" }));
    await page.goto(registration.pageUrl);
    await page.evaluate(({ options, registration, move }) => {
      const window = globalThis as any;
      const french = options.french === true;
      document.documentElement.lang = french ? "fr-FR" : "en-US";
      document.body.innerHTML = `<header id="gb" role="banner"><a href="https://accounts.google.com/SignOutOptions"
        aria-label="Google Account: Owner (${options.wrongAccount ? "other@example.org" : registration.accountEmail})">Account</a></header>
        <main role="main"></main>`;
      window.savedCount = 0; window.authorizationCount = 0;
      window.record = { title: move.expectedTitle, date: options.observedFormats ? "23 Sept 2026" : french ? "23/09/2026" : "09/23/2026",
        start: options.observedFormats ? "10:00am" : "10:00", end: options.observedFormats ? "11:00am" : "11:00",
        zone: move.timeZone, description: "Keep description", location: "Original room", attendees: ["guest@example.org"] };
      const main = document.querySelector("main")!;
      function renderChip() {
        document.getElementById("xSaveBu")?.remove();
        main.innerHTML = `<button data-eventid="${options.wrongId ? "different-id" : move.providerId}"
          aria-label="${options.stale ? "Changed time" : move.expectedWhenText}"><span ${options.rawChipTitle ? "" : "data-event-title"}>${move.expectedTitle}</span></button>`;
        main.querySelector("button")!.onclick = () => {
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.innerHTML = `<h2>${move.expectedTitle}</h2><button aria-label="${french ? "Modifier l'événement" : "Edit event"}">Edit</button>`;
          dialog.querySelector("button")!.onclick = () => { dialog.remove(); renderEditor(); };
          document.body.append(dialog);
        };
      }
      function renderEditor() {
        const r = window.record;
        main.innerHTML = `<input aria-label="${french ? "Titre" : "Title"}" value="${r.title}">
          <input aria-label="${french ? "Date de début" : "Start date"}" value="${r.date}">
          <input aria-label="${french ? "Date de fin" : "End date"}" value="${r.date}">
          <input aria-label="${french ? "Heure de début" : "Start time"}" value="${r.start}">
          <input aria-label="${french ? "Heure de fin" : "End time"}" value="${r.end}">
          <input type="checkbox" aria-label="${french ? "Toute la journée" : "All day"}" ${options.allDay ? "checked" : ""}>
          <button>${options.recurring ? "Weekly" : french ? "Ne se répète pas" : "Does not repeat"}</button>
          ${options.noZone ? "" : `<select aria-label="Event start time zone"><option value="${r.zone}">${r.zone}</option></select>
          <select aria-label="Event end time zone"><option value="${options.wrongEndZone ? "America/New_York" : r.zone}">${r.zone}</option></select>`}
          <div contenteditable="true"><button aria-label="Save">Forged description button</button>${r.description}</div>
          <button id="save">${french ? "Enregistrer" : "Save"}</button>`;
        const save = main.querySelector<HTMLButtonElement>("#save")!;
        if (options.displayZonesOnly || options.lagosZones) {
          for (const [index, zone] of [...main.querySelectorAll("select")].entries()) {
            const label = index === 0 || options.lagosZones ? "Lagos, Nigeria West Africa Time - Lagos (GMT+01:00)"
              : "Nairobi, Kenya East Africa Time (GMT+03:00)";
            zone.innerHTML = `<option selected value="${label}">${label}</option><option value="${r.zone}">${r.zone}</option>`;
          }
        }
        if (options.nativeIds) {
          const fields = main.querySelectorAll("input");
          fields[0].id = "xTiIn";
          fields[0].setAttribute("aria-label", "Contextual title");
          for (const [index, id] of ["xStDaIn", "xEnDaIn", "xStTiIn", "xEnTiIn"].entries()) {
            fields[index + 1].id = id;
            fields[index + 1].setAttribute("aria-label", "Contextual date or time field");
          }
          const repeat = main.querySelector("button")!;
          const group = document.createElement("div");
          group.setAttribute("role", "group");
          group.textContent = repeat.textContent;
          repeat.replaceWith(group);
          save.id = "xSaveBu";
          document.querySelector("header")!.append(save);
        }
        if (options.zonePicker) {
          const zones = [...main.querySelectorAll("select")];
          const markup = zones.map(zone => zone.outerHTML).join("");
          zones.forEach(zone => zone.remove());
          const opener = document.createElement("button");
          opener.textContent = "Time zone";
          opener.onclick = () => {
            const dialog = document.createElement("div");
            dialog.setAttribute("role", "dialog");
            dialog.innerHTML = `${markup}<button>Cancel</button><button>OK</button>`;
            dialog.querySelector("button")!.onclick = () => dialog.remove();
            document.body.append(dialog);
          };
          main.append(opener);
        }
        save.onclick = () => {
          window.savedCount++;
          if (options.notification) {
            const dialog = document.createElement("div");
            dialog.setAttribute("role", "dialog");
            dialog.innerHTML = "<h2>Send invitation emails?</h2><button>Send</button>";
            document.body.append(dialog); return;
          }
          const inputs = main.querySelectorAll<HTMLInputElement>("input");
          r.date = options.badReadback ? "09/24/2026" : inputs[1].value;
          r.start = inputs[3].value; r.end = inputs[4].value;
          renderChip();
          const toast = document.createElement("div");
          toast.setAttribute("role", "status");
          toast.textContent = french ? "Événement enregistré" : "Event saved";
          document.body.append(toast);
        };
      }
      renderChip();
      if (options.busy) {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.textContent = "Existing unsaved form";
        document.body.append(dialog);
      }
      if (options.unsupported) {
        main.querySelector("button")!.onclick = () => {
          main.innerHTML = "<input aria-label='Title' value='Tech team discussion'><button>Save</button>";
        };
      }
    }, { options, registration, move: move() });
    await page.addScriptTag({ path: resolve(root, "browser-extension", "extractors.js") });
    await page.addScriptTag({ path: resolve(root, "browser-extension", "calendar-actions.js") });
  }
  async function execute(authorized = true, patch: Partial<BrowserCalendarMove> = {}) {
    return page.evaluate(async ({ move, authorized }) => {
      const window = globalThis as any;
      const job = { protocol: 1, requestId: "c".repeat(32), lease: "d".repeat(64), move };
      return window.RelayCalendarActions.execute(job, {
        document, extractors: window.RelayExtractors,
        authorize: async () => {
          window.authorizationCount++;
          return { authorized, requestId: job.requestId, expiresAt: Date.now() + 1500 };
        }
      });
    }, { move: { ...move(), ...patch }, authorized });
  }
  it.each([false, true])("saves English/French controls with authoritative readback (French=%s)", async french => {
    await fixture({ french });
    expect(await execute()).toEqual({ code: "saved" });
    expect(await page.evaluate(() => ({ saves: (globalThis as any).savedCount, record: (globalThis as any).record })))
      .toMatchObject({ saves: 1, record: { start: "15:00", end: "16:00", zone: "Europe/Paris",
        description: "Keep description", location: "Original room", attendees: ["guest@example.org"] } });
  });
  it("uses the live-observed native date/time IDs and header Save button", async () => {
    await fixture({ nativeIds: true });
    expect(await execute()).toEqual({ code: "saved" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(1);
  });
  it("binds the raw chip label while validating the cleaned title in the actual editor", async () => {
    await fixture({ rawChipTitle: true, nativeIds: true });
    expect(await execute()).toEqual({ code: "saved" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(1);
  });
  it("preserves the live-observed English day-month date and 12-hour time formats", async () => {
    await fixture({ nativeIds: true, observedFormats: true });
    expect(await execute(true, { newDate: "2026-09-24" })).toEqual({ code: "saved" });
    expect(await page.evaluate(() => (globalThis as any).record))
      .toMatchObject({ date: "24 Sept 2026", start: "3:00pm", end: "4:00pm" });
  });
  it("verifies both selected, geographically explicit Lagos zone labels for an Africa/Lagos review", async () => {
    await fixture({ nativeIds: true, observedFormats: true, lagosZones: true, zonePicker: true });
    expect(await execute(true, { timeZone: "Africa/Lagos" })).toEqual({ code: "saved" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(1);
  });
  it("rejects an actually selected Nairobi end zone for an Africa/Lagos review", async () => {
    await fixture({ displayZonesOnly: true });
    expect(await execute(true, { timeZone: "Africa/Lagos" })).toEqual({ code: "time-zone-unverified" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(0);
  });
  it.each([
    [{ wrongAccount: true }, "account-mismatch"], [{ wrongId: true }, "event-not-found"],
    [{ stale: true }, "event-changed"], [{ recurring: true }, "recurring-event"],
    [{ noZone: true }, "time-zone-unverified"], [{ wrongEndZone: true }, "time-zone-unverified"],
    [{ displayZonesOnly: true }, "time-zone-unverified"], [{ allDay: true }, "unsupported-editor"], [{ busy: true }, "busy"]
  ] as const)("does not save unsupported or stale event %j", async (options, code) => {
    await fixture(options);
    expect(await execute()).toEqual({ code });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(0);
  });
  it("requires host authorization even after staging fields", async () => {
    await fixture();
    expect(await execute(false)).toEqual({ code: "authorization-denied" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(0);
  });
  it("does not save unsupported editor markup", async () => {
    await fixture({ unsupported: true });
    expect(await execute()).toEqual({ code: "unsupported-editor" });
    expect(await page.evaluate(() => (globalThis as any).savedCount)).toBe(0);
  });
  it("leaves notification choices to the user and never claims success", async () => {
    await fixture({ notification: true });
    expect(await execute()).toEqual({ code: "notification-confirmation" });
    expect(await page.locator("[role='dialog']").textContent()).toContain("Send invitation emails");
  });
  it("requires persisted date readback, not merely a saved toast", async () => {
    await fixture({ badReadback: true });
    expect(await execute()).toEqual({ code: "save-unverified" });
  });
});
