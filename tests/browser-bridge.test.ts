import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge } from "../src/main/browser/bridge";
import { BROWSER_BRIDGE_PORT, type BrowserCapture, type BrowserRegistration } from "../src/shared/browser";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${extensionId}`;
class MemoryVault {
  readonly records = new Map<string, unknown>();
  get<T>(collection: "secrets", id: string): T | undefined { return this.records.get(`${collection}/${id}`) as T | undefined; }
  put<T>(collection: "secrets", id: string, value: T): void { this.records.set(`${collection}/${id}`, structuredClone(value)); }
  delete(collection: "secrets", id: string): void { this.records.delete(`${collection}/${id}`); }
}
function registration(): BrowserRegistration {
  return { accountEmail: "synthetic@example.org", accountName: "Synthetic",
    kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox" };
}
function capture(): BrowserCapture {
  return { ...registration(), meetings: [], messages: [{
    id: "message-1", threadId: "thread-1", subject: "Synthetic subject", sender: "Sender",
    recipients: ["recipient@example.org"], body: "Synthetic private content", dateText: "Today",
    receivedAt: "2026-09-22T10:00:00Z", url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    unread: true, completeness: "full",
  }] };
}
function calendar(): BrowserCapture {
  return { ...registration(), kind: "calendar", pageUrl: "https://calendar.google.com/calendar/u/2/r/agenda",
    messages: [], meetings: [{ id: "event-1", title: "Synthetic meeting", whenText: "Tomorrow",
      description: "", location: "", url: "https://calendar.google.com/calendar/u/2/r/eventedit/event-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij" }] };
}
const bridges: BrowserBridge[] = [];
function setup(vault = new MemoryVault(), overrides: {
  refreshSettings?: () => { intervalSeconds: number; paused: boolean; backgroundCapture?: boolean };
  onDiscover?: (input: BrowserRegistration) => Promise<{ accountId: string; enabled: boolean }>;
  onCapture?: (input: BrowserCapture) => Promise<void>;
} = {}) {
  const onDiscover = vi.fn(overrides.onDiscover ?? (async (_input: BrowserRegistration) => ({ accountId: "synthetic-id", enabled: false })));
  const onCapture = vi.fn(overrides.onCapture ?? (async (_input: BrowserCapture) => undefined));
  const changed = vi.fn();
  const bridge = new BrowserBridge(vault, { extensionId, onDiscover, onCapture, changed, port: 0, refreshSettings: overrides.refreshSettings });
  bridges.push(bridge);
  const send = (path: string, input: unknown, token?: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${bridge.status().port}${path}`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(input),
    });
  const pair = async () => {
    const pairing = await bridge.pair();
    const response = await send("/pair", { code: pairing.code });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string };
    return { ...pairing, token: body.token };
  };
  return { bridge, vault, onDiscover, onCapture, changed, send, pair };
}
function raw(port: number, options: {
  path?: string; method?: string; headers?: Record<string, string>; chunks?: string[];
} = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port, path: options.path ?? "/discover", method: options.method ?? "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...options.headers }, agent: false,
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    });
    request.once("error", reject);
    for (const chunk of options.chunks ?? [JSON.stringify(registration())]) request.write(chunk);
    request.end();
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
});

describe("loopback browser bridge", () => {
  it("accepts bounded full Gmail HTML without broadening provider routes", async () => {
    const h = setup(), { token } = await h.pair();
    const input = capture();
    input.messages[0].html = "<p>Visible message <strong>body</strong></p>";
    expect((await h.send("/capture", input, token)).status).toBe(200);
    expect(h.onCapture.mock.calls[0][0].messages[0].html).toBe(input.messages[0].html);
    input.messages[0].html = "x".repeat(1_000_001);
    expect((await h.send("/capture", input, token)).status).toBe(400);
    input.messages[0].html = "<p>Preview must not claim body markup</p>";
    input.messages[0].completeness = "preview";
    expect((await h.send("/capture", input, token)).status).toBe(400);
  });
  it("validates WhatsApp own-phone identity, exact Web origin and per-chat capture boundaries", async () => {
    const h = setup(), { token } = await h.pair();
    const input: BrowserCapture = { accountEmail: "+33612345678", accountName: "WhatsApp",
      kind: "whatsapp", pageUrl: "https://web.whatsapp.com/", chat: { id: "33699999999@c.us", name: "Alice" },
      messages: [{ ...capture().messages[0], id: "false_33699999999@c.us_ABC", threadId: "33699999999@c.us",
        url: "https://web.whatsapp.com/" }], meetings: [] };
    expect((await h.send("/discover", { ...input, messages: undefined, meetings: undefined }, token)).status).toBe(200);
    expect((await h.send("/capture", input, token)).status).toBe(200);
    for (const invalid of [
      { ...input, accountEmail: "invented@example.org" },
      { ...input, pageUrl: "https://web.whatsapp.com.evil.example/" },
      { ...input, pageUrl: "https://web.whatsapp.com/?phone=33699999999" },
      { ...input, chat: undefined },
      { ...input, messages: [{ ...input.messages[0], threadId: "447700900123@c.us" }] },
      { ...input, messages: [{ ...input.messages[0], html: "<p>Not email</p>" }] },
      { ...input, meetings: calendar().meetings },
    ]) expect((await h.send("/capture", invalid, token)).status).toBe(400);
  });
  it("uses the fixed default port and requires a real pinned Chrome extension ID", () => {
    const options = { extensionId, changed: vi.fn(), onDiscover: vi.fn(), onCapture: vi.fn() };
    expect(new BrowserBridge(new MemoryVault(), options).status()).toEqual({
      running: false, paired: false, port: BROWSER_BRIDGE_PORT,
    });
    expect(() => new BrowserBridge(new MemoryVault(), { ...options, extensionId: "*" })).toThrow("extension");
  });
  it("starts idempotently, binds IPv4 loopback, and reveals credentials only in pairing", async () => {
    const h = setup();
    await Promise.all([h.bridge.start(), h.bridge.start(), h.bridge.start()]);
    const port = h.bridge.status().port;
    expect(port).toBeGreaterThan(0);
    await h.bridge.start();
    expect(h.bridge.status().port).toBe(port);
    const pairing = await h.pair();
    expect(pairing.token).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(pairing.expiresAt) - Date.now()).toBeGreaterThan(119_000);
    expect(JSON.stringify(h.bridge.status())).not.toContain(pairing.token);
    expect(JSON.stringify(h.bridge.status())).not.toContain(pairing.code);
    expect(h.bridge.status()).toMatchObject({ running: true, paired: true, port });
    expect(h.bridge.status().clients).toEqual([{ id: expect.any(String), browser: "unknown", lastSeenAt: expect.any(String) }]);
    expect(h.changed).toHaveBeenCalled();
    await expect(fetch(`http://[::1]:${port}/discover`)).rejects.toThrow();
  });
  it("rejects missing/unpinned origins, forged hosts and missing/wrong bearer tokens", async () => {
    const h = setup(), pairing = await h.pair();
    for (const badOrigin of ["", "null", "https://mail.google.com", `${origin}/`, "chrome-extension://" + "a".repeat(32)]) {
      const response = await h.send("/discover", registration(), pairing.token, { Origin: badOrigin });
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    for (const host of ["evil.example", `evil.example:${pairing.port}`, `127.0.0.1:${pairing.port + 1}`, "localhost", `localhost.:${pairing.port}`]) {
      expect((await raw(pairing.port, { headers: { Host: host, Authorization: `Bearer ${pairing.token}` } })).status).toBe(403);
    }
    expect((await h.send("/discover", registration())).status).toBe(401);
    expect((await h.send("/discover", registration(), "a".repeat(64))).status).toBe(401);
    expect((await raw(pairing.port, { headers: { Host: `localhost:${pairing.port}`, Authorization: `Bearer ${pairing.token}` } })).status).toBe(200);
    expect(h.onDiscover).toHaveBeenCalledTimes(1);
  });
  it("implements pinned preflight, route and method allowlists, and JSON only", async () => {
    const h = setup(), { port, token } = await h.pair();
    const preflight = await raw(port, { method: "OPTIONS", headers: {
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization",
      "Access-Control-Request-Private-Network": "true",
    }, chunks: [] });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
    expect(preflight.headers["access-control-allow-private-network"]).toBe("true");
    expect((await raw(port, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } })).status).toBe(403);
    expect((await raw(port, { method: "OPTIONS", headers: {
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-evil",
    } })).status).toBe(403);
    for (const method of ["GET", "PUT", "DELETE", "HEAD"])
      expect((await raw(port, { method })).status).toBe(405);
    expect((await h.send("/capture?x=1", capture(), token)).status).toBe(404);
    expect((await h.send("/discover", registration(), token, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await h.send("/discover", registration(), token, { "Content-Encoding": "gzip" })).status).toBe(415);
    expect((await raw(port, { headers: { Authorization: `Bearer ${token}` }, chunks: ["{"] })).status).toBe(400);
  });
  it("consumes pairing codes once, including concurrent duplicate attempts", async () => {
    const h = setup(), pairing = await h.bridge.pair();
    const responses = await Promise.all(Array.from({ length: 4 }, () => h.send("/pair", { code: pairing.code })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 403, 403, 403]);
    const reused = await h.send("/pair", { code: pairing.code });
    expect(reused.status).toBe(403);
    expect((await reused.json()).error).toMatch(/fresh code/);
    expect(h.vault.records.size).toBe(2);
  });
  it("allows at most five pairing submissions, counting malformed codes", async () => {
    const h = setup(), pairing = await h.bridge.pair();
    for (let i = 0; i < 5; i++) expect((await h.send("/pair", { code: "invalid" })).status).toBe(403);
    const exhausted = await h.send("/pair", { code: pairing.code });
    expect(exhausted.status).toBe(403);
    expect((await exhausted.json()).error).toMatch(/Too many pairing attempts/);
    expect(h.bridge.status().paired).toBe(false);
    const renewed = await h.bridge.pair();
    expect((await h.send("/pair", { code: renewed.code })).status).toBe(200);
  });
  it("expires codes after two minutes and invalidates earlier UI codes", async () => {
    const h = setup(), pairing = await h.bridge.pair();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 120_001);
    const expired = await h.send("/pair", { code: pairing.code });
    expect(expired.status).toBe(403);
    expect((await expired.json()).error).toMatch(/Pairing code expired.*fresh code/);
    clock.mockRestore();
    const old = await h.bridge.pair(), fresh = await h.bridge.pair();
    if (old.code !== fresh.code) expect((await h.send("/pair", { code: old.code })).status).toBe(403);
    expect((await h.send("/pair", { code: fresh.code })).status).toBe(200);
  });
  it("does not issue a new code when stop or revoke interrupts startup", async () => {
    for (const action of ["stop", "revoke"] as const) {
      const h = setup();
      const interrupted = expect(h.bridge.pair()).rejects.toThrow("interrupted");
      await h.bridge[action]();
      await interrupted;
      await h.bridge.start();
      expect((await h.send("/pair", { code: "000000" })).status).toBe(403);
    }
  });
  it("persists independent client tokens across instances and revokes all clients", async () => {
    const first = setup(), { token } = await first.pair();
    await first.bridge.stop();
    const next = setup(first.vault);
    expect(next.bridge.status().paired).toBe(true);
    await next.bridge.start();
    expect((await next.send("/discover", registration(), token)).status).toBe(200);
    const edge = await next.pair();
    expect(edge.token).not.toBe(token);
    const concurrent = await Promise.all([token, edge.token].map(client => next.send("/capture", capture(), client)));
    expect(concurrent.map(response => response.status)).toEqual([200, 200]);
    expect(next.onCapture).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next.bridge.status())).not.toContain(token);
    expect(JSON.stringify(next.bridge.status())).not.toContain(edge.token);
    await next.bridge.stop();
    const restarted = setup(first.vault);
    expect(restarted.bridge.status().paired).toBe(true);
    await restarted.bridge.start();
    for (const client of [token, edge.token])
      expect((await restarted.send("/discover", registration(), client)).status).toBe(200);
    const other = new BrowserBridge(first.vault, { extensionId: "a".repeat(32), changed: vi.fn(),
      onDiscover: vi.fn(), onCapture: vi.fn(), port: 0 });
    expect(other.status().paired).toBe(false);
    const unused = await restarted.bridge.pair();
    await restarted.bridge.revoke();
    expect(next.vault.records.size).toBe(0);
    expect(restarted.bridge.status().paired).toBe(false);
    for (const client of [token, edge.token])
      expect((await restarted.send("/discover", registration(), client)).status).toBe(401);
    expect((await restarted.send("/pair", { code: unused.code })).status).toBe(403);
  });
  it("preserves a legacy Chrome token before and after pairing Edge", async () => {
    const vault = new MemoryVault(), legacy = "a".repeat(64);
    vault.put("secrets", "browser-bridge-token", { extensionId, token: legacy });
    const h = setup(vault);
    expect(h.bridge.status()).toMatchObject({ running: false, paired: true });
    await h.bridge.start();
    expect((await h.send("/discover", registration(), legacy)).status).toBe(200);
    const edge = await h.pair();
    expect(edge.token).not.toBe(legacy);
    for (const client of [legacy, edge.token]) {
      expect((await h.send("/discover", registration(), client)).status).toBe(200);
      expect((await h.send("/capture", capture(), client)).status).toBe(200);
    }
    expect(vault.get("secrets", "browser-bridge-token")).toEqual({ extensionId, tokens: [legacy, edge.token] });
    await h.bridge.stop();
    const restarted = setup(vault);
    expect(restarted.bridge.status().paired).toBe(true);
    await restarted.bridge.start();
    for (const client of [legacy, edge.token])
      expect((await restarted.send("/discover", registration(), client)).status).toBe(200);
    await restarted.bridge.revoke();
    for (const client of [legacy, edge.token])
      expect((await restarted.send("/capture", capture(), client)).status).toBe(401);
  });
  it("rejects full client slots without evicting existing clients", async () => {
    const h = setup(), tokens: string[] = [];
    for (let i = 0; i < 7; i++) tokens.push((await h.pair()).token);
    const pending = await h.bridge.pair();
    // Another bridge instance fills the final slot after this code was issued.
    const other = setup(h.vault);
    tokens.push((await other.pair()).token);
    const stored = structuredClone(h.vault.get("secrets", "browser-bridge-token"));
    const full = await h.send("/pair", { code: pending.code });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: expect.stringMatching(/limit reached \(8 clients\).*Revoke all browser pairings/) });
    await expect(h.bridge.pair()).rejects.toThrow("Revoke all browser pairings");
    expect(h.vault.get("secrets", "browser-bridge-token")).toEqual(stored);
    expect(new Set(tokens).size).toBe(8);
    for (const token of tokens) expect((await h.send("/discover", registration(), token)).status).toBe(200);
    await h.bridge.revoke();
    expect(h.bridge.status().paired).toBe(false);
    for (const token of tokens) expect((await h.send("/discover", registration(), token)).status).toBe(401);
    await h.pair();
    expect(h.bridge.status().paired).toBe(true);
  });
  it("does not interrupt a Chrome capture when Edge pairs", async () => {
    const h = setup(), chrome = await h.pair();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.onCapture.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    const pending = h.send("/capture", capture(), chrome.token);
    await started;
    const edge = await h.pair();
    release();
    expect((await pending).status).toBe(200);
    expect((await h.send("/capture", capture(), edge.token)).status).toBe(200);
  });
  it("normalizes identity claims, strictly returns access, and accepts both capture kinds", async () => {
    const h = setup(), { token } = await h.pair();
    const response = await h.send("/discover", { ...registration(), accountEmail: " SYNTHETIC@EXAMPLE.ORG " }, token);
    expect(await response.json()).toEqual({
      accountId: "synthetic-id",
      enabled: false,
      refreshIntervalSeconds: 60,
      backgroundCapture: false,
    });
    expect(h.onDiscover.mock.calls[0][0].accountEmail).toBe("synthetic@example.org");
    for (const payload of [capture(), calendar()]) {
      const result = await h.send("/capture", payload, token);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ accepted: true });
    }
    expect(h.onCapture).toHaveBeenCalledTimes(2);
    expect(h.bridge.status().lastCapture).toMatch(/^\d{4}-/);
  });
  it("adds refresh metadata to discovery and exposes hashed browser client summaries", async () => {
    const h = setup(new MemoryVault(), {
      refreshSettings: () => ({ intervalSeconds: 300, paused: false, backgroundCapture: true }),
    });
    const { token } = await h.pair();
    h.bridge.requestRefresh();
    const response = await h.send("/discover", registration(), token, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0"
    });
    expect(await response.json()).toEqual({
      accountId: "synthetic-id",
      enabled: false,
      refreshIntervalSeconds: 300,
      backgroundCapture: true,
      refreshRequestedAt: expect.any(Number),
    });
    expect(h.bridge.status().clients).toEqual([{
      id: expect.any(String),
      browser: "edge",
      lastSeenAt: expect.any(String),
      discoveredAccountIds: ["synthetic-id"],
    }]);
    expect(JSON.stringify(h.bridge.status())).not.toContain(token);
  });
  it("defaults background capture off and only accepts the trusted settings boolean", async () => {
    const invalid = setup(new MemoryVault(), {
      refreshSettings: () => ({ intervalSeconds: 60, paused: false, backgroundCapture: "true" as unknown as boolean }),
    });
    const first = await invalid.pair();
    expect(await (await invalid.send("/discover", registration(), first.token)).json()).toMatchObject({
      backgroundCapture: false,
    });

    const injected = setup();
    const second = await injected.pair();
    const response = await injected.send("/discover", { ...registration(), backgroundCapture: true }, second.token);
    expect(response.status).toBe(400);
    expect(injected.onDiscover).not.toHaveBeenCalled();
  });
  it("enforces 2MiB in bytes for content-length and chunked bodies", async () => {
    const h = setup(), { port, token } = await h.pair();
    const headers = { Authorization: `Bearer ${token}` };
    const body = JSON.stringify({ ...capture(), accountName: "x".repeat(2 * 1024 * 1024) });
    const declared = await raw(port, { path: "/capture", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) }, chunks: [body] });
    expect(declared.status).toBe(413);
    const chunked = await raw(port, { path: "/capture", headers, chunks: [
      '{"body":"', ...Array.from({ length: 34 }, () => "\u00e9".repeat(32 * 1024)), '"}',
    ] });
    expect(chunked.status).toBe(413);
    expect(h.onCapture).not.toHaveBeenCalled();
  });
  it("rejects duplicate Origin and Authorization headers", async () => {
    const h = setup(), { port, token } = await h.pair();
    for (const duplicate of [`Origin: ${origin}`, `Authorization: Bearer ${token}`]) {
      const result = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", data => { response += data; });
        socket.once("error", reject);
        socket.once("end", () => resolve(response));
        socket.once("connect", () => socket.end(
          `POST /discover HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\n` +
          `Authorization: Bearer ${token}\r\n${duplicate}\r\nContent-Type: application/json\r\n` +
          `Content-Length: 2\r\nConnection: close\r\n\r\n{}`,
        ));
      });
      expect(result).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(h.onDiscover).not.toHaveBeenCalled();
  });
  it("accepts the documented message and meeting count boundaries", async () => {
    const h = setup(), { token } = await h.pair();
    const mail = capture(), meetings = calendar();
    mail.messages = Array.from({ length: 200 }, (_, i) => ({ ...mail.messages[0], id: `message-${i}` }));
    meetings.meetings = Array.from({ length: 100 }, (_, i) => ({ ...meetings.meetings[0], id: `meeting-${i}` }));
    expect((await h.send("/capture", mail, token)).status).toBe(200);
    expect((await h.send("/capture", meetings, token)).status).toBe(200);
    expect(h.onCapture).toHaveBeenCalledTimes(2);
  });
  it.each([
    "http://mail.google.com/mail/u/0/#inbox", "https://mail.google.com.evil.example/mail/u/0/",
    "https://evil.example/mail/u/0/", "https://mail.google.com:444/mail/u/0/",
    "https://user:password@mail.google.com/mail/u/0/", "javascript:alert(1)",
    "https://mail.google.com/mailbox/u/0/", "https://calendar.google.com/calendar/u/0/",
    "https://mail.google.com/mail/u/0/?authuser=1", "https://mail.google.com/mail/u/0/?authuser=0&authuser=1",
    "https://mail.google.com/mail/u/0/?authuser=other@example.org",
    "https://mail.google.com/mail/u/%31/", "https://mail.google.com/mail/u/not-an-index/",
    "https://mail.google.com\\@evil.example/mail/u/0/",
  ])("rejects unsafe page URL %s", async pageUrl => {
    const h = setup(), { token } = await h.pair();
    expect((await h.send("/discover", { ...registration(), pageUrl }, token)).status).toBe(400);
    expect(h.onDiscover).not.toHaveBeenCalled();
  });
  it("enforces source provider and account boundaries with explicit authuser mapping", async () => {
    const h = setup(), { token } = await h.pair();
    for (const url of [
      "https://mail.google.com/mail/u/1/#inbox/thread-1",
      "https://mail.google.com/mail/?authuser=1#inbox/thread-1",
      "https://mail.google.com/mail/?authuser=other@example.org#inbox/thread-1",
      "https://calendar.google.com/calendar/u/0/r/eventedit/id",
      "http://mail.google.com/mail/u/0/#inbox/thread-1", "https://evil.example",
    ]) {
      const payload = capture(); payload.messages[0].url = url;
      expect((await h.send("/capture", payload, token)).status).toBe(400);
    }
    const mapped = capture();
    mapped.messages[0].url = "https://mail.google.com/mail/?authuser=0#inbox/thread-1";
    expect((await h.send("/capture", mapped, token)).status).toBe(200);
    mapped.pageUrl = "https://mail.google.com/mail/?authuser=synthetic@example.org#inbox";
    mapped.messages[0].url = "https://mail.google.com/mail/?authuser=synthetic@example.org#inbox/thread-1";
    expect((await h.send("/capture", mapped, token)).status).toBe(200);
    mapped.messages[0].url = capture().messages[0].url;
    expect((await h.send("/capture", mapped, token)).status).toBe(400);
  });
  it("rejects wrong kinds, non-Meet links, malformed dates and all unknown fields", async () => {
    const h = setup(), { token } = await h.pair();
    const variants: unknown[] = [
      { ...capture(), injected: "private" }, { ...capture(), accountEmail: "not-email" },
      { ...capture(), messages: [{ ...capture().messages[0], injected: true }] },
      { ...capture(), messages: [{ ...capture().messages[0], unread: "true" }] },
      { ...capture(), messages: [{ ...capture().messages[0], receivedAt: "2026-02-30T12:00:00Z" }] },
      { ...capture(), messages: [{ ...capture().messages[0], receivedAt: "yesterday" }] },
      { ...capture(), messages: Array.from({ length: 201 }, () => capture().messages[0]) },
      { ...calendar(), meetings: Array.from({ length: 101 }, () => calendar().meetings[0]) },
      { ...capture(), meetings: calendar().meetings },
      { ...calendar(), messages: capture().messages },
      ...["https://evil.example", "http://meet.google.com/abc", "https://meet.google.com.evil.example/abc",
        "https://name@meet.google.com/abc", "javascript:alert(1)"].map(meetingUrl =>
        ({ ...calendar(), meetings: [{ ...calendar().meetings[0], meetingUrl }] })),
    ];
    for (const payload of variants) expect((await h.send("/capture", payload, token)).status).toBe(400);
    expect((await h.send("/discover", capture(), token)).status).toBe(400);
    expect(h.onCapture).not.toHaveBeenCalled();
    expect(h.bridge.status().lastCapture).toBeUndefined();
  });
  it("never acknowledges failed callbacks or exposes private error details", async () => {
    const h = setup(), { token } = await h.pair();
    h.onDiscover.mockRejectedValue(new Error("synthetic-secret@example.org: private"));
    const discover = await h.send("/discover", registration(), token);
    expect(discover.status).toBe(409);
    expect(await discover.text()).toBe('{"error":"Browser request could not be completed."}');
    h.onCapture.mockRejectedValue(new Error("Select this account's source in Relay Desk first."));
    const denied = await h.send("/capture", capture(), token);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Select this account's source in Relay Desk first." });
    expect(h.bridge.status().lastCapture).toBeUndefined();
    expect(JSON.stringify(h.bridge.status())).not.toContain("private");
  });
  it("rate limits floods without invoking callbacks", async () => {
    const h = setup();
    await h.bridge.start();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (let i = 0; i < 120; i++) expect((await h.send("/discover", registration())).status).toBe(401);
    expect((await h.send("/discover", registration())).status).toBe(429);
    expect(h.onDiscover).not.toHaveBeenCalled();
  });
  it("bounds callback concurrency and refuses buffered requests after revocation", async () => {
    const h = setup(), { token, port } = await h.pair();
    let release!: () => void, allEntered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { allEntered = resolve; });
    let count = 0;
    h.onCapture.mockImplementation(async () => { if (++count === 8) allEntered(); await gate; });
    const requests = Array.from({ length: 8 }, () => h.send("/capture", capture(), token));
    await entered;
    expect((await h.send("/capture", capture(), token)).status).toBe(429);
    release();
    expect((await Promise.all(requests)).every(response => response.status === 200)).toBe(true);
    const slow = httpRequest({ hostname: "127.0.0.1", port, path: "/capture", method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const disconnected = new Promise<void>(resolve => { slow.once("error", () => resolve()); });
    slow.write('{"accountEmail":');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    await h.bridge.revoke();
    await disconnected;
    slow.destroy();
    expect(h.onCapture).toHaveBeenCalledTimes(8);
    expect(h.bridge.status().lastCapture).toBeUndefined();
  });
  it("drops in-flight responses on revoke and closes incomplete/keepalive connections on stop", async () => {
    const h = setup(), { token, port } = await h.pair();
    const edge = await h.pair();
    let release!: () => void, entered!: () => void, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.onCapture.mockImplementation(async () => { if (++count === 2) entered(); await gate; });
    const inflight = Promise.all([token, edge.token].map(client =>
      h.send("/capture", capture(), client).then(() => "acknowledged", () => "disconnected")));
    await started;
    await h.bridge.revoke();
    expect(await inflight).toEqual(["disconnected", "disconnected"]);
    release();
    expect(h.bridge.status().lastCapture).toBeUndefined();
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`POST /pair HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await Promise.all([h.bridge.stop(), h.bridge.stop(), closed]);
    expect(h.bridge.status().running).toBe(false);
    await h.bridge.start();
    expect(h.bridge.status().running).toBe(true);
  });
});
