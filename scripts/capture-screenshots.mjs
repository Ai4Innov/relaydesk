#!/usr/bin/env node
// Captures README/docs screenshots and an animated tour from the synthetic sample workspace.
// Usage: npm run package && npm run screenshots
// No real accounts are touched: the app runs against a throwaway data directory.
import { _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const out = resolve(process.argv[2] ?? "docs/images");
const width = 1360, height = 860;
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE"));
const data = await mkdtemp(join(tmpdir(), "relay-shots-"));
Object.assign(env, { RELAY_DATA_DIR: data, RELAY_E2E: "1" });
await mkdir(out, { recursive: true });

const root = process.cwd();
const outDir = resolve(process.env.RELAY_OUT_DIR ?? "out");
const bundle = join(outDir, `Relay Desk-${process.platform}-${process.arch}`);
const packaged = { win32: join(bundle, "RelayDesk.exe"), darwin: join(bundle, "Relay Desk.app", "Contents", "MacOS", "RelayDesk"), linux: join(bundle, "RelayDesk") }[process.platform];
const executablePath = process.env.RELAY_APP_EXECUTABLE ?? (packaged && existsSync(packaged) ? packaged : undefined);
if (!executablePath) console.warn(`No packaged build found at ${bundle}; launching from source (run "npm run package" first if native modules fail to load).`);
const app = await electron.launch({ executablePath, args: executablePath ? [] : [root], env });
const frames = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.center();
  }, { width, height });
  await page.waitForSelector("h2:has-text('What can we take off your mind?')");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }" });

  const shot = async (name, caption) => {
    await page.waitForTimeout(400);
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file });
    frames.push({ file, caption });
    console.log(`captured ${file}`);
  };
  const go = label => page.getByRole("button", { name: label, exact: true }).click();
  const reveal = async heading => {
    await page.getByRole("heading", { name: heading }).first().evaluate(element => {
      element.scrollIntoView({ block: "start" });
      for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.scrollTop > 0) { parent.scrollTop -= 24; break; }
    });
  };

  await shot("01-welcome", "Start in chat: a guided checklist connects Copilot, a model and your inbox");
  await page.evaluate(() => window.relay.command({ type: "demo.load" }));
  await go("Today");
  await page.waitForSelector("text=/launch/i");
  await reveal(/Your next moves/);
  await shot("02-today", "Today ranks what needs you, with reasons and evidence");
  await go("Unified inbox");
  await page.locator(".message-row").first().click();
  await page.frameLocator('iframe[title="Formatted email"]').locator("body").waitFor();
  await shot("03-inbox", "One inbox for Gmail, Outlook and Slack, with drafts you review");
  await go("Tasks & focus");
  await reveal(/Your tasks/);
  await shot("04-tasks", "Editable tasks and focus reports built from your messages");
  await go("Calendar");
  await page.getByRole("button", { name: /Overlaps/ }).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await shot("05-calendar", "A unified agenda that flags conflicts and busy days");
  await go("Settings");
  await shot("06-settings", "Pick any Copilot model and choose exactly what AI may read");
} finally {
  await app.close().catch(() => undefined);
  await rm(data, { recursive: true, force: true }).catch(() => undefined);
}

// Animated tour: each screen is captioned and shown for ~2.6 s.
const tourWidth = 960, tourHeight = Math.round(height * tourWidth / width), band = 44;
const escape = text => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tourFrames = await Promise.all(frames.map(async ({ file, caption }) => {
  const caption_svg = Buffer.from(`<svg width="${tourWidth}" height="${band}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#142d38"/>
    <text x="50%" y="28" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="17" fill="#ffffff">${escape(caption)}</text></svg>`);
  const screen = await sharp(file).resize(tourWidth, tourHeight).toBuffer();
  return sharp({ create: { width: tourWidth, height: tourHeight + band, channels: 3, background: "#142d38" } })
    .composite([{ input: screen, top: 0, left: 0 }, { input: caption_svg, top: tourHeight, left: 0 }]).png().toBuffer();
}));
const tour = join(out, "tour.gif");
await sharp(tourFrames, { join: { animated: true } }).gif({ delay: tourFrames.map(() => 2600), loop: 0, effort: 7, colours: 128 }).toFile(tour);
console.log(`captured ${tour}`);
