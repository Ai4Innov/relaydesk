import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PlaywrightMailBrowser, PlaywrightMailError } from "../src/main/browser/playwright-mail";

const request = { accountId: "test-account", accountEmail: "owner@example.org", threadId: "18abc" };
const refreshRequest = { ...request, threadId: "__relay_inbox__", inboxRefresh: true as const };
const originalLaunch = chromium.launchPersistentContext.bind(chromium);
const installedChannel = existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") ? "chrome" :
  existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe") ? "msedge" : undefined;
const contexts: BrowserContext[] = [];
const profiles: string[] = [];
const header = (email: string) => `<header id="gb" role="banner"><a href="https://accounts.google.com/"
  aria-label="Google Account: Owner (${email})">Account</a></header>`;
interface FixtureOptions {
  email?: string; wrongThread?: boolean; clipped?: boolean; collapsedOnly?: boolean;
  refresh?: "loading" | "response" | "heartbeat" | "offline" | "empty";
}
function fixture(options: FixtureOptions = {}): string {
  const body = `<h2 class="hP" data-legacy-thread-id="18abc">Complete subject</h2>
    ${options.collapsedOnly ? "" : '<div role="toolbar"><button aria-label="Expand all" id="expand">Expand all</button></div>'}
    <div data-legacy-message-id="message1" data-legacy-thread-id="18abc">
      <span class="gD" email="sender@example.org">Sender</span><span class="g2" email="owner@example.org">Owner</span>
      <span class="g3" title="Original date: Friday 25 September">Yesterday</span>
      <div class="a3s"><p>The <b>complete</b> first message.</p><button aria-label="Expand all" id="hostile">Untrusted content button</button></div>
    </div>
    <div data-legacy-message-id="message2" data-legacy-thread-id="18abc">
      <div class="aju" aria-expanded="false">Second message header</div>
      <span class="gD" email="other@example.org">Other</span><time>Original second date</time>
      <div class="a3s" hidden><p>The complete second <strong>body</strong>.</p></div>
    </div>${options.clipped ? '<a href="?view=entire">View entire message</a>' : ""}`;
  return `<!doctype html><html><body>${header(options.email || request.accountEmail)}
    <button id="delete" onclick="window.dangerous++">Delete</button>
    <main role="main"><div role="toolbar"><button aria-label="Refresh" id="refresh">Refresh</button></div>
      <table><tbody><tr class="zA zE" data-legacy-thread-id="${options.wrongThread ? "other-thread" : request.threadId}">
        <td><span email="sender@example.org">Sender</span></td><td><span class="bog">Complete subject</span>
        <span class="y2">Only the preview</span></td><td class="xW" title="Original inbox date">Yesterday</td>
      </tr></tbody></table>
    </main><script>
    history.replaceState(null, "", "/mail/u/0/#inbox");
    window.nativeEvents = []; window.dangerous = 0; window.refreshes = 0;
    HTMLElement.prototype.click = function () { throw new Error("DOM click is forbidden in this fixture"); };
    const main = document.querySelector("main");
    const row = document.querySelector(".bog");
    let down = false, up = false;
    row.addEventListener("mousedown", e => { down = e.isTrusted; window.nativeEvents.push(["row-down", e.isTrusted]); });
    row.addEventListener("mouseup", e => { up = e.isTrusted; window.nativeEvents.push(["row-up", e.isTrusted]); });
    row.addEventListener("click", e => {
      window.nativeEvents.push(["row-click", e.isTrusted]);
      if (!e.isTrusted || !down || !up) return;
      history.replaceState(null, "", "#inbox/FMopaqueNativeRoute");
      main.innerHTML = ${JSON.stringify(body)};
      const expand = () => {
        main.querySelector("[hidden]").removeAttribute("hidden");
        main.querySelector(".aju").setAttribute("aria-expanded", "true");
      };
      main.querySelector("#hostile").addEventListener("click", () => window.dangerous++);
      main.querySelector("#expand")?.addEventListener("click", e => {
        window.nativeEvents.push(["expand-click", e.isTrusted]); if (e.isTrusted) expand();
      });
      main.querySelector(".aju").addEventListener("click", e => {
        window.nativeEvents.push(["header-click", e.isTrusted]); if (e.isTrusted) expand();
      });
    });
    const refresh = document.querySelector("#refresh");
    refresh.addEventListener("mouseup", e => {
      if (!e.isTrusted) return;
      window.refreshes++;
      window.nativeEvents.push(["refresh-up", e.isTrusted]);
      const mode = ${JSON.stringify(options.refresh || "loading")};
      if (mode === "response") { fetch("/sync/u/0/i/bv", {method:"POST"}); return; }
      if (mode === "offline") {
        const alert = document.createElement("div"); alert.setAttribute("role", "alert");
        alert.textContent = "Unable to connect"; document.body.append(alert); return;
      }
      if (mode === "heartbeat") {
        const alert = document.createElement("div"); alert.setAttribute("role", "status");
        alert.textContent = "Heartbeat"; document.body.append(alert);
        setInterval(() => alert.textContent = "Heartbeat " + Date.now(), 40); return;
      }
      refresh.setAttribute("aria-disabled", "true"); main.setAttribute("aria-busy", "true");
      setTimeout(() => {
        if (mode === "empty") main.querySelector("tbody").innerHTML = '<tr><td class="TC">Your inbox is empty.</td></tr>';
        refresh.setAttribute("aria-disabled", "false"); main.removeAttribute("aria-busy");
      }, 120);
    });
    </script></body></html>`;
}

async function harness(options: FixtureOptions = {}) {
  const profile = resolve(".playwright-mail-tests", randomUUID());
  await mkdir(profile, { recursive: true }); profiles.push(profile);
  let context: BrowserContext | undefined;
  const launch = vi.spyOn(chromium, "launchPersistentContext").mockImplementation(async (directory, settings) => {
    // Production launch arguments are asserted below. Fixture execution is
    // headless and all requests are intercepted; no real Google account is used.
    context = await originalLaunch(directory, { ...settings, channel: installedChannel, headless: true });
    contexts.push(context);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://mail.google.com") return route.abort();
      if (url.pathname === "/sync/u/0/i/bv") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      if (url.pathname === "/mail/" || url.pathname === "/mail/u/0/")
        return route.fulfill({ status: 200, contentType: "text/html", body: fixture(options) });
      return route.abort();
    });
    return context;
  });
  const driver = new PlaywrightMailBrowser({ profileDirectory: profile, extensionDirectory: resolve("browser-extension") });
  return { driver, launch, context: () => context!, reader: () => context!.pages()[1] };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(contexts.splice(0).map(context => context.close().catch(() => undefined)));
  vi.restoreAllMocks();
  await Promise.all(profiles.splice(0).map(profile => rm(profile, { recursive: true, force: true })));
});
afterAll(async () => { await rmdir(resolve(".playwright-mail-tests")).catch(() => undefined); });

// Real browser launches can take well over the default 15 s on shared CI runners.
describe.skipIf(!installedChannel)("managed Playwright Gmail: isolated real browser DOM", { timeout: 60_000 }, () => {
  it("reports Google's automated-browser rejection and does not open more tabs or retry login", async () => {
    const h = await harness();
    await h.driver.open(request.accountEmail);
    await h.context().route("https://accounts.google.com/**", route => route.fulfill({
      contentType: "text/html", body: '<main><h1>Could not sign you in</h1><div><span>This browser or app may not be secure. Try using a different browser.</span></div></main>'
    }));
    await h.context().pages()[0].goto("https://accounts.google.com/v3/signin/rejected");
    await expect(h.driver.open(request.accountEmail)).rejects.toMatchObject({ code: "sign-in-blocked" });
    expect(h.driver.status().error).toContain("OAuth flow in your normal browser");
    expect(h.context().pages()).toHaveLength(1);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(h.driver.readMailThread(request, () => {})).rejects.toMatchObject({ code: "sign-in-blocked" });
    expect(h.context().pages()).toHaveLength(1);
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.launch.mock.calls[0][1]).not.toHaveProperty("ignoreDefaultArgs");
    expect(h.launch.mock.calls[0][1]).not.toHaveProperty("args");
  }, 60_000);

  it("detects a rejection shown after the user opens the sign-in window", async () => {
    const h = await harness();
    await h.driver.open(request.accountEmail);
    await h.context().route("https://accounts.google.com/**", route => route.fulfill({
      contentType: "text/html", body: '<h1>Could not sign you in</h1><div id="headingSubtext">This browser or app may not be secure.</div>'
    }));
    await h.context().pages()[0].goto("https://accounts.google.com/v3/signin/rejected");
    await expect(h.driver.readMailThread(request, () => {})).rejects.toMatchObject({ code: "sign-in-blocked" });
    expect(h.context().pages()).toHaveLength(1);
  }, 60_000);

  it("does not treat mailbox content as a Google sign-in rejection", async () => {
    const h = await harness();
    await h.driver.open(request.accountEmail);
    await h.context().pages()[0].evaluate(() => {
      const heading = document.createElement("h1");
      heading.textContent = "This browser or app may not be secure.";
      document.body.append(heading);
    });
    expect((await h.driver.readMailThread(request, () => {})).messages).toHaveLength(2);
  }, 60_000);

  it("uses real exact-row and Expand all clicks, returns every full HTML body and preserves the sign-in page", async () => {
    const h = await harness();
    await h.driver.open(request.accountEmail);
    const original = h.context().pages()[0], originalUrl = original.url(), originalHTML = await original.content();
    const authorize = vi.fn();
    const capture = await h.driver.readMailThread(request, authorize);
    expect(h.launch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      channel: "chrome", headless: false, chromiumSandbox: true, acceptDownloads: false,
    }));
    expect(capture.accountEmail).toBe(request.accountEmail);
    expect(capture.pageUrl).toBe("https://mail.google.com/mail/u/0/#inbox/FMopaqueNativeRoute");
    expect(capture.messages).toHaveLength(2);
    expect(capture.messages[0]).toMatchObject({
      id: "message1", threadId: request.threadId, completeness: "full",
      body: expect.stringContaining("The complete first message."),
      html: expect.stringContaining("<b>complete</b>"), dateText: "Original date: Friday 25 September",
    });
    expect(capture.messages[1]).toMatchObject({ id: "message2", html: expect.stringContaining("<strong>body</strong>"),
      dateText: "Original second date", completeness: "full" });
    expect(capture.messages.every(message => message.receivedAt === undefined)).toBe(true);
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(await h.reader().evaluate("window.nativeEvents")).toEqual([
      ["row-down", true], ["row-up", true], ["row-click", true], ["expand-click", true],
    ]);
    expect(await h.reader().evaluate("window.dangerous")).toBe(0);
    expect(original.url()).toBe(originalUrl);
    expect(await original.content()).toBe(originalHTML);
    const reader = h.reader();
    await h.driver.readMailThread(request, () => {});
    expect(h.reader()).toBe(reader);
    expect(h.context().pages()).toHaveLength(2);
    await h.driver.close();
    expect(h.driver.status().running).toBe(false);
  }, 20_000);

  it("clicks only verified collapsed headers when no Expand all control exists", async () => {
    const h = await harness({ collapsedOnly: true });
    const capture = await h.driver.readMailThread(request, () => {});
    expect(capture.messages).toHaveLength(2);
    expect(await h.reader().evaluate("window.nativeEvents")).toContainEqual(["header-click", true]);
    expect(await h.reader().evaluate("window.dangerous")).toBe(0);
  }, 60_000);

  it("rejects a different signed-in account despite the requested authuser hint", async () => {
    const h = await harness({ email: "other@example.org" });
    await expect(h.driver.readMailThread(request, () => {})).rejects.toMatchObject({ code: "account-mismatch" });
    expect(await h.reader().evaluate("window.nativeEvents")).toEqual([]);
    expect(h.driver.status().error).not.toContain("other@example.org");
  }, 60_000);

  it("rechecks the exact row after desktop authorization instead of clicking a changed row", async () => {
    const h = await harness();
    let checks = 0;
    await expect(h.driver.readMailThread(request, async () => {
      if (++checks === 2) await h.reader().evaluate(() => {
        document.querySelector("[data-legacy-thread-id]")!.setAttribute("data-legacy-thread-id", "different-thread");
      });
    })).rejects.toMatchObject({ code: "interrupted" });
    expect(await h.reader().evaluate("window.nativeEvents")).toEqual([]);
  }, 60_000);

  it("explicitly rejects clipped full-message bodies rather than returning partial success", async () => {
    const h = await harness({ clipped: true });
    await expect(h.driver.readMailThread(request, () => {})).rejects.toMatchObject({ code: "partial" });
  }, 60_000);

  it("checks account identity again after final desktop authorization", async () => {
    const h = await harness();
    let checks = 0;
    await expect(h.driver.readMailThread(request, async () => {
      if (++checks === 4) await h.reader().evaluate(() =>
        document.querySelector("#gb a")!.setAttribute("aria-label", "Google Account: Other (other@example.org)"));
    })).rejects.toMatchObject({ code: "account-mismatch" });
  }, 60_000);

  it("reverifies the native thread proof after final desktop authorization", async () => {
    const h = await harness();
    let checks = 0;
    await expect(h.driver.readMailThread(request, async () => {
      if (++checks === 4) await h.reader().evaluate(() =>
        document.querySelector("h2[data-legacy-thread-id]")!.setAttribute("data-legacy-thread-id", "other-thread"));
    })).rejects.toMatchObject({ code: "thread-mismatch" });
  }, 60_000);

  it.each(["loading", "response", "empty"] as const)(
    "refreshes through real mouseup and verifies the %s inbox completion", async refresh => {
      const h = await harness({ refresh });
      const capture = await h.driver.readMailThread(refreshRequest, () => {});
      expect(capture.pageUrl).toBe("https://mail.google.com/mail/u/0/#inbox");
      expect(capture.messages).toHaveLength(refresh === "empty" ? 0 : 1);
      if (capture.messages.length) expect(capture.messages[0].completeness).toBe("preview");
      expect(await h.reader().evaluate("window.nativeEvents")).toEqual([["refresh-up", true]]);
      expect(await h.reader().evaluate("window.dangerous")).toBe(0);
    }, 15_000,
  );

  it("does not count a status heartbeat as a successful inbox refresh", async () => {
    const h = await harness({ refresh: "heartbeat" }), controller = new AbortController();
    const read = h.driver.readMailThread(refreshRequest, () => {}, controller.signal).catch(error => error);
    await vi.waitFor(async () => expect(await h.reader()?.evaluate("window.refreshes")).toBe(1), { timeout: 8_000 });
    let settled = false;
    void read.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 1_800));
    expect(settled).toBe(false);
    const signIn = h.context().pages()[0];
    controller.abort();
    expect(await read).toMatchObject({ code: "interrupted" });
    await vi.waitFor(() => expect(h.context().pages()).toHaveLength(1));
    expect(signIn.isClosed()).toBe(false);
  }, 60_000);

  it("fails an offline refresh without returning stale rows", async () => {
    const h = await harness({ refresh: "offline" });
    await expect(h.driver.readMailThread(refreshRequest, () => {})).rejects.toMatchObject({ code: "unavailable" });
  }, 60_000);

  it("preserves a dirty reader, bounds owned tabs, and never navigates its draft", async () => {
    const h = await harness();
    await h.driver.readMailThread(request, () => {});
    const first = h.reader();
    await first.evaluate(() => {
      const draft = document.createElement("textarea"); draft.value = "Do not discard this draft"; document.body.append(draft);
    });
    await h.driver.readMailThread(request, () => {});
    expect(h.context().pages()).toHaveLength(3);
    expect(await first.locator("textarea").inputValue()).toBe("Do not discard this draft");
    const second = h.context().pages()[2];
    await second.evaluate(() => {
      const draft = document.createElement("div"); draft.contentEditable = "true"; draft.textContent = "Another draft"; document.body.append(draft);
    });
    await expect(h.driver.readMailThread(request, () => {})).rejects.toMatchObject({ code: "busy" });
    await expect(h.driver.close()).rejects.toMatchObject({ code: "busy" });
    expect(h.context().pages()).toHaveLength(3);
    expect(first.isClosed()).toBe(false);
  }, 20_000);

  it("preserves a reader manually navigated between operations", async () => {
    const h = await harness();
    await h.driver.readMailThread(request, () => {});
    const originalReader = h.reader();
    const originalEvents = await originalReader.evaluate("window.nativeEvents");
    await originalReader.goto("https://mail.google.com/mail/u/0/#inbox");
    await h.driver.readMailThread(request, () => {});
    expect(h.context().pages()).toHaveLength(3);
    expect(originalReader.url()).toBe("https://mail.google.com/mail/u/0/#inbox");
    expect(await originalReader.evaluate("window.nativeEvents")).toEqual(originalEvents);
  }, 20_000);

  it("does not navigate or close an unrelated user-created browser tab", async () => {
    const h = await harness();
    await h.driver.open(request.accountEmail);
    const userPage = await h.context().newPage();
    await userPage.goto("https://mail.google.com/mail/u/0/#inbox");
    const originalHTML = await userPage.content();
    await h.driver.readMailThread(request, () => {});
    expect(h.context().pages()).toHaveLength(3);
    expect(userPage.url()).toBe("https://mail.google.com/mail/u/0/#inbox");
    expect(await userPage.content()).toBe(originalHTML);
    await expect(h.driver.close()).rejects.toMatchObject({ code: "busy" });
    expect(userPage.isClosed()).toBe(false);
  }, 60_000);

  it("cancels clean operation pages while leaving separate sign-in and user pages alone", async () => {
    const h = await harness({ wrongThread: true }), controller = new AbortController();
    await h.driver.open(request.accountEmail);
    const signIn = h.context().pages()[0];
    const read = h.driver.readMailThread(request, () => {}, controller.signal).catch(error => error);
    await vi.waitFor(async () => expect(await h.reader()?.locator(".bog").count()).toBe(1), { timeout: 8_000 });
    controller.abort();
    expect(await read).toMatchObject({ code: "interrupted" });
    await vi.waitFor(() => expect(h.context().pages()).toHaveLength(1));
    expect(signIn.isClosed()).toBe(false);
    expect(await signIn.evaluate("window.nativeEvents")).toEqual([]);
  }, 60_000);

  it("does not close or reuse a reader after real user input interrupts its operation", async () => {
    const h = await harness({ wrongThread: true }), controller = new AbortController();
    const read = h.driver.readMailThread(request, () => {}, controller.signal).catch(error => error);
    await vi.waitFor(async () => expect(await h.reader()?.locator(".bog").count()).toBe(1), { timeout: 8_000 });
    const reader = h.reader();
    await reader.evaluate(() => {
      const draft = document.createElement("textarea"); draft.id = "user-draft"; document.body.append(draft);
    });
    await reader.locator("#user-draft").fill("Keep my draft");
    controller.abort();
    expect(await read).toMatchObject({ code: "interrupted" });
    expect(reader.isClosed()).toBe(false);
    expect(await reader.locator("#user-draft").inputValue()).toBe("Keep my draft");
    await expect(h.driver.close()).rejects.toMatchObject({ code: "busy" });
  }, 60_000);
});

describe("managed Gmail launch, cancellation and error contracts", () => {
  function driver() {
    return new PlaywrightMailBrowser({ profileDirectory: resolve(".playwright-mail-tests", randomUUID()),
      extensionDirectory: resolve("browser-extension") });
  }

  it("never launches or fabricates success for unsupported attachment downloads", async () => {
    const launch = vi.spyOn(chromium, "launchPersistentContext");
    await expect(driver().readMailThread({ ...request, attachment: {
      metadataId: "file1", name: "report.pdf", relativePath: "RelayDesk/test/report.pdf", maxBytes: 1024,
    } }, () => {})).rejects.toMatchObject({ code: "attachment-unavailable" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses Edge only when Chrome's executable is absent and never on policy/profile failures", async () => {
    const launch = vi.spyOn(chromium, "launchPersistentContext")
      .mockRejectedValueOnce(new Error("Chromium distribution 'chrome' is not found at executable"))
      .mockRejectedValueOnce(new Error("Chromium distribution 'msedge' is not found at executable"));
    await expect(driver().open(request.accountEmail)).rejects.toMatchObject({ code: "browser-missing" });
    expect(launch.mock.calls.map(call => call[1]?.channel)).toEqual(["chrome", "msedge"]);
    launch.mockClear().mockRejectedValue(new Error("Profile locked: private-account@example.org secret details"));
    const blocked = driver();
    await expect(blocked.open(request.accountEmail)).rejects.toMatchObject({ code: "unavailable" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(blocked.status().error).not.toContain("private-account");
    expect(blocked.status().error).not.toContain("secret");
  });

  it("applies the 90-second deadline from enqueue, including queued authorization waits", async () => {
    vi.useFakeTimers();
    const browser = driver(), authorize = vi.fn(() => new Promise<void>(() => {}));
    const first = browser.readMailThread(request, authorize).catch(error => error);
    const secondAuthorize = vi.fn();
    const second = browser.readMailThread(request, secondAuthorize).catch(error => error);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(await first).toBeInstanceOf(PlaywrightMailError);
    expect(await first).toMatchObject({ code: "expired" });
    expect(await second).toMatchObject({ code: "expired" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(secondAuthorize).not.toHaveBeenCalled();
    await browser.close();
  });

  it("rejects already cancelled reads before authorizing or launching", async () => {
    const controller = new AbortController(); controller.abort();
    const authorize = vi.fn(), launch = vi.spyOn(chromium, "launchPersistentContext");
    await expect(driver().readMailThread(request, authorize, controller.signal)).rejects.toMatchObject({ code: "interrupted" });
    expect(authorize).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
