import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

interface Harness { state: Snapshot; commands: Command[]; changed(): void; failNext: boolean; holdConfirmation?: boolean }
declare global { interface Window { chatUiTest: Harness } }

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("isolated chat interactions", () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0, watch: null } });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  async function openPage(): Promise<Page> {
    const state: Snapshot = {
      accounts: [], sources: [], messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
      settings: { ...defaultSettings, model: "model-one" },
      models: [{ id: "model-one", name: "Available one" }, { id: "model-two", name: "Available two" }],
      copilot: { status: "ready", message: "Synthetic isolated connection" },
      archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false,
      chat: { conversations: [], busy: false },
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript((state: Snapshot) => {
      let listeners: (() => void)[] = [];
      const harness: Harness = { state, commands: [], changed: () => listeners.forEach(listener => listener()), failNext: false };
      window.chatUiTest = harness;
      window.relay = {
        snapshot: async () => structuredClone(state),
        onChange(listener) { listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener); }; },
        command: async command => {
          harness.commands.push(command);
          if (harness.failNext) { harness.failNext = false; throw new Error("Synthetic failure"); }
          const chat = state.chat!;
          if (command.type === "chat.new" || command.type === "chat.send") {
            let conversation = command.type === "chat.send" ? chat.conversations.find(item => item.id === command.conversationId) : undefined;
            if (!conversation) {
              conversation = { id: `chat-${chat.conversations.length + 1}`, title: `Conversation ${chat.conversations.length + 1}`, updatedAt: new Date().toISOString(), turns: [] };
              chat.conversations.push(conversation);
            }
            chat.activeConversationId = conversation.id;
            if (command.type === "chat.send") {
              chat.busy = true;
              conversation.turns.push(
                { id: `user-${conversation.turns.length}`, role: "user", text: command.text, model: command.model, createdAt: new Date().toISOString(), status: "complete", citations: [], actions: [] },
                { id: `assistant-${conversation.turns.length}`, role: "assistant", text: "", createdAt: new Date().toISOString(), status: "working", progress: "Checking authorized sources", citations: [], actions: [] },
              );
            }
            harness.changed();
            return { conversationId: conversation.id };
          }
          if (command.type === "chat.cancel") {
            chat.busy = false;
            chat.conversations.forEach(conversation => conversation.turns.forEach(turn => { if (turn.status === "working") turn.status = "cancelled"; }));
          }
          if (command.type === "chat.delete") chat.conversations = chat.conversations.filter(item => item.id !== command.conversationId);
          if (command.type === "chat.confirm") {
            const action = chat.conversations.find(item => item.id === command.conversationId)?.turns.find(item => item.id === command.turnId)?.actions.find(item => item.id === command.actionId);
            if (action && !harness.holdConfirmation) { action.status = "completed"; action.result = "Local task created."; }
          }
          if (command.type === "account.ai") {
            const account = state.accounts.find(item => item.id === command.accountId);
            if (account) account.aiEnabled = command.enabled;
          }
          harness.changed();
          return {};
        },
      };
    }, state);
    await page.goto(origin);
    await browserExpect(page.getByRole("heading", { name: "What can we take off your mind?" })).toBeVisible();
    return page;
  }

  it("reconnects a previously selected subscription once without retry loops or changing its model", async () => {
    const page = await openPage();
    try {
      await page.evaluate(() => {
        window.chatUiTest.state.settings.model = "";
        window.chatUiTest.state.copilot.status = "disconnected";
        window.chatUiTest.changed();
      });
      await browserExpect(page.getByRole("button", { name: "Connect Copilot", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "copilot.connect").length)).toBe(0);
      await page.evaluate(() => {
        window.chatUiTest.state.settings.model = "model-two";
        window.chatUiTest.changed();
      });
      await browserExpect.poll(async () => page.evaluate(() =>
        window.chatUiTest.commands.filter(command => command.type === "copilot.connect").length)).toBe(1);
      await page.evaluate(() => window.chatUiTest.changed());
      await browserExpect(page.getByRole("button", { name: "Connect Copilot", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "copilot.connect").length)).toBe(1);
      expect(await page.evaluate(() => window.chatUiTest.state.settings.model)).toBe("model-two");
    } finally { await page.close(); }
  });

  it("sends with selected model, keeps drafts across snapshots and tools, supports cancellation and guarded deletion", async () => {
    const page = await openPage();
    try {
      await browserExpect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
      await page.getByRole("button", { name: /What needs my attention/ }).click();
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await browserExpect(input).toHaveValue(/authorized messages/);
      await input.fill("A considered question");
      await input.press("Shift+Enter");
      await browserExpect(input).toHaveValue("A considered question\n");
      await input.fill("A considered question");
      await page.getByLabel("Chat model", { exact: true }).selectOption("model-two");
      await input.press("Enter");
      await browserExpect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
      await browserExpect(page.getByRole("log")).toContainText("Checking authorized sources");
      const sent = await page.evaluate(() => window.chatUiTest.commands.find(command => command.type === "chat.send"));
      expect(sent).toMatchObject({ text: "A considered question", model: "model-two" });
      await input.fill("Keep this draft");
      await page.evaluate(() => window.chatUiTest.changed());
      await browserExpect(input).toHaveValue("Keep this draft");
      await page.getByRole("button", { name: "Stop response" }).click();
      await browserExpect(page.getByRole("log")).toContainText("Stopped.");
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "chat.send").length)).toBe(1);
      await browserExpect(input).toHaveValue("Keep this draft");
      await page.getByRole("button", { name: "Open Tasks", exact: true }).click();
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await browserExpect(input).toHaveValue("Keep this draft");
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await browserExpect(input).toHaveValue("");
      await page.getByRole("button", { name: "Conversation 1", exact: true }).click();
      await browserExpect(input).toHaveValue("Keep this draft");
      await page.evaluate(() => { window.chatUiTest.state.chat!.activeConversationId = "chat-2"; window.chatUiTest.changed(); });
      await browserExpect(page.getByRole("button", { name: "Conversation 1", exact: true })).toHaveAttribute("aria-current", "true");
      await page.getByRole("button", { name: "Delete conversation Conversation 1" }).click();
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "chat.delete").length)).toBe(0);
      await page.getByRole("button", { name: "Keep chat", exact: true }).click();
      await page.getByRole("button", { name: "Delete conversation Conversation 1" }).click();
      await page.getByRole("button", { name: "Delete chat", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Conversation 1", exact: true })).toHaveCount(0);
      await input.fill("Retain on failure");
      await page.evaluate(() => { window.chatUiTest.failNext = true; });
      await input.press("Enter");
      await browserExpect(input).toHaveValue("Retain on failure");
      await browserExpect(page.getByText("Your message was not accepted.", { exact: false })).toBeVisible();
      await page.setViewportSize({ width: 900, height: 720 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await browserExpect(input).toBeInViewport();
      await page.setViewportSize({ width: 640, height: 720 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await browserExpect(input).toBeInViewport();
    } finally { await page.close(); }
  });

  it("requires explicit preview confirmation, opens evidence, and does not scroll away from earlier messages", async () => {
    const page = await openPage();
    try {
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.evaluate(() => {
        const conversation = window.chatUiTest.state.chat!.conversations[0];
        conversation.turns = Array.from({ length: 18 }, (_, index) => ({
          id: `turn-${index}`, role: "assistant", text: `Response ${index}\n${"Synthetic text to create a scrollable conversation. ".repeat(10)}`,
          createdAt: "2026-09-23T08:00:00Z", status: "complete", citations: [], actions: [],
        }));
        conversation.turns[17].text = "<img src=x onerror=alert(1)>";
        conversation.turns[17].citations = [{ id: "citation", messageId: "synthetic-message", title: "Synthetic brief", excerpt: "Bounded source evidence" }];
        conversation.turns[17].actions = [{ id: "action", title: "Create local task", description: "A synthetic task", status: "pending", preview: "task.create\nTitle: <b>Review</b>" }];
        window.chatUiTest.changed();
      });
      const action = page.getByRole("region", { name: "Action: Create local task" });
      await browserExpect(action.locator("pre")).toHaveText("task.create\nTitle: <b>Review</b>");
      await browserExpect(page.locator(".chat-transcript img")).toHaveCount(0);
      expect(await page.evaluate(() => window.chatUiTest.commands.some(command => command.type === "chat.confirm"))).toBe(false);
      await action.getByRole("button", { name: "Confirm action", exact: true }).click();
      await browserExpect(action).toContainText("Local task created.");
      await browserExpect(action.getByRole("button", { name: "Confirm action" })).toHaveCount(0);
      await page.getByText("1 source · inspect evidence", { exact: true }).click();
      await page.getByRole("button", { name: /Synthetic brief.*Open original/ }).click();
      expect(await page.evaluate(() => window.chatUiTest.commands.find(command => command.type === "open.message"))).toEqual({ type: "open.message", messageId: "synthetic-message" });
      await page.locator(".chat-transcript").evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await page.evaluate(() => {
        window.chatUiTest.state.chat!.conversations[0].turns[17].text += "\nNew response content";
        window.chatUiTest.changed();
      });
      await browserExpect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
      expect(await page.locator(".chat-transcript").evaluate(element => element.scrollTop)).toBe(0);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      expect(await page.locator(".chat-transcript").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    } finally { await page.close(); }
  });

  it("renders safe rich answers, copies code deliberately, and confirms readable calendar cards only once", async () => {
    const page = await openPage();
    const remoteRequests: string[] = [];
    page.on("request", request => { if (request.url().includes("tracker.invalid")) remoteRequests.push(request.url()); });
    try {
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.evaluate(() => {
        const conversation = window.chatUiTest.state.chat!.conversations[0];
        window.chatUiTest.holdConfirmation = true;
        conversation.turns = [
          { id: "user-rich", role: "user", text: "**Keep my Markdown literal**", createdAt: "2026-09-23T08:00:00Z", status: "complete", citations: [], actions: [] },
          {
            id: "assistant-rich", role: "assistant", createdAt: "2026-09-23T08:00:00Z", status: "complete", citations: [],
            text: '# A calmer day\n\n**Important** and *flexible*.\n\n- Review\n- Plan\n\n> Leave a buffer.\n\n```ts\nconst safe = "<not HTML>";\n```\n\n| Time | Focus |\n| --- | --- |\n| 14:00 | Planning |\n\n[Reference](https://example.org/info) [Unsafe](javascript:alert%281%29)\n\n![Tracking](https://tracker.invalid/pixel)\n\n<img src="https://tracker.invalid/raw" onerror="alert(1)">\n\n<script>alert(1)</script>',
            actions: [{
              id: "move-calendar", title: "Move calendar event", description: "Review the time and account before confirming.", status: "pending",
              preview: JSON.stringify({
                command: { type: "browser.calendar.move", itemId: "captured-1", expectedRevision: "revision-1", newDate: "2026-09-24", startTime: "14:00", endTime: "15:00", timeZone: "Europe/Paris" },
                review: { title: "Planning session", accountEmail: "test@example.org", sourceId: "calendar-source", currentWhen: "23 September, 09:00–10:00", newDate: "2026-09-24", startTime: "14:00", endTime: "15:00", timeZone: "Europe/Paris", effect: "Guests may receive updates", extra: "Must remain visible" },
              }, null, 2),
            }],
          },
        ];
        window.chatUiTest.changed();
      });
      const rich = page.locator(".chat-rich-message");
      await browserExpect(rich.getByRole("heading", { name: "A calmer day" })).toBeVisible();
      await browserExpect(rich.locator("strong")).toHaveText("Important");
      await browserExpect(rich.locator("em")).toHaveText("flexible");
      await browserExpect(rich.locator("ul > li")).toHaveCount(2);
      await browserExpect(rich.getByRole("table")).toContainText("Planning");
      await browserExpect(rich.locator("img, a, script, iframe, svg:not(.lucide), style")).toHaveCount(0);
      await browserExpect(rich).toContainText("https://example.org/info");
      await browserExpect(page.locator(".chat-turn-user .chat-turn-text")).toHaveText("**Keep my Markdown literal**");
      await browserExpect(page.locator(".chat-turn-user strong")).toHaveCount(1);
      expect(remoteRequests).toEqual([]);
      expect(await page.evaluate(() => window.chatUiTest.commands.some(command => command.type === "clipboard.copy" || command.type === "chat.confirm"))).toBe(false);
      await rich.getByRole("button", { name: "Copy code" }).click();
      await browserExpect(rich.getByRole("status")).toHaveText("Copied");
      expect(await page.evaluate(() => window.chatUiTest.commands.find(command => command.type === "clipboard.copy"))).toEqual({ type: "clipboard.copy", text: 'const safe = "<not HTML>";\n' });

      const card = page.getByRole("region", { name: "Action: Move calendar event" });
      for (const value of ["Planning session", "test@example.org", "2026-09-24 · 14:00 · 15:00", "Europe/Paris", "Guests may receive updates", "Must remain visible"]) await browserExpect(card).toContainText(value);
      await browserExpect(card.locator("pre")).not.toBeVisible();
      await card.getByText("Exact action payload", { exact: true }).click();
      await browserExpect(card.locator("pre")).toContainText('"expectedRevision": "revision-1"');
      await card.getByText("Exact action payload", { exact: true }).click();
      const confirm = card.getByRole("button", { name: "Confirm action", exact: true });
      await confirm.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await browserExpect(confirm).toBeDisabled();
      await page.evaluate(() => window.chatUiTest.changed());
      await browserExpect(confirm).toBeDisabled();
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "chat.confirm").length)).toBe(1);
      await page.evaluate(() => {
        window.chatUiTest.state.chat!.conversations[0].turns[1].actions[0].status = "running";
        window.chatUiTest.changed();
      });
      await browserExpect(card.getByText("Action in progress…", { exact: true })).toHaveAttribute("role", "status");
      await page.evaluate(() => {
        const action = window.chatUiTest.state.chat!.conversations[0].turns[1].actions[0];
        action.status = "completed"; action.result = "Verified in the browser.";
        window.chatUiTest.changed();
      });
      await browserExpect(card).toContainText("Verified in the browser.");
      await browserExpect(card.getByRole("button", { name: "Confirm action" })).toHaveCount(0);
      await page.setViewportSize({ width: 640, height: 720 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await browserExpect(page.getByRole("textbox", { name: "Message Copilot" })).toBeInViewport();
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await card.evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001);
    } finally { await page.close(); }
  });

  it("discloses account-wide calendar AI access and never grants it before the explicit enable click", async () => {
    const page = await openPage();
    try {
      await page.evaluate(() => {
        window.chatUiTest.state.accounts = [
          { id: "calendar-gated", name: "Calendar account", email: "calendar@example.org", connection: "browser", provider: "gmail", status: "connected", consent: true, aiEnabled: false },
          { id: "other-account", name: "Other account", email: "other@example.org", connection: "browser", provider: "gmail", status: "connected", consent: true, aiEnabled: false },
        ];
        window.chatUiTest.state.sources = [
          { id: "calendar-source", accountId: "calendar-gated", providerId: "calendar", kind: "calendar", name: "Work calendar", selected: true },
          { id: "mail-source", accountId: "calendar-gated", providerId: "inbox", kind: "mail", name: "Inbox", selected: true },
          { id: "private-mail", accountId: "calendar-gated", providerId: "private", kind: "mail", name: "Private mail", selected: false },
          { id: "other-calendar", accountId: "other-account", providerId: "other", kind: "calendar", name: "Other calendar", selected: false },
        ];
        window.chatUiTest.changed();
      });
      const card = page.getByRole("region", { name: "Calendar access for calendar@example.org" });
      await browserExpect(card).toBeVisible();
      await browserExpect(card).toContainText("Local calendar is connected, but not shared with Copilot.");
      await browserExpect(page.getByRole("region", { name: "Calendar access for other@example.org" })).toHaveCount(0);
      await browserExpect(card.getByRole("button", { name: "Enable AI for this account" })).toHaveCount(0);
      await page.evaluate(() => window.chatUiTest.changed());
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "account.ai"))).toEqual([]);
      await card.getByRole("button", { name: "Review AI access" }).click();
      await browserExpect(card).toContainText("Enable AI sharing for this account’s selected sources (including mail) with Copilot");
      await browserExpect(card).toContainText("Work calendar (calendar) · Inbox (mail)");
      await browserExpect(card).not.toContainText("Private mail");
      await browserExpect(card).toContainText("Enabling access does not move any meeting");
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "account.ai"))).toEqual([]);
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
      await browserExpect(card.getByRole("button", { name: "Enable AI for this account" })).toHaveCount(0);
      await card.getByRole("button", { name: "Review AI access" }).click();
      await card.getByRole("button", { name: "Choose sources in Settings" }).click();
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "account.ai"))).toEqual([]);
      const originalSources = await page.evaluate(() => window.chatUiTest.state.sources);
      await card.getByRole("button", { name: "Enable AI for this account", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await browserExpect(card).toHaveCount(0);
      expect(await page.evaluate(() => window.chatUiTest.commands.filter(command => command.type === "account.ai"))).toEqual([{ type: "account.ai", accountId: "calendar-gated", enabled: true }]);
      expect(await page.evaluate(() => window.chatUiTest.state.sources)).toEqual(originalSources);
      expect(await page.evaluate(() => window.chatUiTest.state.accounts.map(account => ({ id: account.id, aiEnabled: account.aiEnabled, consent: account.consent })))).toEqual([
        { id: "calendar-gated", aiEnabled: true, consent: true }, { id: "other-account", aiEnabled: false, consent: true },
      ]);
      expect(await page.evaluate(() => window.chatUiTest.commands.some(command => command.type === "chat.send" || command.type === "browser.calendar.move"))).toBe(false);
    } finally { await page.close(); }
  });
});
