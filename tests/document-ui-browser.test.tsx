import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { AttachmentView, Command, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { samplePdf } from "./fixtures/pdf";

interface DocumentHarness { state: Snapshot; commands: Command[]; preview: AttachmentView; changed(): void; holdView: boolean; releaseView(): void; created: string[]; revoked: string[] }
declare global { interface Window { documentUiTest: DocumentHarness } }

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("isolated internal document viewer", () => {
  let browser: Browser, server: ViteDevServer, origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0, watch: null } });
    await server.listen(); origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  async function openPage(patch: Partial<AttachmentView> = {}): Promise<Page> {
    const preview: AttachmentView = { attachmentId: "document", name: "Review.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "text", text: "Project review\n<script>not executable</script>\n![tracking](https://tracker.invalid/pixel)", canSave: true, truncated: false, ...patch };
    const state: Snapshot = {
      accounts: [{ id: "account", provider: "gmail", connection: "browser", email: "documents@example.org", name: "Documents", status: "connected", consent: true, aiEnabled: false }],
      sources: [{ id: "source", accountId: "account", providerId: "inbox", name: "Inbox", kind: "mail", selected: true }],
      messages: [{ id: "message", accountId: "account", sourceId: "source", providerId: "remote", threadId: "thread", subject: "Project documents", sender: "author@example.org", recipients: [], body: "Review the attached documents.", receivedAt: "2026-09-23T08:00:00Z", url: "", unread: false, revision: "1", historical: false }],
      attachments: [{ id: "document", accountId: "account", messageId: "message", providerId: "remote-file", name: preview.name, mimeType: preview.mimeType, status: "indexed", hash: "retained" }],
      settings: { ...defaultSettings, model: "" }, models: [], copilot: { status: "disconnected", message: "" }, demo: false,
      drafts: [], events: [], actions: [], jobs: [], approvals: [], archive: { messages: 1, attachments: 1, indexed: 1, searchMode: "keyword", bytes: 100 },
      chat: { busy: false, activeConversationId: "chat", conversations: [{ id: "chat", title: "Review documents", updatedAt: "2026-09-23T08:00:00Z", turns: [{ id: "turn", role: "assistant", text: "## Supporting document\n\nReview the cited document.", status: "complete", createdAt: "2026-09-23T08:00:00Z", actions: [], citations: [{ id: "cite", messageId: "message", attachmentId: "document", title: "Review document", excerpt: "Project review", location: "Page 1" }, { id: "unknown", messageId: "message", attachmentId: "unknown-file", title: "Unknown file", excerpt: "" }] }] }] },
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(({ state, preview }) => {
      let listeners: (() => void)[] = [], release = () => {};
      const harness: DocumentHarness = { state, preview, commands: [], changed: () => listeners.forEach(listener => listener()), holdView: false, releaseView: () => release(), created: [], revoked: [] };
      window.documentUiTest = harness;
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); harness.created.push(url); return url; };
      URL.revokeObjectURL = url => { harness.revoked.push(url); revoke(url); };
      window.relay = {
        snapshot: async () => structuredClone(state),
        onChange: listener => { listeners.push(listener); return () => { listeners = listeners.filter(item => item !== listener); }; },
        command: async command => {
          harness.commands.push(command);
          if (command.type === "attachment.view") {
            const attachmentView = structuredClone(harness.preview);
            if (harness.holdView) await new Promise<void>(resolve => { release = resolve; });
            return { attachmentView };
          }
          if (command.type === "attachment.save") return { attachmentSave: { status: "saved", name: preview.name, message: "Saved to your chosen Downloads location." } };
          return {};
        },
      };
    }, { state, preview });
    await page.goto(origin);
    await browserExpect(page.getByRole("button", { name: `View document ${preview.name}`, exact: true })).toBeVisible();
    return page;
  }

  it("opens known chat documents and inbox attachments internally, renders plain extracted text, and saves only on click", async () => {
    const page = await openPage();
    const remote: string[] = [];
    page.on("request", request => { if (request.url().includes("tracker.invalid")) remote.push(request.url()); });
    try {
      expect(await page.evaluate(() => window.documentUiTest.commands)).toEqual([]);
      await browserExpect(page.locator(".chat-document-reference")).toHaveCount(1);
      await browserExpect(page.locator(".chat-document-reference")).toContainText("Review.docx");
      await browserExpect(page.locator(".chat-document-reference")).toBeVisible();
      await browserExpect(page.locator(".chat-citations")).not.toHaveAttribute("open", "");
      await browserExpect(page.locator(".chat-citations .chat-document-reference")).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: "View document unknown-file" })).toHaveCount(0);
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Review.docx" });
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog).toContainText("original document layout and formatting are not reproduced");
      await browserExpect(dialog.locator("pre")).toContainText("<script>not executable</script>");
      await browserExpect(dialog.locator("img, script, iframe, object, embed")).toHaveCount(0);
      expect(remote).toEqual([]);
      expect(await page.evaluate(() => window.documentUiTest.commands.filter(command => command.type === "attachment.save"))).toEqual([]);
      await dialog.getByRole("button", { name: "Save to Downloads", exact: true }).click();
      await browserExpect(dialog.getByRole("status")).toContainText("Saved to your chosen Downloads location.");
      expect(await page.evaluate(() => window.documentUiTest.commands.filter(command => command.type === "attachment.save"))).toEqual([{ type: "attachment.save", attachmentId: "document" }]);
      await page.keyboard.press("Escape");
      await browserExpect(dialog).toHaveCount(0);
      await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
      await page.getByRole("button", { name: /author@example.org.*Project documents/ }).click();
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      await browserExpect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Save Review.docx to Downloads", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.documentUiTest.state.accounts[0].aiEnabled)).toBe(false);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await browserExpect(page.getByLabel("API provider", { exact: true }).locator('option[value="whatsapp"]')).toHaveCount(0);
      await browserExpect(page.getByLabel("API provider", { exact: true }).locator("option")).toHaveCount(3);
    } finally { await page.close(); }
  });

  it("closes immediately on permission revocation and discards late document responses", async () => {
    const page = await openPage();
    try {
      await page.evaluate(() => { window.documentUiTest.holdView = true; });
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      await browserExpect(page.getByRole("dialog")).toContainText("Opening encrypted local document");
      await page.evaluate(() => { window.documentUiTest.state.sources[0].selected = false; window.documentUiTest.changed(); });
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => { window.documentUiTest.releaseView(); window.documentUiTest.holdView = false; });
      await browserExpect(page.locator(".document-text")).toHaveCount(0);
      await page.evaluate(() => { window.documentUiTest.state.sources[0].selected = true; window.documentUiTest.changed(); });
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      await browserExpect(page.getByRole("dialog").locator("pre")).toContainText("Project review");
      await page.evaluate(() => { window.documentUiTest.state.accounts[0].status = "disconnected"; window.documentUiTest.changed(); });
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => { window.documentUiTest.state.accounts[0].status = "connected"; window.documentUiTest.changed(); });
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      await browserExpect(page.getByRole("dialog").locator("pre")).toContainText("Project review");
      await page.evaluate(() => { window.documentUiTest.state.attachments = []; window.documentUiTest.changed(); });
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
    } finally { await page.close(); }
  });

  it("renders PDF pages locally with bounded navigation and zoom without executing embedded actions", async () => {
    const page = await openPage({ kind: "pdf", name: "Review.pdf", mimeType: "application/pdf", base64: samplePdf() });
    const remote: string[] = [];
    page.on("request", request => { if (request.url().includes("tracker.invalid")) remote.push(request.url()); });
    try {
      await page.getByRole("button", { name: "View document Review.pdf", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await browserExpect(dialog).toContainText("Page 1 of 2");
      await browserExpect(dialog.getByText("Rendering page…", { exact: true })).toHaveCount(0);
      await browserExpect(dialog.locator("canvas")).toBeVisible();
      expect(await dialog.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
      await browserExpect(dialog.getByRole("button", { name: "Previous PDF page" })).toBeDisabled();
      await dialog.getByRole("button", { name: "Next PDF page" }).click();
      await browserExpect(dialog).toContainText("Page 2 of 2");
      await browserExpect(dialog.getByRole("button", { name: "Next PDF page" })).toBeDisabled();
      for (let index = 0; index < 4; index++) await dialog.getByRole("button", { name: "Zoom in document" }).click();
      await browserExpect(dialog.getByRole("button", { name: "Zoom in document" })).toBeDisabled();
      await browserExpect(dialog).toContainText("200%");
      expect(remote).toEqual([]);
      await browserExpect(dialog.locator("iframe, object, embed, a")).toHaveCount(0);
    } finally { await page.close(); }
  });

  it("revokes local image object URLs on close and never renders SVG originals", async () => {
    const page = await openPage({ kind: "image", name: "Image.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" });
    try {
      await page.getByRole("button", { name: "View document Image.png", exact: true }).click();
      const image = page.getByRole("dialog").locator("img");
      await browserExpect(image).toHaveAttribute("src", /^blob:/);
      await browserExpect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
      const url = await image.getAttribute("src");
      await page.getByRole("button", { name: "Close document" }).click();
      expect(await page.evaluate(() => window.documentUiTest.revoked)).toContain(url);
      await page.evaluate(() => { window.documentUiTest.preview.mimeType = "image/svg+xml"; window.documentUiTest.preview.base64 = btoa('<svg onload="alert(1)"/>'); });
      await page.getByRole("button", { name: "View document Image.png", exact: true }).click();
      await browserExpect(page.getByRole("dialog")).toContainText("This image format is not available in the safe viewer.");
      await browserExpect(page.getByRole("dialog").locator("img, svg:not(.lucide), iframe")).toHaveCount(0);
    } finally { await page.close(); }
  });

  it("explains unavailable Gmail originals and requires an explicit click to approve download", async () => {
    const page = await openPage({ kind: "unavailable", canSave: false, text: undefined });
    try {
      await page.evaluate(() => {
        const attachment = window.documentUiTest.state.attachments[0];
        delete attachment.hash; attachment.status = "awaiting-approval";
        attachment.browser = { source: "browser_gmail", metadataId: "downloaded-copy" };
        window.documentUiTest.changed();
      });
      await page.getByRole("button", { name: "View document Review.docx", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await browserExpect(dialog).toContainText("Check automatic Gmail attachment downloads");
      await browserExpect(dialog).toContainText("Files requiring approval wait for your confirmation");
      await browserExpect(dialog.getByRole("button", { name: "Save to Downloads", exact: true })).toBeDisabled();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
      await page.getByRole("button", { name: /author@example.org.*Project documents/ }).click();
      await browserExpect(page.getByRole("button", { name: "Approve and import downloaded file", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("button", { name: "Save Review.docx to Downloads", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => window.documentUiTest.commands.filter(command => command.type === "attachment.import" || command.type === "attachment.download" || command.type === "attachment.process" || command.type === "attachment.save"))).toEqual([]);
      await page.getByRole("button", { name: "Approve download and indexing", exact: true }).click();
      expect(await page.evaluate(() => window.documentUiTest.commands.at(-1))).toEqual({
        type: "attachment.download", attachmentId: "document", approved: true
      });
    } finally { await page.close(); }
  });

  it("shows and opens an older cited attachment outside the latest 500 messages using trusted access metadata", async () => {
    const page = await openPage();
    try {
      await page.evaluate(() => {
        const { state } = window.documentUiTest;
        const oldMessage = state.messages[0];
        state.messages = Array.from({ length: 500 }, (_, index) => ({ ...oldMessage, id: `recent-${index}`, subject: `Recent message ${index}` }));
        Object.assign(state.attachments[0], { sourceId: "source", parentAvailable: true });
        window.documentUiTest.changed();
      });
      const card = page.locator(".chat-document-reference");
      await browserExpect(card).toBeVisible();
      await browserExpect(card).toContainText("Review.docx");
      await card.getByRole("button", { name: "View document Review.docx" }).click();
      await browserExpect(page.getByRole("dialog").locator("pre")).toContainText("Project review");
      expect(await page.evaluate(() => window.documentUiTest.state.accounts[0].aiEnabled)).toBe(false);
      expect(await page.evaluate(() => window.documentUiTest.state.messages.some(message => message.id === "message"))).toBe(false);
      await page.evaluate(() => { window.documentUiTest.state.attachments[0].parentAvailable = false; window.documentUiTest.changed(); });
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      await browserExpect(card).toHaveCount(0);
      const reads = await page.evaluate(() => window.documentUiTest.commands.filter(command => command.type === "attachment.view"));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(command => command.type === "attachment.view" && command.attachmentId === "document")).toBe(true);
    } finally { await page.close(); }
  });
});
