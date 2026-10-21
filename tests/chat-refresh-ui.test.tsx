import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { Chat } from "../src/renderer/Chat";
import type { Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

interface RefreshHarness { state: Snapshot; commands: Command[]; changed(): void; failNext: boolean }
declare global { interface Window { chatRefreshTest: RefreshHarness } }

function snapshot(): Snapshot {
  return {
    accounts: [{ id: "mail-account", name: "Mail", email: "mail@example.org", provider: "gmail", connection: "browser", consent: true, aiEnabled: true, status: "connected" }],
    sources: [{ id: "inbox", accountId: "mail-account", providerId: "INBOX", name: "Inbox", kind: "mail", selected: true }],
    messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
    settings: { ...defaultSettings, model: "model-one", chatAskMailRefresh: true },
    models: [{ id: "model-one", name: "Available one" }, { id: "model-two", name: "Available two" }],
    copilot: { status: "ready", message: "Synthetic isolated connection" },
    archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false,
    chat: { conversations: [], busy: false },
  };
}

describe("optional mail refresh provenance", () => {
  it.each([false, true])("shows local-only provenance without a failed-refresh warning (legacy freshness: %s)", legacyFreshness => {
    const data = snapshot();
    data.chat!.conversations = [{
      id: "chat", title: "Saved messages", updatedAt: "2026-09-29T08:00:00Z",
      turns: [{
        id: "answer", role: "assistant", text: "Saved evidence.", createdAt: "2026-09-29T08:00:00Z", status: "complete", citations: [], actions: [], mailRefresh: "local",
        mailFreshness: legacyFreshness ? [{ status: "unavailable", checkedAt: "2026-09-29T08:00:00Z", sources: [], limitation: "No refresh attempted" }] : undefined,
      }],
    }];
    const html = renderToStaticMarkup(<Chat data={data} run={vi.fn()} navigate={vi.fn()}/>);
    expect(html).toContain("Using saved messages");
    expect(html).toContain("No download requested for this answer");
    expect(html).not.toContain("Inbox refresh incomplete");
    expect(html).not.toContain("Inbox refreshed before this answer");
  });

  it("hides the saved-messages note when the pre-question prompt is off (default)", () => {
    const data = snapshot();
    data.settings = { ...data.settings, chatAskMailRefresh: false };
    expect(defaultSettings.chatAskMailRefresh).toBe(false);
    data.chat!.conversations = [{ id: "chat", title: "Saved", updatedAt: "2026-09-29T08:00:00Z",
      turns: [{ id: "answer", role: "assistant", text: "Saved evidence.", createdAt: "2026-09-29T08:00:00Z", status: "complete", citations: [], actions: [], mailRefresh: "local" }] }];
    const html = renderToStaticMarkup(<Chat data={data} run={vi.fn()} navigate={vi.fn()}/>);
    expect(html).toContain("Saved evidence.");
    expect(html).not.toContain("No download requested for this answer");
  });
});

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("optional mail refresh interactions", () => {
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

  async function openPage(state = snapshot()): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript((state: Snapshot) => {
      let listeners: (() => void)[] = [];
      const harness: RefreshHarness = { state, commands: [], changed: () => listeners.forEach(listener => listener()), failNext: false };
      window.chatRefreshTest = harness;
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
              conversation.turns.push(
                { id: `user-${conversation.turns.length}`, role: "user", text: command.text, createdAt: new Date().toISOString(), status: "complete", citations: [], actions: [] },
                { id: `assistant-${conversation.turns.length}`, role: "assistant", text: "Synthetic answer.", mailRefresh: command.mailRefresh, createdAt: new Date().toISOString(), status: "complete", citations: [], actions: [] },
              );
            }
            harness.changed();
            return { conversationId: conversation.id };
          }
          return {};
        },
      };
    }, state);
    await page.goto(origin);
    await browserExpect(page.getByRole("textbox", { name: "Message Copilot" })).toBeVisible();
    return page;
  }
  const prompt = (page: Page) => page.getByRole("group", { name: "Do you want to download latest messages before I answer?" });
  const sends = (page: Page) => page.evaluate(() => window.chatRefreshTest.commands.filter(command => command.type === "chat.send"));

  it.each([
    ["No, use saved messages", "local"],
    ["Yes, download latest", "download"],
  ] as const)("waits for %s, sends once with the captured model, and asks again next turn", async (button, mailRefresh) => {
    const page = await openPage();
    try {
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await input.fill("Summarize my latest messages");
      await page.getByRole("combobox", { name: "Chat model", exact: true }).selectOption("model-two");
      await input.press("Enter");
      await browserExpect(prompt(page)).toBeVisible();
      expect(await page.evaluate(() => window.chatRefreshTest.commands)).toEqual([]);
      await browserExpect(page.getByRole("button", { name: "No, use saved messages", exact: true })).toBeFocused();
      await browserExpect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: button, exact: true }).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
      await browserExpect(input).toHaveValue("");
      expect(await sends(page)).toEqual([{ type: "chat.send", text: "Summarize my latest messages", model: "model-two", mailRefresh }]);
      await browserExpect(prompt(page)).toHaveCount(0);
      if (mailRefresh === "local") await browserExpect(page.getByRole("log")).toContainText("No download requested");
      await input.fill("What else needs attention?");
      await input.press("Enter");
      await browserExpect(prompt(page)).toBeVisible();
      expect(await sends(page)).toHaveLength(1);
    } finally { await page.close(); }
  });

  it("sends immediately using saved messages when the prompt setting is off", async () => {
    const state = snapshot();
    state.settings = { ...state.settings, chatAskMailRefresh: false };
    const page = await openPage(state);
    try {
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await input.fill("Summarize my latest messages");
      await input.press("Enter");
      await browserExpect(page.getByRole("log")).toContainText("Synthetic answer.");
      await browserExpect(prompt(page)).toHaveCount(0);
      expect(await sends(page)).toEqual([{ type: "chat.send", text: "Summarize my latest messages", model: "model-one", mailRefresh: "local" }]);
    } finally { await page.close(); }
  });

  it.each(["Do not refresh; summarize my mail.", "Use saved messages to find follow-ups.", "No need to download my latest mail."])("honors explicit local-only language without a prompt: %s", async text => {
    const page = await openPage();
    try {
      await page.getByRole("textbox", { name: "Message Copilot" }).fill(text);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await browserExpect(page.getByRole("log")).toContainText("Synthetic answer.");
      await browserExpect(prompt(page)).toHaveCount(0);
      expect(await sends(page)).toEqual([{ type: "chat.send", text, model: "model-one", mailRefresh: "local" }]);
    } finally { await page.close(); }
  });

  it.each(["calendar-only", "unselected", "no-consent", "ai-disabled", "disconnected"] as const)("does not offer a download for %s sources", async condition => {
    const state = snapshot();
    if (condition === "calendar-only") state.sources[0].kind = "calendar";
    if (condition === "unselected") state.sources[0].selected = false;
    if (condition === "no-consent") state.accounts[0].consent = false;
    if (condition === "ai-disabled") state.accounts[0].aiEnabled = false;
    if (condition === "disconnected") state.accounts[0].status = "disconnected";
    const page = await openPage(state);
    try {
      await page.getByRole("textbox", { name: "Message Copilot" }).fill("Summarize my day");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await browserExpect(page.getByRole("log")).toContainText("Synthetic answer.");
      await browserExpect(prompt(page)).toHaveCount(0);
      expect(await sends(page)).toMatchObject([{ mailRefresh: "local" }]);
    } finally { await page.close(); }
  });

  it("cancels without sending, retains the draft, and supports Escape and editing", async () => {
    const page = await openPage();
    try {
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await input.fill("Keep this question");
      await input.press("Enter");
      await page.getByRole("button", { name: "Back to editing", exact: true }).click();
      await browserExpect(prompt(page)).toHaveCount(0);
      await browserExpect(input).toBeFocused();
      await browserExpect(input).toHaveValue("Keep this question");
      await input.press("Enter");
      await page.getByRole("button", { name: "No, use saved messages", exact: true }).press("Escape");
      await browserExpect(prompt(page)).toHaveCount(0);
      await input.press("Enter");
      await input.fill("Changed question");
      await browserExpect(prompt(page)).toHaveCount(0);
      expect(await sends(page)).toEqual([]);
      await input.press("Enter");
      await page.getByRole("button", { name: "No, use saved messages", exact: true }).click();
      expect(await sends(page)).toMatchObject([{ text: "Changed question", mailRefresh: "local" }]);
    } finally { await page.close(); }
  });

  it("invalidates choices when model, conversation, or source consent changes", async () => {
    const page = await openPage();
    try {
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await input.fill("Second conversation question");
      await input.press("Enter");
      await page.getByRole("combobox", { name: "Chat model", exact: true }).selectOption("model-two");
      await browserExpect(prompt(page)).toHaveCount(0);
      await input.press("Enter");
      await page.getByRole("button", { name: "Conversation 1", exact: true }).click();
      await browserExpect(prompt(page)).toHaveCount(0);
      await browserExpect(input).toHaveValue("");
      await page.getByRole("button", { name: "Conversation 2", exact: true }).click();
      await browserExpect(input).toHaveValue("Second conversation question");
      await input.press("Enter");
      await page.evaluate(() => { window.chatRefreshTest.state.accounts[0].consent = false; window.chatRefreshTest.changed(); });
      await browserExpect(prompt(page)).toHaveCount(0);
      expect(await sends(page)).toEqual([]);
      await input.press("Enter");
      await browserExpect(input).toHaveValue("");
      expect(await sends(page)).toMatchObject([{ conversationId: "chat-2", text: "Second conversation question", model: "model-two", mailRefresh: "local" }]);
    } finally { await page.close(); }
  });

  it("preserves the question after a failed submission and requests a fresh choice on retry", async () => {
    const page = await openPage();
    try {
      const input = page.getByRole("textbox", { name: "Message Copilot" });
      await input.fill("Do not lose this question");
      await input.press("Enter");
      await page.evaluate(() => { window.chatRefreshTest.failNext = true; });
      await page.getByRole("button", { name: "Yes, download latest", exact: true }).click();
      await browserExpect(page.getByText("Your message was not accepted.", { exact: false })).toBeVisible();
      await browserExpect(input).toHaveValue("Do not lose this question");
      await input.press("Enter");
      await browserExpect(prompt(page)).toBeVisible();
      await page.getByRole("button", { name: "No, use saved messages", exact: true }).click();
      await browserExpect(input).toHaveValue("");
      expect((await sends(page)).map(command => command.mailRefresh)).toEqual(["download", "local"]);
    } finally { await page.close(); }
  });

  it("keeps the confirmation choices and composer usable at a narrow viewport", async () => {
    const page = await openPage();
    try {
      await page.setViewportSize({ width: 640, height: 720 });
      await page.getByRole("textbox", { name: "Message Copilot" }).fill("Summarize my inbox");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await browserExpect(prompt(page)).toBeInViewport();
      for (const name of ["Yes, download latest", "No, use saved messages", "Back to editing"]) {
        await browserExpect(page.getByRole("button", { name, exact: true })).toBeInViewport();
      }
      await browserExpect(page.getByRole("textbox", { name: "Message Copilot" })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.close(); }
  });
});
