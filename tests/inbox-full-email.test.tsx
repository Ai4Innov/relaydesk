import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command, Draft, Message, MessageThread, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

interface InboxHarness {
  state: Snapshot;
  commands: Command[];
  pending: string[];
  completed: string[];
  results: Record<string, MessageThread>;
  opened: string[];
  changed(): void;
  settle(messageId: string, error?: string): void;
}
declare global { interface Window { inboxFullEmailTest: InboxHarness } }

const accountId = "browser:google:reader@example.org";
const sourceId = `${accountId}:mail`;
const capturedAt = "2026-09-23T08:00:00Z";
function preview(letter: string): Message {
  return {
    id: `preview-${letter}`, accountId, sourceId, providerId: `thread:thread-${letter}`,
    threadId: `${accountId}:thread:thread-${letter}`, subject: `Project ${letter.toUpperCase()} review`,
    sender: `author-${letter}@example.org`, recipients: ["reader@example.org"], body: `Snippet only for project ${letter.toUpperCase()}`,
    receivedAt: capturedAt, url: `https://mail.google.com/mail/?authuser=reader%40example.org#inbox/thread-${letter}`,
    unread: true, revision: "preview-1", historical: false,
    browser: { completeness: "preview", capturedAt, dateText: "Today", position: letter === "a" ? 0 : 1 },
  };
}
function thread(letter: string): MessageThread {
  const messages: Message[] = [1, 2].map(index => ({
    ...preview(letter), id: `full-${letter}-${index}`, providerId: `provider-${letter}-${index}`,
    sender: index === 1 ? `author-${letter}@example.org` : "reviewer@example.org",
    body: `Project ${letter.toUpperCase()} full message ${index}\nDetailed agenda and a complete explanation, absent from the preview.`,
    html: `<h2>Project ${letter.toUpperCase()} full message ${index}</h2><p>Detailed <strong>agenda</strong> and a complete explanation, absent from the preview.</p><table><tr><td>Decision</td><td>Approved</td></tr></table><img src="https://tracker.invalid/pixel"><script>window.parent.emailScriptRan = true</script>`,
    receivedAt: `2026-09-23T${String(index + 8).padStart(2, "0")}:00:00Z`, unread: false, revision: `full-${index}`,
    browser: { completeness: "full", capturedAt, dateText: "Today", position: index - 1 },
  }));
  return {
    accountId, sourceId, threadId: preview(letter).threadId, messages,
    attachments: [{
      id: `file-${letter}`, accountId, messageId: messages[1].id, providerId: `remote-file-${letter}`,
      name: `Project-${letter.toUpperCase()}.pdf`, mimeType: "application/pdf", size: 2048, status: "pending",
      browser: { source: "browser_gmail", metadataId: `remote-file-${letter}` },
      reason: "Queued for automatic attachment download and local indexing.",
    }],
    loadedAt: capturedAt, cached: false,
  };
}

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("isolated full-email inbox reader", () => {
  let browser: Browser, server: ViteDevServer, origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0, watch: null } });
    await server.listen(); origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  async function openPage(twoThreads = false) {
    const state: Snapshot = {
      accounts: [{ id: accountId, provider: "gmail", connection: "browser", email: "reader@example.org",
        name: "Reader", status: "connected", consent: true, aiEnabled: false }],
      sources: [{ id: sourceId, accountId, providerId: "mail", name: "Gmail inbox", kind: "mail", selected: true }],
      messages: twoThreads ? [preview("a"), preview("b")] : [preview("a")], attachments: [],
      drafts: [], events: [], actions: [], jobs: [], approvals: [],
      settings: { ...defaultSettings, model: "" }, models: [], copilot: { status: "disconnected", message: "" }, demo: false,
      archive: { messages: twoThreads ? 2 : 1, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 100 },
    };
    const results = { [preview("a").threadId]: thread("a"), [preview("b").threadId]: thread("b") };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const externalRequests: string[] = [];
    await page.route("**/*", async route => {
      const url = route.request().url();
      if (/^https?:/.test(url) && new URL(url).origin !== new URL(origin).origin) {
        externalRequests.push(url); await route.abort(); return;
      }
      await route.continue();
    });
    await page.addInitScript(({ state, results }) => {
      let listeners: (() => void)[] = [];
      const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
      const harness: InboxHarness = {
        state, results, commands: [], pending: [], completed: [], opened: [],
        changed: () => listeners.forEach(listener => listener()),
        settle: (id, error) => {
          const item = waiting.get(id);
          if (!item) throw new Error(`No pending read for ${id}`);
          waiting.delete(id);
          if (error) item.reject(new Error(error)); else item.resolve();
        },
      };
      window.inboxFullEmailTest = harness;
      window.open = url => { harness.opened.push(String(url)); return null; };
      window.relay = {
        snapshot: async () => structuredClone(harness.state),
        onChange: listener => { listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener); }; },
        command: async command => {
          harness.commands.push(command);
          if (command.type === "settings.update") {
            Object.assign(harness.state.settings, command.patch);
            harness.changed();
            return {};
          }
          if (command.type !== "message.load") return {};
          const message = harness.state.messages.find(item => item.id === command.messageId);
          if (!message) throw new Error("Unknown local message ID");
          harness.pending.push(command.messageId);
          try {
            await new Promise<void>((resolve, reject) => waiting.set(command.messageId, { resolve, reject }));
            const result = structuredClone(harness.results[message.threadId]);
            for (const full of result.messages) {
              const position = harness.state.messages.findIndex(item => item.id === full.id);
              if (position === -1) harness.state.messages.push(full); else harness.state.messages[position] = full;
            }
            for (const attachment of result.attachments) {
              const position = harness.state.attachments.findIndex(item => item.id === attachment.id);
              if (position === -1) harness.state.attachments.push(attachment); else harness.state.attachments[position] = attachment;
            }
            harness.changed();
            return { messageThread: result };
          } finally {
            harness.pending = harness.pending.filter(id => id !== command.messageId);
            harness.completed.push(command.messageId);
          }
        },
      };
    }, { state, results });
    await page.goto(origin);
    await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
    await browserExpect(page.locator(".message-row")).toHaveCount(twoThreads ? 2 : 1);
    return { page, externalRequests };
  }
  const reader = (page: Page) => page.getByRole("region", { name: "Conversation reader" });
  async function select(page: Page, letter = "a") {
    await page.locator(`.message-row[data-message-id="preview-${letter}"]`).click();
    await browserExpect.poll(() => page.evaluate(id => window.inboxFullEmailTest.pending.includes(id), `preview-${letter}`)).toBe(true);
  }
  async function settle(page: Page, letter = "a", error?: string) {
    await page.evaluate(({ id, error }) => window.inboxFullEmailTest.settle(id, error), { id: `preview-${letter}`, error });
  }
  async function expectFull(page: Page, letter = "a") {
    await browserExpect(reader(page).locator(".thread-message")).toHaveCount(2);
    await browserExpect(reader(page).locator('iframe[title="Formatted email"]')).toHaveCount(2);
    for (const index of [0, 1]) {
      await browserExpect(reader(page).frameLocator("iframe").nth(index).locator("body")).toContainText(`Project ${letter.toUpperCase()} full message ${index + 1}`);
    }
    await browserExpect(reader(page).getByRole("status")).toContainText("2 complete messages");
    await browserExpect(reader(page)).not.toContainText("Snippet only");
    await browserExpect(reader(page)).not.toContainText("Inbox preview - full message not loaded yet");
  }
  async function expectLocalOnly(page: Page, externalRequests: string[]) {
    const result = await page.evaluate(() => ({
      types: window.inboxFullEmailTest.commands.map(command => command.type),
      opened: window.inboxFullEmailTest.opened,
      aiEnabled: window.inboxFullEmailTest.state.accounts[0].aiEnabled,
      scriptRan: (window as Window & { emailScriptRan?: boolean }).emailScriptRan,
    }));
    expect(result.types.every(type => type === "message.load")).toBe(true);
    expect(result.opened).toEqual([]); expect(result.aiEnabled).toBe(false);
    expect(result.scriptRan).toBeUndefined(); expect(externalRequests).toEqual([]);
  }

  it("keeps mailbox-date ordering through capture refresh and full downloads, displaying the latest thread date on the selected anchor", async () => {
    const { page } = await openPage(true);
    try {
      await page.evaluate(() => {
        const harness = window.inboxFullEmailTest;
        harness.state.messages[0].receivedAt = "2026-09-20T08:00:00Z";
        harness.state.messages[0].browser!.capturedAt = "2026-10-01T10:00:00Z";
        harness.state.messages[1].receivedAt = "2026-09-23T12:00:00Z";
        harness.changed();
      });
      const rows = page.locator(".message-row");
      await browserExpect(rows.first()).toHaveAttribute("data-message-id", "preview-b");
      await select(page, "a");
      await settle(page, "a");
      await expectFull(page);
      await browserExpect(rows.first()).toHaveAttribute("data-message-id", "preview-b");
      await browserExpect(rows.nth(1)).toHaveAttribute("data-message-id", "preview-a");
      await browserExpect(rows.nth(1).locator("time")).toHaveAttribute("datetime", "2026-09-23T10:00:00Z");
      await page.evaluate(() => {
        const harness = window.inboxFullEmailTest;
        for (const message of harness.state.messages.filter(message => message.threadId.endsWith("thread-a")))
          message.browser!.capturedAt = "2026-10-02T10:00:00Z";
        harness.changed();
      });
      await browserExpect(rows.first()).toHaveAttribute("data-message-id", "preview-b");
    } finally { await page.close(); }
  });
  it("loads two complete formatted emails and an attachment locally, keeping the preview archived but one grouped conversation row", async () => {
    const { page, externalRequests } = await openPage();
    try {
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toEqual([]);
      await select(page);
      await browserExpect(reader(page).getByRole("status")).toContainText("Loading the complete conversation");
      await browserExpect(reader(page).getByRole("button", { name: "Reload full conversation" })).toBeDisabled();
      await browserExpect(reader(page).locator("iframe")).toHaveCount(0);
      await browserExpect(reader(page).locator(".draft-editor")).toHaveCount(0);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toEqual([{ type: "message.load", messageId: "preview-a" }]);
      await settle(page); await expectFull(page);
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-A.pdf", exact: true })).toBeVisible();
      await browserExpect(reader(page).getByRole("button", { name: "Generate a reply", exact: true })).toBeDisabled();
      await browserExpect(page.locator(".message-row")).toHaveCount(1);
      await browserExpect(page.locator(".message-row")).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.locator(".list-heading")).toContainText("1 recent conversations");
      const messages = await page.evaluate(() => window.inboxFullEmailTest.state.messages);
      expect(messages).toHaveLength(3); expect(messages.find(message => message.id === "preview-a")).toEqual(preview("a"));
      await browserExpect(reader(page).locator("iframe").first()).toHaveAttribute("sandbox", "");
      await browserExpect(reader(page).frameLocator("iframe").first().locator("table")).toContainText("Approved");
      await browserExpect(reader(page).frameLocator("iframe").first().locator("img, script")).toHaveCount(0);
      await reader(page).getByRole("button", { name: "Plain text", exact: true }).first().click();
      await browserExpect(reader(page).locator(".plain-body")).toContainText(thread("a").messages[0].body);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("shows a failed load honestly, retries explicitly with refresh, and can reload without creating duplicate messages or requests", async () => {
    const { page, externalRequests } = await openPage();
    try {
      await select(page); await settle(page, "a", "Error invoking remote method 'relay:command': Error: The paired Gmail tab is unavailable.");
      await browserExpect(page.getByText("The paired Gmail tab is unavailable.", { exact: true })).toBeVisible();
      await browserExpect(page.locator("body")).not.toContainText("Error invoking remote method");
      await browserExpect(reader(page).getByRole("alert")).toContainText("Full email could not be loaded");
      await browserExpect(reader(page)).toContainText("Snippet only for project A");
      await browserExpect(reader(page).locator("iframe")).toHaveCount(0);
      await reader(page).getByRole("button", { name: "Retry full email", exact: true }).click();
      await browserExpect(reader(page).getByRole("status")).toContainText("Loading the complete conversation");
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toEqual([
        { type: "message.load", messageId: "preview-a" }, { type: "message.load", messageId: "preview-a", refresh: true },
      ]);
      await settle(page); await expectFull(page);
      await browserExpect(page.getByText("The paired Gmail tab is unavailable.", { exact: true })).toHaveCount(0);
      await reader(page).getByRole("button", { name: "Reload full conversation", exact: true }).click();
      await browserExpect(reader(page).getByRole("button", { name: "Reload full conversation" })).toBeDisabled();
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.pending.length)).toBe(1);
      await settle(page); await expectFull(page);
      await browserExpect(page.locator(".message-row")).toHaveCount(1);
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.messages.length)).toBe(3);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toHaveLength(3);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("shows default full-email archive coverage and explicit retry/download controls", async () => {
    const { page } = await openPage();
    try {
      await page.evaluate(() => {
        window.inboxFullEmailTest.state.fullMailArchive = {
          enabled: true, running: false, queued: 2, complete: 3, failed: 1, total: 6,
          lastError: "One message could not be downloaded.",
        };
        window.inboxFullEmailTest.changed();
      });
      const archive = page.getByRole("region", { name: "Local full-email archive" });
      await browserExpect(archive.getByRole("checkbox", { name: "Automatically download full emails" })).toBeChecked();
      await browserExpect(archive.getByRole("status", { name: "Full-email archive status" })).toContainText("3 of 6 conversations downloaded");
      await browserExpect(archive.getByRole("progressbar")).toHaveAttribute("value", "3");
      await browserExpect(archive.getByRole("alert")).toContainText("could not be downloaded");
      await archive.getByRole("button", { name: "Download pending / retry failed" }).click();
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands.at(-1))).toEqual({ type: "message.downloadAll" });
      await archive.getByRole("checkbox", { name: "Automatically download full emails" }).uncheck();
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands.at(-1))).toEqual({
        type: "settings.update", patch: { browserFullMailDownload: false },
      });
      await page.evaluate(() => {
        window.inboxFullEmailTest.state.settings.syncPaused = true;
        window.inboxFullEmailTest.changed();
      });
      await browserExpect(archive.getByRole("button", { name: "Download pending / retry failed" })).toBeDisabled();
      await browserExpect(archive.getByRole("status", { name: "Full-email archive status" })).toContainText("Paused");
    } finally { await page.close(); }
  });

  it("offers file download without AI and controls attachment automation independently of full-email downloads", async () => {
    const { page, externalRequests } = await openPage();
    try {
      await select(page); await settle(page); await expectFull(page);
      const archive = page.getByRole("region", { name: "Local email attachment archive" });
      const automatic = archive.getByRole("checkbox", { name: "Automatically download and index Gmail attachments" });
      await browserExpect(automatic).toBeChecked();
      await browserExpect(archive.getByRole("status")).toContainText("0 of 1 files stored locally");
      await reader(page).getByRole("button", { name: "Download and index", exact: true }).click();
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands.at(-1))).toEqual({
        type: "attachment.download", attachmentId: "file-a", approved: false
      });
      await automatic.uncheck();
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands.at(-1))).toEqual({
        type: "settings.update", patch: { browserAttachmentDownload: false }
      });
      await browserExpect(page.getByRole("checkbox", { name: "Automatically download full emails", exact: true })).toBeChecked();
      await browserExpect(archive.getByRole("status")).toContainText("Paused");
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.accounts[0].aiEnabled)).toBe(false);
      expect(externalRequests).toEqual([]);
    } finally { await page.close(); }
  });

  it("does not restart an explicit read when its capture updates the selected message revision", async () => {
    const { page } = await openPage();
    try {
      await select(page);
      await page.evaluate(() => {
        const message = window.inboxFullEmailTest.state.messages.find(item => item.id === "preview-a")!;
        message.revision = "capture-updated";
        window.inboxFullEmailTest.changed();
      });
      await settle(page); await expectFull(page);
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.commands.length)).toBe(1);
      await reader(page).getByRole("button", { name: "Reload full conversation", exact: true }).click();
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.pending.length)).toBe(1);
      await page.evaluate(() => {
        window.inboxFullEmailTest.state.messages.find(item => item.id === "preview-a")!.revision = "capture-updated-again";
        window.inboxFullEmailTest.changed();
      });
      await settle(page); await expectFull(page);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands.length)).toBe(2);
    } finally { await page.close(); }
  });

  it("preserves an edited draft anchored to the preview after hydration and keeps its grouped row selected", async () => {
    const { page, externalRequests } = await openPage();
    const draft: Draft = {
      id: "reviewed-draft", accountId, messageId: "preview-a", status: "local",
      body: "My carefully edited reply.\nPlease preserve these reviewed details.",
      subject: "Reviewed: Project A next steps", recipients: ["reviewed-recipient@example.org"],
      updatedAt: capturedAt, sourceRevision: "preview-1", citations: [],
    };
    try {
      await page.evaluate(draft => { window.inboxFullEmailTest.state.drafts = [draft]; window.inboxFullEmailTest.changed(); }, draft);
      await select(page); await settle(page); await expectFull(page);
      const editor = reader(page).locator(".draft-editor");
      await browserExpect(editor.getByRole("textbox", { name: "Reply draft", exact: true })).toHaveValue(draft.body);
      await browserExpect(editor.getByLabel("Subject", { exact: true })).toHaveValue(draft.subject);
      await browserExpect(editor.getByLabel("Recipients", { exact: true })).toHaveValue(draft.recipients[0]);
      await browserExpect(editor.getByRole("textbox", { name: "Reply draft", exact: true })).toHaveAttribute("id", "draft-preview-a");
      await browserExpect(editor).toContainText("draft source is an earlier inbox preview");
      await browserExpect(page.locator(".message-row")).toHaveCount(1);
      await browserExpect(page.locator(".message-row")).toHaveAttribute("data-message-id", "preview-a");
      await browserExpect(page.locator(".message-row")).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.drafts)).toEqual([draft]);
      const unsaved = `${draft.body}\nOne more unsaved sentence.`;
      await editor.getByRole("textbox", { name: "Reply draft", exact: true }).fill(unsaved);
      await page.evaluate(() => window.inboxFullEmailTest.changed());
      await page.locator(".message-row").click();
      await browserExpect(editor.getByRole("textbox", { name: "Reply draft", exact: true })).toHaveValue(unsaved);
      await browserExpect(editor).toContainText("Unsaved edits");
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.drafts)).toEqual([draft]);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toEqual([{ type: "message.load", messageId: "preview-a" }]);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("retains the selected anchor when the preview falls out of the latest 500 snapshot before its full response arrives", async () => {
    const { page, externalRequests } = await openPage();
    try {
      await select(page);
      await page.evaluate(() => {
        const harness = window.inboxFullEmailTest, anchor = harness.state.messages[0];
        const full = harness.results[anchor.threadId];
        const newer = Array.from({ length: 498 }, (_, index) => ({
          ...anchor, id: `newer-${index}`, providerId: `thread:newer-${index}`,
          threadId: `${anchor.accountId}:thread:newer-${index}`, subject: `Newer conversation ${index}`,
          receivedAt: "2026-09-23T12:00:00Z",
        }));
        harness.state.messages = [...newer, ...structuredClone(full.messages)];
        harness.state.attachments = structuredClone(full.attachments);
        harness.changed();
      });
      await browserExpect(reader(page).getByRole("heading", { name: "Project A review", exact: true })).toBeVisible();
      await browserExpect(reader(page).getByRole("status")).toContainText("Loading the complete conversation");
      await browserExpect(page.locator('.message-row[data-message-id="preview-a"]')).toHaveCount(0);
      await browserExpect(page.locator(".message-row[aria-pressed=true]")).toHaveCount(1);
      await browserExpect(page.locator(".message-row[aria-pressed=true]")).toContainText("Project A review");
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.messages.length)).toBe(500);
      expect(await page.evaluate(() => window.inboxFullEmailTest.pending)).toEqual(["preview-a"]);
      await settle(page); await expectFull(page);
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-A.pdf", exact: true })).toBeVisible();
      await browserExpect(page.locator(".message-row[aria-pressed=true]")).toHaveCount(1);
      expect(await page.evaluate(() => window.inboxFullEmailTest.state.messages.some(message => message.id === "preview-a"))).toBe(false);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toEqual([{ type: "message.load", messageId: "preview-a" }]);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("ignores a late A response after rapid selection of B, even when A updates the archive snapshot", async () => {
    const { page, externalRequests } = await openPage(true);
    try {
      await select(page, "a"); await select(page, "b");
      await browserExpect(reader(page).getByRole("heading", { name: "Project B review", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.inboxFullEmailTest.pending)).toEqual(["preview-a", "preview-b"]);
      await settle(page, "b"); await expectFull(page, "b");
      await settle(page, "a");
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.completed)).toEqual(["preview-b", "preview-a"]);
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.state.messages.length)).toBe(6);
      await expectFull(page, "b");
      await browserExpect(reader(page).getByRole("heading", { name: "Project A review", exact: true })).toHaveCount(0);
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-A.pdf", exact: true })).toHaveCount(0);
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-B.pdf", exact: true })).toBeVisible();
      await browserExpect(page.locator(".message-row")).toHaveCount(2);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toHaveLength(2);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("removes loaded bodies and attachment controls immediately when the source is revoked", async () => {
    const { page, externalRequests } = await openPage();
    try {
      await select(page); await settle(page); await expectFull(page);
      await page.evaluate(() => { window.inboxFullEmailTest.state.sources[0].selected = false; window.inboxFullEmailTest.changed(); });
      await browserExpect(reader(page).locator(".thread-message, iframe")).toHaveCount(0);
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-A.pdf", exact: true })).toHaveCount(0);
      await browserExpect(reader(page).getByRole("button", { name: "Reload full conversation" })).toHaveCount(0);
      expect(await page.evaluate(() => window.inboxFullEmailTest.commands)).toHaveLength(1);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });

  it("discards pending full emails if source permission is revoked before their response arrives", async () => {
    const { page, externalRequests } = await openPage();
    try {
      await select(page);
      await page.evaluate(() => { window.inboxFullEmailTest.state.sources[0].selected = false; window.inboxFullEmailTest.changed(); });
      await browserExpect(reader(page).locator(".thread-message")).toHaveCount(0);
      await settle(page);
      await browserExpect.poll(() => page.evaluate(() => window.inboxFullEmailTest.completed.length)).toBe(1);
      await browserExpect(reader(page).locator(".thread-message, iframe")).toHaveCount(0);
      await browserExpect(reader(page)).not.toContainText("2 complete messages");
      await browserExpect(reader(page).getByRole("button", { name: "View document Project-A.pdf", exact: true })).toHaveCount(0);
      await expectLocalOnly(page, externalRequests);
    } finally { await page.close(); }
  });
});
