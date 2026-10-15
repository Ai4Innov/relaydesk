import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

// Opt-in uses an already installed browser; this suite never downloads a runtime.
describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("renderer browser interactions", () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("keeps writes explicit, preserves edits, clears credentials, and handles all screens", async () => {
    const timestamp = "2026-09-22T08:00:00Z";
    const snapshot: Snapshot = {
      accounts: [{ id: "a", provider: "gmail", name: "Design team", email: "test@example.com", status: "connected", aiEnabled: true, consent: true }],
      sources: [{ id: "s", accountId: "a", providerId: "inbox", name: "Inbox", kind: "mail", selected: true }, { id: "cal", accountId: "a", providerId: "primary", name: "Work calendar", kind: "calendar", selected: true }],
      messages: [{ id: "msg", accountId: "a", sourceId: "s", providerId: "remote", threadId: "thread", subject: "Launch review", sender: "alex@example.com", recipients: ["test@example.com"], body: "Please review the launch. <img src=x onerror=alert(1)>", receivedAt: timestamp, url: "", unread: true, revision: "1", historical: false }],
      drafts: [{ id: "d", accountId: "a", messageId: "msg", body: "Initial draft", subject: "Re: Launch review", recipients: ["alex@example.com"], updatedAt: timestamp, sourceRevision: "1", status: "local", citations: [], model: "available-model" }],
      attachments: [],
      events: [{ id: "e", accountId: "a", sourceId: "cal", providerId: "remote-event", title: "Design review", start: "2099-10-02T08:00:00Z", end: "2099-10-02T09:00:00Z", timeZone: "Europe/Paris", allDay: false, attendees: [], location: "Studio", description: "Review the launch", revision: "v1", url: "", writable: true }],
      actions: [{ id: "act", messageId: "msg", accountId: "a", title: "Review the launch", reason: "The team requested review.", priority: "important", status: "open", confidence: 0.8, citations: [] }],
      jobs: [{ id: "failed-google-connect", kind: "sync", label: "Connect gmail", status: "failed", progress: 0,
        detail: "OAuth exchange failed (400). Check the Google desktop client secret.", createdAt: timestamp, updatedAt: timestamp }],
      approvals: [], settings: { ...defaultSettings, model: "available-model" },
      models: [{ id: "available-model", name: "Available runtime model" }], copilot: { status: "ready", message: "Ready" },
      archive: { messages: 1, attachments: 0, indexed: 1, searchMode: "keyword", bytes: 100 }, demo: false,
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((state: Snapshot) => {
      const commands: Command[] = [];
      let listeners: (() => void)[] = [];
      Object.assign(window, { uiTest: { state, commands, changed: () => listeners.forEach((listener) => listener()) } });
      window.relay = {
        snapshot: async () => structuredClone(state),
        onChange(listener) { listeners.push(listener); return () => { listeners = listeners.filter((item) => item !== listener); }; },
        command: async (command) => {
          commands.push(command);
          if (command.type === "draft.edit") { Object.assign(state.drafts[0], { body: command.body, subject: command.subject, recipients: command.recipients }); return {}; }
          if (command.type === "browser.pair") return { browserPairing: { code: "11223344", port: 43891, expiresAt: new Date(Date.now() + 120000).toISOString() } };
          if (command.type === "calendar.propose") {
            state.approvals.push({ id: "approval", kind: "calendar", change: command.change, hash: "a".repeat(64), createdAt: new Date().toISOString(), status: "pending", effect: "Provider may invite attendees." });
            return { approvalId: "approval" };
          }
          if (command.type === "calendar.approve") { state.approvals[0].status = "done"; return { message: "Calendar updated" }; }
          if (command.type === "search") return { citations: [{ id: "cite", messageId: "msg", title: "Launch review", excerpt: "Source evidence" }] };
          return { message: "Test command complete" };
        },
      };
    }, snapshot);
    try {
      await page.goto(origin);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await page.getByRole("heading", { name: "A clearer view of your day." }).waitFor();
      await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
      await page.getByRole("button", { name: /alex@example.com.*Launch review/ }).click();
      await browserExpect(page.locator(".plain-body").first()).toContainText("<img src=x onerror=alert(1)>");
      await browserExpect(page.locator(".thread img")).toHaveCount(0);
      await page.getByLabel("Reply draft", { exact: true }).fill("My careful edits");
      await page.evaluate(() => {
        const test = (window as unknown as { uiTest: { state: Snapshot; changed(): void } }).uiTest;
        test.state.drafts[0].body = "Background changed";
        test.changed();
      });
      await browserExpect(page.getByLabel("Reply draft", { exact: true })).toHaveValue("My careful edits");
      await page.getByRole("button", { name: "Save draft to Gmail", exact: true }).click();
      await browserExpect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { commands: Command[] } }).uiTest.commands.filter((c) => c.type.startsWith("draft.")).map((c) => c.type))).toEqual(["draft.edit", "draft.save"]);
      await page.getByRole("button", { name: "Archive & ask", exact: true }).click();
      await page.getByLabel("Search query or question").fill("launch");
      await page.getByRole("button", { name: "Search locally", exact: true }).click();
      await page.getByText("Source evidence", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Calendar", exact: true }).click();
      await page.getByRole("button", { name: "Propose a change", exact: true }).click();
      await page.getByLabel("Event title", { exact: true }).fill("Revised launch review");
      await page.getByRole("button", { name: "Preview exact changes", exact: true }).click();
      await page.getByRole("button", { name: "Approve this exact change", exact: true }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: Command[] } }).uiTest.commands.some((c) => c.type === "calendar.approve"))).toBe(false);
      await page.getByRole("button", { name: "Approve this exact change", exact: true }).click();
      await page.getByText("Calendar updated", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await page.getByRole("heading", { name: "Activity & approvals" }).waitFor();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await browserExpect(page.getByRole("tab", { name: "Connections", exact: true })).toHaveAttribute("aria-selected", "true");
      await page.getByText("Browser companion (Chrome / Edge)", { exact: true }).click();
      await browserExpect(page.getByRole("heading", { name: "Connect your browser", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("button", { name: "Generate pairing code", exact: true })).toBeDisabled();
      await page.getByLabel(/I authorize local capture/).check();
      await page.getByRole("button", { name: "Generate pairing code", exact: true }).click();
      await browserExpect(page.getByText("11223344", { exact: true })).toBeVisible();
      await page.locator("summary", { hasText: "Provider API" }).click();
      await browserExpect(page.getByRole("alert", { name: "Account connection status" })).toContainText("Check the Google desktop client secret");
      await page.getByRole("tab", { name: "Data & app", exact: true }).click();
      await browserExpect(page.getByText(/Download and cache sizes are not checked in advance/)).toBeVisible();
      await browserExpect(page.getByText(/This is separate from account-level consent/)).toBeVisible();
      await browserExpect(page.getByRole("switch", { name: "Local semantic search", exact: true })).not.toBeChecked();
      await page.getByRole("tab", { name: "Connections", exact: true }).click();
      if (!await page.getByLabel("API provider", { exact: true }).isVisible()) await page.locator("summary", { hasText: "Provider API" }).click();
      await page.getByLabel("API provider", { exact: true }).selectOption("slack");
      await browserExpect(page.getByRole("alert", { name: "Account connection status" })).toHaveCount(0);
      await page.getByLabel("Authorized Slack user token").fill("synthetic-test-not-real");
      await page.locator("details.add-method", { has: page.locator("summary", { hasText: "Provider API" }) }).getByLabel(/I am authorized to import/).check();
      await page.getByRole("button", { name: "Connect Slack", exact: true }).click();
      await browserExpect(page.getByLabel("Authorized Slack user token")).toHaveValue("");
      await page.setViewportSize({ width: 640, height: 900 });
      await browserExpect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
