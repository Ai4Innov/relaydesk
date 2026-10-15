import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged browser accounts isolate captures, retain consent and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-browser-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  env.RELAY_DATA_DIR = directory;
  env.RELAY_E2E = "1";
  const manifest = JSON.parse(await readFile(join("browser-extension", "manifest.json"), "utf8"));
  const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
  const executablePath = process.env.RELAY_APP_EXECUTABLE;
  let application: ElectronApplication | undefined;
  let token = "";
  const post = (path: string, body: unknown, authorization = token) => fetch(`http://127.0.0.1:43891${path}`, {
    method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify(body)
  });
  try {
    application = await electron.launch({ executablePath, args: executablePath ? [] : ["."], env });
    let page = await application.firstWindow();
    const pairing = await page.evaluate(() => window.relay.command({ type: "browser.pair", consent: true }));
    expect(pairing.browserPairing?.code).toMatch(/^\d{6}$/);
    const paired = await post("/pair", { code: pairing.browserPairing!.code });
    expect(paired.status).toBe(200);
    token = (await paired.json()).token;
    const chromeToken = token;
    const edgePairing = await page.evaluate(() => window.relay.command({ type: "browser.pair", consent: true }));
    const edgePaired = await post("/pair", { code: edgePairing.browserPairing!.code });
    expect(edgePaired.status).toBe(200);
    token = (await edgePaired.json()).token;
    expect(token === chromeToken).toBe(false);
    for (const email of ["first@example.org", "second@example.org"]) {
      const registration = { accountEmail: email, accountName: "Synthetic account", kind: "mail",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox" };
      const discovered = await post("/discover", registration);
      expect(discovered.status).toBe(200);
      expect((await discovered.json()).enabled).toBe(false);
      const capture = { ...registration, messages: [{ id: "same-message-id", threadId: "same-thread-id",
        subject: "Synthetic browser message", sender: "sender@example.org", recipients: [email],
        body: "Synthetic browser-only evidence.", dateText: "Today", url: `${registration.pageUrl}/thread`,
        unread: true, completeness: "preview" }], meetings: [] };
      expect((await post("/capture", capture)).status).toBe(403);
      const snapshot = await page.evaluate(() => window.relay.snapshot());
      const account = snapshot.accounts.find(account => account.email === email)!;
      expect(account.aiEnabled).toBe(false);
      expect(account.connection).toBe("browser");
      const source = snapshot.sources.find(source => source.accountId === account.id && source.kind === "mail")!;
      expect(source.selected).toBe(false);
      await page.evaluate(sourceId => window.relay.command({ type: "source.select", sourceId, selected: true }), source.id);
      expect((await post("/capture", capture)).status).toBe(200);
      const calendarSource = snapshot.sources.find(source => source.accountId === account.id && source.kind === "calendar")!;
      await page.evaluate(sourceId => window.relay.command({ type: "source.select", sourceId, selected: true }), calendarSource.id);
      expect((await post("/capture", { ...registration, kind: "calendar",
        pageUrl: "https://calendar.google.com/calendar/u/0/r/agenda", messages: [],
        meetings: [{ id: "same-event-id", title: "Synthetic meeting", whenText: "Tomorrow 10am",
          description: "", location: "", meetingUrl: "https://meet.google.com/abc-defg-hij",
          url: "https://calendar.google.com/calendar/u/0/r/agenda" }] })).status).toBe(200);
    }
    const captured = await page.evaluate(() => window.relay.snapshot());
    expect(captured.accounts).toHaveLength(2);
    expect(captured.messages).toHaveLength(2);
    expect(new Set(captured.messages.map(message => message.id)).size).toBe(2);
    expect(captured.browserItems).toHaveLength(2);
    expect(captured.events).toHaveLength(0);
    expect(captured.drafts).toHaveLength(0);
    await application.close(); application = undefined;
    application = await electron.launch({ executablePath, args: executablePath ? [] : ["."], env });
    page = await application.firstWindow();
    const restored = await page.evaluate(() => window.relay.snapshot());
    expect(restored.browser?.paired).toBe(true);
    expect(restored.browser?.running).toBe(true);
    expect(restored.messages).toHaveLength(2);
    expect(restored.browserItems).toHaveLength(2);
    expect(restored.accounts.every(account => !account.aiEnabled)).toBe(true);
    const registration = { accountEmail: "first@example.org", accountName: "Synthetic account",
      kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox" };
    expect((await post("/discover", registration, chromeToken)).status).toBe(200);
    expect((await post("/discover", registration)).status).toBe(200);
    await page.evaluate(() => window.relay.command({ type: "browser.revoke" }));
    const revoked = await page.evaluate(() => window.relay.snapshot());
    expect(revoked.browser?.paired).toBe(false);
    expect(revoked.browserItems).toHaveLength(0);
    expect(revoked.accounts.every(account => account.status === "disconnected")).toBe(true);
    expect((await post("/discover", { accountEmail: "first@example.org", accountName: "Synthetic account",
      kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox" })).status).toBe(401);
    expect((await post("/discover", registration, chromeToken)).status).toBe(401);
  } finally {
    try { await application?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
