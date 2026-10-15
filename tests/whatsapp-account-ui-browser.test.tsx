import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

interface WhatsAppHarness { state: Snapshot; commands: Command[]; changed(): void }
declare global { interface Window { whatsappUiTest: WhatsAppHarness } }

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("WhatsApp local account consent", () => {
  let browser: Browser, server: ViteDevServer, origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0, watch: null } });
    await server.listen(); origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("requires local opt-in, explicit chat selection, and separate optional AI consent; replies remain local", async () => {
    const state: Snapshot = {
      accounts: [{ id: "wa", provider: "whatsapp", connection: "browser", name: "Personal WhatsApp", email: "+22997000000", status: "connected", consent: false, aiEnabled: false }],
      sources: [
        { id: "project", accountId: "wa", providerId: "22997000001@c.us", name: "Project chat", kind: "channel", selected: false },
        { id: "private", accountId: "wa", providerId: "22997000002@c.us", name: "Private chat", kind: "channel", selected: false },
      ],
      messages: [], attachments: [], drafts: [], events: [], actions: [], jobs: [], approvals: [],
      settings: { ...defaultSettings, model: "" }, models: [], copilot: { status: "disconnected", message: "" }, demo: false,
      archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, chat: { busy: false, conversations: [] },
    };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript((state: Snapshot) => {
      let listeners: (() => void)[] = [];
      const harness: WhatsAppHarness = { state, commands: [], changed: () => listeners.forEach(listener => listener()) };
      window.whatsappUiTest = harness;
      window.relay = {
        snapshot: async () => structuredClone(state),
        onChange: listener => { listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener); }; },
        command: async command => {
          harness.commands.push(command);
          if (command.type === "account.consent") {
            state.accounts[0].consent = command.enabled;
            if (!command.enabled) state.accounts[0].aiEnabled = false;
          }
          if (command.type === "account.ai") {
            if (!state.accounts[0].consent) throw new Error("Local access required");
            state.accounts[0].aiEnabled = command.enabled;
          }
          if (command.type === "source.select") state.sources.find(source => source.id === command.sourceId)!.selected = command.selected;
          return {};
        },
      };
    }, state);
    try {
      await page.goto(origin);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const local = page.getByRole("switch", { name: "Allow local capture for Personal WhatsApp", exact: true });
      const ai = page.getByRole("switch", { name: "Allow Copilot for Personal WhatsApp", exact: true });
      const project = page.getByRole("checkbox", { name: /Project chat/ });
      const privateChat = page.getByRole("checkbox", { name: /Private chat/ });
      const account = page.locator(".account-card").filter({ has: local });
      await browserExpect(account).toHaveAttribute("aria-label", "Mailbox +22997000000");
      await browserExpect(account).toContainText("WhatsApp Web");
      await browserExpect(account).toContainText("Browser companion");
      await browserExpect(account.locator(".provider-icon .lucide-message-square")).toHaveCount(1);
      await browserExpect(account).toContainText("Retain the loaded text of chats you select");
      await browserExpect(local).not.toBeChecked();
      await browserExpect(ai).toBeDisabled();
      await browserExpect(project).toBeDisabled();
      await page.evaluate(() => window.whatsappUiTest.changed());
      expect(await page.evaluate(() => window.whatsappUiTest.commands)).toEqual([]);

      await local.click();
      await browserExpect(local).toBeChecked();
      await browserExpect(ai).not.toBeChecked();
      await browserExpect(project).toBeEnabled();
      await browserExpect(project).not.toBeChecked();
      await browserExpect(privateChat).not.toBeChecked();
      expect(await page.evaluate(() => window.whatsappUiTest.commands)).toEqual([{ type: "account.consent", accountId: "wa", enabled: true }]);
      await project.check();
      await browserExpect(project).toBeChecked();
      await browserExpect(privateChat).not.toBeChecked();
      expect(await page.evaluate(() => window.whatsappUiTest.state.accounts[0].aiEnabled)).toBe(false);
      await account.getByRole("button", { name: "Open browser to capture", exact: true }).click();
      expect(await page.evaluate(() => window.whatsappUiTest.commands.find(command => command.type === "browser.open"))).toEqual({ type: "browser.open", kind: "whatsapp", accountId: "wa" });
      await ai.click();
      await browserExpect(ai).toBeChecked();
      expect(await page.evaluate(() => window.whatsappUiTest.commands.filter(command => command.type === "account.ai"))).toEqual([{ type: "account.ai", accountId: "wa", enabled: true }]);

      await page.evaluate(() => {
        const { state } = window.whatsappUiTest;
        state.messages = [{ id: "message", accountId: "wa", sourceId: "project", providerId: "chat-message", threadId: "22997000001@c.us", subject: "Project chat update", sender: "Teammate", recipients: ["+22997000000"], body: "Review the plan.", receivedAt: "2026-09-23T08:00:00Z", url: "", unread: false, revision: "1", historical: false }];
        state.drafts = [{ id: "draft", accountId: "wa", messageId: "message", body: "Reviewed local reply", subject: "Project chat update", recipients: ["Teammate"], updatedAt: "2026-09-23T08:00:00Z", sourceRevision: "1", status: "local", citations: [] }];
        window.whatsappUiTest.changed();
      });
      await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
      await page.getByRole("button", { name: /Teammate.*Project chat update/ }).click();
      await browserExpect(page.getByText("WhatsApp replies stay local.", { exact: false })).toBeVisible();
      await browserExpect(page.getByRole("button", { name: /Save draft to|Save & open in|Outlook/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Copy reply", exact: true }).click();
      expect(await page.evaluate(() => window.whatsappUiTest.commands.find(command => command.type === "clipboard.copy"))).toEqual({ type: "clipboard.copy", text: "Reviewed local reply" });
      expect(await page.evaluate(() => window.whatsappUiTest.commands.some(command => command.type === "draft.save" || command.type === "draft.handoff"))).toBe(false);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await local.click();
      await browserExpect(local).not.toBeChecked();
      await browserExpect(ai).not.toBeChecked();
      await browserExpect(ai).toBeDisabled();
      await browserExpect(project).toBeChecked();
      await browserExpect(project).toBeDisabled();
      await browserExpect(privateChat).not.toBeChecked();
      await local.click();
      await browserExpect(local).toBeChecked();
      await browserExpect(ai).not.toBeChecked();
      expect(await page.evaluate(() => window.whatsappUiTest.commands.filter(command => command.type === "source.select"))).toEqual([{ type: "source.select", sourceId: "project", selected: true }]);
    } finally { await page.close(); }
  });
});
