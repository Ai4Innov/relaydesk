import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop opens, persists synthetic workspace and enforces privileged commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  env.RELAY_DATA_DIR = directory;
  env.RELAY_E2E = "1";
  const executablePath = process.env.RELAY_APP_EXECUTABLE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath, args: executablePath ? [] : ["."], env });
    const page = await application.firstWindow();
    await expect(page).toHaveTitle(/Relay/);
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "What can we take off your mind?" })).toBeVisible();
    const before = await page.evaluate(() => window.relay.snapshot());
    expect(before.accounts).toHaveLength(0);
    if (process.env.RELAY_COPILOT_SMOKE === "1" || process.env.RELAY_REQUIRE_COPILOT_AUTH === "1") {
      await page.evaluate(async () => {
        try { await window.relay.command({ type: "copilot.connect" }); }
        catch { /* Inspect the surfaced connection state below. */ }
      });
      const status = (await page.evaluate(() => window.relay.snapshot())).copilot;
      if (process.env.RELAY_REQUIRE_COPILOT_AUTH === "1") {
        expect(status.status, status.message).toBe("ready");
        expect((await page.evaluate(() => window.relay.snapshot())).models.length).toBeGreaterThan(0);
      }
      if (status.status !== "ready") expect(status.message).toMatch(/sign in|no entitled/i);
    }
    await page.evaluate(() => window.relay.command({ type: "demo.load" }));
    const after = await page.evaluate(() => window.relay.snapshot());
    expect(after.demo).toBe(true);
    expect(after.messages.length).toBeGreaterThan(3);
    expect(after.archive.messages).toBe(after.messages.length);
    const search = await page.evaluate(() => window.relay.command({ type: "search", query: "phased release" }));
    expect(search.citations?.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("body")).toContainText(/launch/i);
    await page.screenshot({ path: "test-results/relay-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
    await expect(page.locator("body")).toContainText("Launch review: your decision is needed");
    await expect(page.getByRole("group", { name: "Choose an inbox" })).toBeVisible();
    await page.locator(".message-row").first().click();
    const formatted = page.frameLocator('iframe[title="Formatted email"]');
    await expect(formatted.locator("body")).toContainText("launch checklist");
    await expect(formatted.locator("strong").first()).toHaveText("launch checklist");
    await page.getByRole("button", { name: "Plain text", exact: true }).click();
    await expect(page.locator(".plain-body").first()).toContainText("phased release");
    await page.getByRole("button", { name: "Formatted view", exact: true }).click();
    await page.getByRole("button", { name: "View document rollout-plan.pdf", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("original has not been retained");
    await page.getByRole("button", { name: "Close document", exact: true }).click();
    await page.getByLabel("Inbox account", { exact: true }).selectOption("demo-microsoft");
    await expect(page.locator(".message-row")).toHaveCount(1);
    await expect(page.locator(".message-row")).toContainText("alex@contoso.example - Outlook");
    await expect(page.getByRole("region", { name: "Conversation reader" })).toContainText("Select a message");
    await page.getByRole("button", { name: "All inboxes", exact: true }).click();
    await expect(page.locator(".message-row")).toHaveCount(after.messages.length);
    await page.screenshot({ path: "test-results/relay-inbox.png", fullPage: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("body")).toContainText(/Copilot/);
    await page.getByLabel("Refresh selected browser pages in the background", { exact: true }).click();
    await expect(page.getByLabel("Refresh selected browser pages in the background", { exact: true })).toBeChecked();
    await page.getByLabel("Refresh interval", { exact: true }).selectOption("0");
    await expect.poll(async () => (await page.evaluate(() => window.relay.snapshot())).settings.refreshIntervalSeconds).toBe(0);
    await page.getByRole("button", { name: "Tasks & focus", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Focus report", exact: true })).toBeVisible();
    await page.getByLabel("New task title", { exact: true }).fill("Synthetic personal checklist");
    await page.getByLabel("New task notes", { exact: true }).fill("Keep editable after refresh.");
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    const taskCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "Synthetic personal checklist", exact: true }) });
    await taskCard.getByRole("button", { name: "Edit", exact: true }).click();
    const taskTitle = page.getByLabel("Edit title Synthetic personal checklist", { exact: true });
    await taskTitle.fill("Edited synthetic checklist");
    await page.evaluate(() => window.relay.command({ type: "settings.update", patch: { notifications: false } }));
    await expect(taskTitle).toHaveValue("Edited synthetic checklist");
    await taskCard.getByRole("button", { name: "Save task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edited synthetic checklist", exact: true })).toBeVisible();
    const taskId = await page.evaluate(async () => (await window.relay.snapshot()).tasks?.find(task => task.title === "Edited synthetic checklist")?.id);
    expect(taskId).toBeTruthy();
    const draft = after.drafts[0];
    expect(draft).toBeDefined();
    await page.evaluate(draft => window.relay.command({
      type: "draft.edit", draftId: draft.id, subject: draft.subject, recipients: draft.recipients,
      body: "An explicitly edited synthetic response."
    }), draft);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.relay.snapshot())).chat?.conversations.length).toBe(1);
    const conversationId = (await page.evaluate(() => window.relay.snapshot())).chat!.conversations[0].id;
    await application.close();
    application = undefined;
    application = await electron.launch({ executablePath, args: executablePath ? [] : ["."], env });
    const reopened = await application.firstWindow();
    const persisted = await reopened.evaluate(() => window.relay.snapshot());
    expect(persisted.drafts.find(d => d.id === draft.id)?.body).toBe("An explicitly edited synthetic response.");
    expect(persisted.archive.messages).toBe(after.archive.messages);
    expect(persisted.settings.refreshIntervalSeconds).toBe(0);
    expect(persisted.settings.browserBackgroundCapture).toBe(true);
    expect(persisted.tasks?.find(task => task.id === taskId)?.notes).toBe("Keep editable after refresh.");
    expect(persisted.chat?.conversations.some(conversation => conversation.id === conversationId)).toBe(true);
    await reopened.evaluate(conversationId => window.relay.command({ type: "chat.delete", conversationId }), conversationId);
    expect((await reopened.evaluate(() => window.relay.snapshot())).chat?.conversations).toHaveLength(0);
    await reopened.evaluate(() => window.relay.command({ type: "demo.clear" }));
    expect((await reopened.evaluate(() => window.relay.snapshot())).accounts).toHaveLength(0);
    expect((await reopened.evaluate(() => window.relay.snapshot())).tasks?.some(task => task.id === taskId)).toBe(true);
  } finally {
    try { await application?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
