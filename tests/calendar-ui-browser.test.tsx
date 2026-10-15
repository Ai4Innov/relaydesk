import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Command } from "../src/shared/contracts";
import { calendarFixture } from "./fixtures/calendar";

declare global { interface Window { calendarCommands: Command[] } }

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("calendar filters and insight interactions", () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: "msedge", headless: true });
  }, 30000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("filters browser calendars, exposes insights and keeps cards readable at narrow widths", async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    try {
      await page.addInitScript(state => {
        window.calendarCommands = [];
        window.relay = {
          snapshot: async () => structuredClone(state),
          onChange: () => () => undefined,
          command: async command => { window.calendarCommands.push(command); return {}; }
        };
      }, calendarFixture());
      await page.goto(origin);
      await page.getByRole("button", { name: "Calendar", exact: true }).click();
      await browserExpect(page.getByRole("heading", { name: "Client presentation", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("heading", { name: "Date not confirmed", exact: true })).toBeVisible();
      await page.getByLabel("Calendar filter", { exact: true }).selectOption("calendar-two");
      await browserExpect(page.getByRole("heading", { name: "Personal catch-up", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("heading", { name: "Client presentation", exact: true })).toHaveCount(0);
      await page.getByLabel("Calendar filter", { exact: true }).selectOption("");
      await page.getByRole("button", { name: "Important", exact: true }).click();
      await browserExpect(page.getByRole("heading", { name: "Client presentation", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("heading", { name: "Planning", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "All events", exact: true }).click();
      await page.getByRole("textbox", { name: "Search calendar", exact: true }).fill("Planning");
      await browserExpect(page.getByRole("heading", { name: "Planning", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("heading", { name: "Client presentation", exact: true })).toHaveCount(0);
      await page.getByRole("textbox", { name: "Search calendar", exact: true }).fill("");
      await page.getByRole("button", { name: "Refresh calendars", exact: true }).click();
      expect(await page.evaluate(() => window.calendarCommands.filter(command => command.type === "refresh.request").length)).toBe(1);
      const card = page.locator(".calendar-event-card").filter({ has: page.getByRole("heading", { name: "Client presentation", exact: true }) });
      await browserExpect(card.getByText("Keep the full description in details.", { exact: true })).not.toBeVisible();
      await card.locator("summary").click();
      await browserExpect(card.getByText("Keep the full description in details.", { exact: true })).toBeVisible();
      for (const width of [900, 640]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      }
    } finally { await page.close(); }
  }, 30000);
});
