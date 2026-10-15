import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samplePdf } from "../fixtures/pdf";

test("packaged local PDF worker renders under the real desktop CSP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-doc-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  env.RELAY_DATA_DIR = directory;
  env.RELAY_E2E = "1";
  const executablePath = process.env.RELAY_APP_EXECUTABLE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath, args: executablePath ? [] : ["."], env });
    const page = await application.firstWindow();
    const external: string[] = [];
    page.on("request", request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await page.evaluate(() => window.relay.command({ type: "demo.load" }));
    // Replace only this isolated process's command transport; production exposes no fixture-loading command.
    await application.evaluate(({ ipcMain }, base64) => {
      ipcMain.removeHandler("relay:command");
      ipcMain.handle("relay:command", (_event, command) => {
        if (command.type !== "attachment.view" || command.attachmentId !== "demo-attachment") throw new Error("Unexpected fixture command");
        return { attachmentView: { attachmentId: "demo-attachment", name: "rollout-plan.pdf", mimeType: "application/pdf",
          kind: "pdf", base64, canSave: false, truncated: false } };
      });
    }, samplePdf());
    await page.getByRole("button", { name: "Unified inbox", exact: true }).click();
    await page.locator(".message-row").first().click();
    await page.getByRole("button", { name: "View document rollout-plan.pdf", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "rollout-plan.pdf" });
    await expect(dialog).toContainText("Page 1 of 2");
    await expect(dialog.getByRole("img", { name: "PDF page 1" })).toBeVisible();
    await dialog.getByRole("button", { name: "Next PDF page" }).click();
    await expect(dialog.getByRole("img", { name: "PDF page 2" })).toBeVisible();
    expect(external).toEqual([]);
    await dialog.getByRole("button", { name: "Close document" }).click();
  } finally {
    try { await application?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
