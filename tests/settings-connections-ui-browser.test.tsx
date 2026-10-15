import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

declare global { interface Window { settingsUiTest: { commands: Command[] } } }

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("settings connections", () => {
  let browser: Browser, server: ViteDevServer, origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0, watch: null } });
    await server.listen(); origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("groups one mailbox's methods with the relay as primary and removes a method only after confirmation", async () => {
    const state: Snapshot = {
      accounts: [
        { id: "gmail:me@example.com", provider: "gmail", connection: "relay", name: "Me", email: "me@example.com", status: "connected", consent: true, aiEnabled: true },
        { id: "browser:me", provider: "gmail", connection: "browser", name: "Me (browser)", email: "Me@Example.com", status: "connected", consent: true, aiEnabled: true },
      ],
      sources: [{ id: "inbox", accountId: "browser:me", providerId: "inbox", name: "Inbox", kind: "mail", selected: true }],
      gmailRelays: [{ sourceId: "relay-src", accountId: "gmail:me@example.com", mailbox: "me@example.com", cursor: 4, imported: 4, latestSeq: 4, pollIntervalMinutes: 5, configured: true, stopped: false }],
      messages: [], attachments: [], drafts: [], events: [], actions: [], jobs: [], approvals: [],
      settings: { ...defaultSettings, model: "" }, models: [], copilot: { status: "disconnected", message: "" }, demo: false,
      archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, chat: { busy: false, conversations: [] },
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.addInitScript((state: Snapshot) => {
      const commands: Command[] = [];
      window.settingsUiTest = { commands };
      window.relay = { snapshot: async () => structuredClone(state), onChange: () => () => {}, command: async command => { commands.push(command); return {}; } };
    }, state);
    const commands = () => page.evaluate(() => window.settingsUiTest.commands);
    try {
      await page.goto(origin);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const mailboxCards = page.locator(".mailbox-card");
      await browserExpect(mailboxCards).toHaveCount(1);
      const card = page.getByRole("article", { name: "Mailbox me@example.com" });
      await browserExpect(card).toContainText("Full messages");
      const rows = card.locator(".connection-row");
      await browserExpect(rows).toHaveCount(2);
      await browserExpect(rows.first()).toContainText("Apps Script relay");
      await browserExpect(rows.first()).toContainText("primary");

      await card.getByRole("button", { name: "Remove Browser companion for me@example.com", exact: true }).click();
      const confirm = card.getByRole("group", { name: "Confirm removing Browser companion for me@example.com" });
      await browserExpect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await browserExpect(confirm).toHaveCount(0);
      expect(await commands()).toEqual([]);

      await card.getByRole("button", { name: "Remove Apps Script relay for me@example.com", exact: true }).click();
      const relayConfirm = card.getByRole("group", { name: "Confirm removing Apps Script relay for me@example.com" });
      await relayConfirm.getByRole("checkbox").check();
      await relayConfirm.getByRole("button", { name: "Remove", exact: true }).click();
      await browserExpect.poll(commands).toEqual([{ type: "gmailRelay.remove", sourceId: "relay-src", forget: true }]);

      await page.getByRole("tab", { name: "Copilot & assistant", exact: true }).click();
      await browserExpect(page.getByRole("combobox", { name: "Shell commands", exact: true })).toBeVisible();
      await browserExpect(mailboxCards).toHaveCount(0);
    } finally { await page.close(); }
  }, 60_000);
});
