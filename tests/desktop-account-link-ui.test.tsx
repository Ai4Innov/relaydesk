import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { BrowserSetup } from "../src/renderer/BrowserSetup";
import { defaultSettings } from "../src/shared/defaults";
import type { Command, Snapshot } from "../src/shared/contracts";

const snapshot: Snapshot = {
  accounts: [], sources: [], messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
  settings: defaultSettings, models: [], copilot: { status: "disconnected", message: "Offline fixture" },
  archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false
};

describe("desktop account link form rendering", () => {
  it.each([false, true])("renders explicit, truthful navigation with busy=%s", busy => {
    const run = vi.fn();
    const html = renderToStaticMarkup(<BrowserSetup data={snapshot} busy={busy} run={run}/>);
    expect(html).toContain("Add account by link");
    expect(html).toContain('for="account-link"');
    expect(html).toContain('type="url"');
    expect(html).toContain("Open account page in default browser");
    expect(html).toContain("Opening does not connect an account");
    expect(html).toContain("routing hint, not proof of identity");
    expect(html).toContain("paired Edge or Chrome profile");
    expect(html).toContain("Source selection and AI sharing remain separate opt-ins");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Open account page in default browser/);
    expect(html).not.toContain('checked=""');
    expect(run).not.toHaveBeenCalled();
  });
});

// Isolated renderer with mocked IPC; never starts or contacts the production bridge.
describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("desktop account link form interactions", () => {
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

  it("rejects unsafe input, sends only a safe root on explicit submit, and preserves input on failure", async () => {
    const page = await browser.newPage();
    await page.addInitScript((state: Snapshot) => {
      const commands: Command[] = [];
      let failOpen = true;
      Object.assign(window, { linkTest: { commands } });
      window.relay = {
        snapshot: async () => structuredClone(state), onChange: () => () => {},
        command: async command => {
          commands.push(command);
          if (command.type === "browser.open-link" && failOpen) {
            failOpen = false;
            throw new Error("Default browser could not open.");
          }
          return { message: "Provider page opened in your default browser, not an account connection." };
        }
      };
    }, snapshot);
    try {
      await page.goto(origin);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByText("Browser companion (Chrome / Edge)", { exact: true }).click();
      await page.getByText("Add account by link (optional)", { exact: true }).click();
      const input = page.getByLabel("Gmail or Google Calendar account link", { exact: true });
      const open = page.getByRole("button", { name: "Open account page in default browser", exact: true });
      const commands = () => page.evaluate(() => (window as unknown as { linkTest: { commands: Command[] } }).linkTest.commands);
      await browserExpect(open).toBeDisabled();
      await input.fill("https://mail.google.com.evil.example/mail/");
      await browserExpect(input).toHaveAttribute("aria-invalid", "true");
      await browserExpect(page.locator("#account-link-error")).toBeVisible();
      await browserExpect(open).toBeDisabled();
      expect(await commands()).toEqual([]);
      const original = "https://mail.google.com/mail/u/2/?compose=synthetic#inbox/synthetic";
      await input.fill(original);
      await browserExpect(open).toBeEnabled();
      expect(await commands()).toEqual([]);
      await open.click();
      await browserExpect(page.getByText("Default browser could not open.", { exact: true })).toBeVisible();
      await browserExpect(input).toHaveValue(original);
      await open.click();
      await browserExpect(input).toHaveValue("");
      expect(await commands()).toEqual([
        { type: "browser.open-link", url: "https://mail.google.com/mail/u/2/#inbox" },
        { type: "browser.open-link", url: "https://mail.google.com/mail/u/2/#inbox" }
      ]);
      await browserExpect(page.getByText("Provider page opened in your default browser, not an account connection.", { exact: true })).toBeVisible();
      await browserExpect(page.getByLabel(/I authorize local capture/)).not.toBeChecked();
      await browserExpect(page.getByLabel("Refresh selected browser pages in the background", { exact: true })).toBeChecked({ checked: defaultSettings.browserBackgroundCapture });
    } finally { await page.close(); }
  }, 30_000);

  it.each(["", "not a valid account link"])("generates a profile pairing code with unrelated account link %j and no accounts", async link => {
    const page = await browser.newPage();
    await page.addInitScript((state: Snapshot) => {
      const commands: Command[] = [];
      Object.assign(window, { linkTest: { commands } });
      window.relay = {
        snapshot: async () => structuredClone(state), onChange: () => () => {},
        command: async command => {
          commands.push(command);
          return command.type === "browser.pair" ? { browserPairing: {
            code: "123456", expiresAt: new Date(Date.now() + 300_000).toISOString(), port: 43891
          } } : {};
        }
      };
    }, snapshot);
    try {
      await page.goto(origin);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByText("Browser companion (Chrome / Edge)", { exact: true }).click();
      const pairing = page.getByRole("region", { name: "Pair browser profile" });
      const generate = pairing.getByRole("button", { name: "Generate pairing code", exact: true });
      await browserExpect(generate).toBeDisabled();
      await browserExpect(page.getByLabel("Gmail or Google Calendar account link", { exact: true })).not.toBeVisible();
      if (link) {
        await page.getByText("Add account by link (optional)", { exact: true }).click();
        await page.getByLabel("Gmail or Google Calendar account link", { exact: true }).fill(link);
      }
      await pairing.getByRole("checkbox").check();
      await browserExpect(generate).toBeEnabled();
      await generate.click();
      await browserExpect(pairing).toContainText("Pairing code: 123456");
      expect(await page.evaluate(() => (window as unknown as { linkTest: { commands: Command[] } }).linkTest.commands))
        .toEqual([{ type: "browser.pair", consent: true }]);
      expect(await generate.evaluate(element => element.closest("form"))).toBeNull();
    } finally { await page.close(); }
  }, 30_000);
});
