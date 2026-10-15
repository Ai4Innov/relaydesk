import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserCapture, BrowserRegistration } from "../src/shared/browser";
import { commandSchema } from "../src/main/ipc/schema";

const url = "https://web.whatsapp.com/";
const ownProfile = `<aside data-testid="profile-drawer"><header>Profile</header><div><span>Phone number</span><div>+33 6 12 34 56 78</div></div></aside>`;
const bubble = (chat = "33699999999@c.us", body = "A loaded WhatsApp message") => `<div class="message-in" data-id="false_${chat}_ABC123"><div class="copyable-text" data-pre-plain-text="[09:20, 23/09/2026] Alice: "><span class="selectable-text">${body}</span></div></div>`;
const fixture = (profile = ownProfile, messages = bubble()) => `<div id="app">${profile}<main id="main"><header><span title="Alice">Alice</span></header>${messages}<button id="send">Send</button></main></div>`;

it("allows WhatsApp browser opening but rejects WhatsApp API credentials", () => {
  expect(commandSchema.safeParse({ type: "browser.open", kind: "whatsapp" }).success).toBe(true);
  expect(commandSchema.safeParse({ type: "account.connect", provider: "whatsapp", consent: true }).success).toBe(false);
});

describe("visible WhatsApp Web capture", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) });
  });
  afterAll(async () => { await browser?.close(); }, 30_000);
  async function read(html: string, work: "identity" | "extract" = "extract") {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      await page.addScriptTag({ path: resolve("browser-extension", "whatsapp.js") });
      await page.addScriptTag({ path: resolve("browser-extension", "extractors.js") });
      return await page.evaluate(({ url, work }) => {
        const api = (globalThis as unknown as { RelayExtractors: {
          identity(document: Document, url: string): BrowserRegistration;
          extract(document: Document, input: BrowserRegistration): Pick<BrowserCapture, "messages" | "meetings"> & { coverage: string };
        } }).RelayExtractors;
        let clicks = 0;
        document.addEventListener("click", () => clicks++);
        const identity = api.identity(document, url);
        const result = work === "extract" ? api.extract(document, identity) : undefined;
        return { identity, result, clicks };
      }, { url, work });
    } finally { await page.close(); }
  }
  it("uses own verified phone and stable chat/message IDs, preserves displayed dates and never sends", async () => {
    const value = await read(fixture());
    expect(value.identity).toMatchObject({ accountEmail: "+33612345678", kind: "whatsapp", chat: { id: "33699999999@c.us", name: "Alice" } });
    expect(value.result?.messages[0]).toMatchObject({ id: "false_33699999999@c.us_ABC123",
      threadId: "33699999999@c.us", sender: "Alice", body: "A loaded WhatsApp message", dateText: "09:20, 23/09/2026", completeness: "full" });
    expect(value.result?.messages[0].receivedAt).toBeUndefined();
    expect(value.result?.coverage).toContain("Older/unloaded");
    expect(value.clicks).toBe(0);
  });
  it("never identifies accounts from contacts, hidden profiles or phone text in chat bodies", async () => {
    for (const profile of ["", ownProfile.replace("<aside ", '<aside hidden '), ownProfile.replace("Profile</header>", "Contact info</header>")]) {
      await expect(read(fixture(profile, bubble("33699999999@c.us", ownProfile)))).rejects.toThrow("identity is not verified");
    }
  });
  it("does not merge distinct own phones or rely on an account display name", async () => {
    const first = await read(fixture(), "identity");
    const second = await read(fixture(ownProfile.replace("+33 6 12 34 56 78", "+44 7700 900123")), "identity");
    expect(first.identity.accountEmail).not.toBe(second.identity.accountEmail);
  });
  it("fails closed when a transition exposes messages from different chats", async () => {
    await expect(read(fixture(ownProfile, bubble() + bubble("447700900123@c.us")))).rejects.toThrow("conversation changed");
  });
  it("supports nested group IDs and uses only explicit offset-qualified timestamps", async () => {
    const group = `<div class="message-in"><div data-id="false_120363123456789@g.us_ABC_33699999999@c.us"><div data-pre-plain-text="[09:20, 23/09/2026] Alice: "><span class="selectable-text">Group text</span><time datetime="2026-09-23T09:20:00+02:00">09:20</time></div></div></div>`;
    const value = await read(fixture(ownProfile, group));
    expect(value.identity.chat?.id).toBe("120363123456789@g.us");
    expect(value.result?.messages[0].receivedAt).toBe("2026-09-23T07:20:00.000Z");
  });
  it("retains attachment metadata without claiming to download bytes", async () => {
    const attachment = `<div data-testid="document-thumb"><span data-testid="document-title">brief.pdf</span></div>`;
    const value = await read(fixture(ownProfile, bubble("33699999999@c.us", "Please read") .replace("</div></div>", `</div>${attachment}</div>`)));
    expect(value.result?.messages[0].attachments).toEqual([{ id: "brief.pdf", name: "brief.pdf", mimeType: "application/octet-stream" }]);
    expect(value.result?.coverage).toContain("metadata only");
  });
});
