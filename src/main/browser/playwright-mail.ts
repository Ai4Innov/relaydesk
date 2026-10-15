import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { chromium, type BrowserContext, type ElementHandle, type Page, type Request, type Response } from "playwright-core";
import type { BrowserCapture, BrowserRegistration } from "../../shared/browser";
import type { BrowserMailRequest } from "../../shared/browser-mail";

type Failure = "unavailable" | "browser-missing" | "sign-in-required" | "sign-in-blocked" | "account-mismatch" |
  "thread-mismatch" | "unsupported" | "partial" | "interrupted" | "expired" | "busy" |
  "attachment-unavailable";
const messages: Record<Failure, string> = {
  unavailable: "The managed Gmail browser is unavailable. Open it and sign in normally, then retry.",
  "browser-missing": "Install Google Chrome or Microsoft Edge to use the Gmail browser fallback.",
  "sign-in-required": "Sign in normally in the managed Gmail browser. Sign-in challenges must be completed manually.",
  "sign-in-blocked": "Google blocked sign-in in this automated browser. Retrying Playwright or changing your password will not resolve this restriction. Connect Gmail API using Google's OAuth flow in your normal browser; select Inbox afterwards. Do not disable browser security or copy cookies.",
  "account-mismatch": "The managed browser's Google header does not match the requested account. No message was captured.",
  "thread-mismatch": "Gmail did not verify the exact requested conversation. No message was captured.",
  unsupported: "This Gmail view cannot be read safely. Use the Gmail API or open the message manually.",
  partial: "Gmail did not expose stable, complete message bodies (possibly clipped or still loading). No full message was captured.",
  interrupted: "The Gmail browser read was cancelled or interrupted by user interaction.",
  expired: "The Gmail browser request expired. No successful read was reported.",
  busy: "The managed browser has user-controlled pages. Finish or close them before trying again.",
  "attachment-unavailable": "Managed-browser attachment downloads are not supported. Configure the Gmail API or import a manually downloaded file.",
};

export class PlaywrightMailError extends Error {
  constructor(readonly code: Failure) { super(messages[code]); this.name = "PlaywrightMailError"; }
}

interface PlaywrightMailBrowserOptions {
  /** Must be a dedicated directory under app.userData, never a personal browser profile. */
  profileDirectory: string;
  extensionDirectory: string;
  changed?: () => void;
}
interface RowProof {
  threadId: string; inboxUrl: string; providerThreadId?: string; targetUrl?: string;
  clicked?: boolean; conversationUrl?: string;
}
interface Extractors {
  visible(element: Element): boolean;
  verifyMailAccount(document: Document, url: string, input: BrowserMailRequest): BrowserRegistration;
  exactMailRow(document: Document, url: string, input: BrowserMailRequest): { element: HTMLElement; proof: RowProof } | undefined;
  verifyMailRequest(document: Document, url: string, input: BrowserMailRequest, proof: RowProof): Element;
  mailExpandAllControl(document: Document, url: string, input: BrowserMailRequest, proof: RowProof): HTMLElement | undefined;
  collapsedMailHeaders(document: Document, url: string, input: BrowserMailRequest, proof: RowProof): HTMLElement[];
  mail(document: Document, url: string, input?: BrowserMailRequest, proof?: RowProof): Pick<BrowserCapture, "messages" | "meetings">;
}
interface PageGuard {
  dirty: boolean;
  expected?: Element;
  expires: number;
  events: string[];
  refresh?: { loadingSeen: boolean; observer: MutationObserver; busy: () => boolean };
}
type MailWindow = Window & { RelayExtractors: Extractors; __relayMailGuard: PageGuard };
const MAX_PAGES = 3;
const DEADLINE_MS = 90_000;
const POLL_MS = 350;

function installGuard(): void {
  const host = window as unknown as MailWindow;
  if (host.__relayMailGuard) return;
  const guard: PageGuard = { dirty: false, expires: 0, events: [] };
  host.__relayMailGuard = guard;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "keydown", "input", "submit", "wheel"]) {
    document.addEventListener(type, event => {
      if (!event.isTrusted) return;
      // Playwright native mouse events are trusted too. Permit only the expected
      // target and one mouse sequence; typing, scrolling and other targets interrupt.
      const allowed = guard.expected && performance.now() < guard.expires &&
        event.composedPath().includes(guard.expected) && guard.events[0] === type;
      if (allowed) guard.events.shift();
      else guard.dirty = true;
    }, true);
  }
}

function dirtyPage(): boolean {
  const host = window as unknown as MailWindow;
  if (host.__relayMailGuard?.dirty) return true;
  return [...document.querySelectorAll<HTMLElement>("textarea, [contenteditable='true'], input:not([type='hidden'])")]
    .some(node => {
      if (node.closest("#gb, .a3s, .ii")) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0 &&
        (node.isContentEditable || Boolean((node as HTMLInputElement).value));
    });
}

function failure(error: unknown): PlaywrightMailError {
  if (error instanceof PlaywrightMailError) return error;
  // Never expose Playwright errors: they can contain URLs, selectors or page text.
  const value = error instanceof Error ? error.message : "";
  const detail = value.split("\n", 1)[0].replace(/^(?:page|elementHandle)\.evaluate(?:Handle)?: Error: /, "");
  const code = Object.keys(messages).find(key => detail === key);
  return new PlaywrightMailError(code as Failure || "unavailable");
}

/** Visible, dedicated persistent Chromium session. No personal-profile or cookie import. */
export class PlaywrightMailBrowser {
  private context?: BrowserContext;
  private signIn?: Page;
  private reader?: Page;
  private readonly owned = new Set<Page>();
  private readonly relinquished = new Set<Page>();
  private readonly operating = new Set<Page>();
  private readonly pending = new Set<AbortController>();
  private readonly deadlines = new WeakMap<AbortSignal, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private source?: string;
  private channel?: "chrome" | "msedge";
  private error?: string;
  private generation = 0;
  private signInBlocked = false;

  constructor(private readonly options: PlaywrightMailBrowserOptions) {
    if (!isAbsolute(options.profileDirectory) || !isAbsolute(options.extensionDirectory))
      throw new Error("Managed browser directories must be absolute.");
  }

  status(): { running: boolean; ownedPages: number; channel?: "chrome" | "msedge"; error?: string } {
    return { running: Boolean(this.context), ownedPages: [...this.owned].filter(page => !page.isClosed()).length,
      ...(this.channel ? { channel: this.channel } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  private notify(): void { try { this.options.changed?.(); } catch { /* Status observers cannot authorize work. */ } }

  private async launch(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.source ??= await readFile(join(this.options.extensionDirectory, "extractors.js"), "utf8");
    const generation = this.generation;
    let context: BrowserContext;
    let channel: "chrome" | "msedge" = "chrome";
    const launch = (selected: "chrome" | "msedge") => chromium.launchPersistentContext(this.options.profileDirectory, {
      channel: selected, headless: false, chromiumSandbox: true, acceptDownloads: false,
      viewport: null, timeout: 25_000,
    });
    try { context = await launch(channel); }
    catch (error) {
      // Profile locks, policy blocks and sign-in/automation restrictions are not
      // grounds for silently switching browsers or weakening launch security.
      if (!(error instanceof Error) || !/executable (?:doesn't exist|does not exist)|distribution ['"]?chrome['"]? is not found/i.test(error.message))
        throw new PlaywrightMailError("unavailable");
      channel = "msedge";
      try { context = await launch(channel); }
      catch (edgeError) {
        if (edgeError instanceof Error && /executable (?:doesn't exist|does not exist)|distribution .* is not found/i.test(edgeError.message))
          throw new PlaywrightMailError("browser-missing");
        throw new PlaywrightMailError("unavailable");
      }
    }
    if (generation !== this.generation) { await context.close(); throw new PlaywrightMailError("interrupted"); }
    this.context = context;
    this.channel = channel;
    context.setDefaultTimeout(5_000);
    context.on("close", () => {
      if (this.context !== context) return;
      this.context = undefined; this.signIn = undefined; this.reader = undefined; this.owned.clear();
      for (const pending of this.pending) pending.abort(new PlaywrightMailError("interrupted"));
      this.notify();
    });
    this.notify();
    return context;
  }

  private own(page: Page): Page {
    this.owned.add(page);
    page.on("close", () => { this.owned.delete(page); this.relinquished.delete(page); this.notify(); });
    this.notify();
    return page;
  }

  private enqueue<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    this.deadlines.set(controller.signal, Date.now() + DEADLINE_MS);
    this.pending.add(controller);
    const cancel = () => controller.abort(new PlaywrightMailError("interrupted"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new PlaywrightMailError("expired")), DEADLINE_MS);
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const task = this.tail.then(async () => {
      this.check(controller.signal);
      return work(controller.signal);
    });
    // Keep serialization until the cancelled operation has stopped, not merely
    // until its caller's deadline has fired.
    this.tail = task.catch(() => undefined);
    return Promise.race([task, aborted]).then(value => {
      this.error = undefined; this.notify(); return value;
    }).catch(error => {
      const safe = failure(error); this.error = safe.message; this.notify(); throw safe;
    }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending.delete(controller);
    });
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= (this.deadlines.get(signal) ?? Infinity)) throw new PlaywrightMailError("expired");
  }

  private async wait(signal: AbortSignal): Promise<void> {
    this.check(signal);
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, POLL_MS);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private async safe(page: Page, signal: AbortSignal): Promise<void> {
    this.check(signal);
    if (page.isClosed()) throw new PlaywrightMailError("interrupted");
    if (await page.evaluate(dirtyPage)) throw new PlaywrightMailError("interrupted");
  }

  private async authorize(beforeRead: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
    this.check(signal);
    let cancel: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try { await Promise.race([Promise.resolve().then(beforeRead), aborted]); }
    finally { signal.removeEventListener("abort", cancel); }
    this.check(signal);
  }

  open(accountEmail: string): Promise<void> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)) return Promise.reject(new PlaywrightMailError("account-mismatch"));
    return this.enqueue(async signal => {
      const context = await this.launch(); this.check(signal);
      if (this.signIn && !this.signIn.isClosed()) {
        await this.signIn.bringToFront();
        await this.checkGoogleSignIn(this.signIn);
        this.signInBlocked = false;
        return;
      }
      this.signInBlocked = false;
      if (context.pages().length >= MAX_PAGES) throw new PlaywrightMailError("busy");
      // Adopt only a fresh blank startup tab, never a restored account/compose tab.
      const blank = context.pages().find(page => page.url() === "about:blank" && !this.owned.has(page));
      const page = this.signIn = this.own(blank || await context.newPage());
      await page.goto(`https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail.toLowerCase())}#inbox`,
        { waitUntil: "domcontentloaded", timeout: 25_000 });
      this.check(signal);
      await page.bringToFront();
      await this.checkGoogleSignIn(page);
    });
  }

  private async checkGoogleSignIn(page: Page): Promise<void> {
    if (page.isClosed() || new URL(page.url()).origin !== "https://accounts.google.com") return;
    const blocked = await page.evaluate(() => {
      if (location.origin !== "https://accounts.google.com") return false;
      const text = [...document.querySelectorAll<HTMLElement>('h1, h2, [role="heading"], [role="alert"], #headingText, #headingSubtext, main, [role="main"]')]
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
        .map(element => element.innerText).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return /this browser or app may not be secure|ce navigateur ou cette application.*(?:securis|securite)/i.test(text);
    });
    if (blocked) {
      this.signInBlocked = true;
      throw new PlaywrightMailError("sign-in-blocked");
    }
  }

  readMailThread(input: BrowserMailRequest, beforeRead: () => void | Promise<void>, signal?: AbortSignal): Promise<BrowserCapture> {
    if (input.attachment) return Promise.reject(new PlaywrightMailError("attachment-unavailable"));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.accountEmail) || !/^[A-Za-z0-9_-]{1,256}$/.test(input.threadId) ||
      (input.inboxRefresh && (input.threadId !== "__relay_inbox__" || input.messageProviderId)))
      return Promise.reject(new PlaywrightMailError("unsupported"));
    return this.enqueue(async active => {
      await this.authorize(beforeRead, active);
      if (this.signInBlocked) throw new PlaywrightMailError("sign-in-blocked");
      const context = await this.launch(); this.check(active);
      if (this.signIn && !this.signIn.isClosed()) await this.checkGoogleSignIn(this.signIn);
      if (!this.signIn || this.signIn.isClosed()) {
        if (context.pages().length >= MAX_PAGES) throw new PlaywrightMailError("busy");
        const blank = context.pages().find(page => page.url() === "about:blank" && !this.owned.has(page));
        this.signIn = this.own(blank || await context.newPage());
        await this.signIn.goto(`https://mail.google.com/mail/?authuser=${encodeURIComponent(input.accountEmail.toLowerCase())}#inbox`,
          { waitUntil: "domcontentloaded", timeout: 20_000 });
        this.check(active);
        await this.checkGoogleSignIn(this.signIn);
      }
      let page = this.reader;
      if (page && !page.isClosed() && (this.relinquished.has(page) || await page.evaluate(dirtyPage).catch(() => true))) {
        // Relinquish a user-touched page; never navigate it on the next request.
        this.reader = undefined; page = undefined;
      }
      if (!page || page.isClosed()) {
        if (context.pages().length >= MAX_PAGES) throw new PlaywrightMailError("busy");
        page = this.reader = this.own(await context.newPage());
        await page.addInitScript(installGuard);
        await page.evaluate(installGuard);
        const watched = page;
        page.on("framenavigated", frame => {
          if (frame === watched.mainFrame() && !this.operating.has(watched)) this.relinquished.add(watched);
        });
      }
      const operation = page;
      this.operating.add(operation);
      const interrupt = () => { void this.disposeReader(operation); };
      active.addEventListener("abort", interrupt, { once: true });
      try {
        await this.safe(page, active);
        await page.goto(`https://mail.google.com/mail/?authuser=${encodeURIComponent(input.accountEmail.toLowerCase())}#inbox`,
          { waitUntil: "domcontentloaded", timeout: 25_000 });
        this.check(active);
        await this.checkGoogleSignIn(page);
        if (new URL(page.url()).origin !== "https://mail.google.com") throw new PlaywrightMailError("sign-in-required");
        await page.evaluate(this.source!);
        await this.ready(page, input, active);
        const result = input.inboxRefresh
          ? { capture: await this.refresh(page, input, beforeRead, active), proof: undefined }
          : await this.thread(page, input, beforeRead, active);
        await this.authorize(beforeRead, active); await this.safe(page, active);
        await page.evaluate(({ input, capture, proof }) => {
          const extractor = (window as unknown as MailWindow).RelayExtractors;
          const registration = extractor.verifyMailAccount(document, location.href, input);
          if (location.href !== capture.pageUrl) throw new Error("thread-mismatch");
          const extracted = extractor.mail(document, location.href, input.inboxRefresh ? undefined : input, proof);
          if (JSON.stringify({ ...registration, messages: extracted.messages, meetings: [] }) !== JSON.stringify(capture))
            throw new Error("partial");
        }, { input, ...result });
        return result.capture;
      } finally {
        this.operating.delete(operation);
        active.removeEventListener("abort", interrupt);
        if (active.aborted) await this.disposeReader(operation);
      }
    }, signal);
  }

  private async disposeReader(page: Page): Promise<void> {
    if (page.isClosed()) return;
    // Unknown DOM state is not permission to discard a user's edits.
    if (this.relinquished.has(page) || await page.evaluate(dirtyPage).catch(() => true)) return;
    if (this.reader === page) this.reader = undefined;
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }

  private async ready(page: Page, input: BrowserMailRequest, signal: AbortSignal): Promise<void> {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      await this.safe(page, signal);
      const code = await page.evaluate(input => {
        const host = window as unknown as MailWindow;
        try {
          host.RelayExtractors.verifyMailAccount(document, location.href, input);
          return location.hash === "#inbox" && /^\/mail\/u\/\d+\/$/.test(location.pathname) &&
            [...document.querySelectorAll("[role='main']")].some(host.RelayExtractors.visible) ? "ready" : "partial";
        } catch (error) { return error instanceof Error && error.message === "account-mismatch" ? "account-mismatch" : "partial"; }
      }, input);
      if (code === "ready") return;
      if (code === "account-mismatch") throw new PlaywrightMailError(code);
      await this.wait(signal);
    }
    throw new PlaywrightMailError("sign-in-required");
  }

  private async click(page: Page, node: ElementHandle<Element>, signal: AbortSignal): Promise<void> {
    await this.safe(page, signal);
    await node.evaluate(element => {
      const host = window as unknown as MailWindow;
      if (!element.isConnected) throw new Error("interrupted");
      host.__relayMailGuard.expected = element;
      host.__relayMailGuard.expires = performance.now() + 5_000;
      host.__relayMailGuard.events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    });
    try {
      // This is real Playwright input, not DOM .click() / dispatchEvent().
      await node.click({ timeout: 5_000, noWaitAfter: true });
    } finally {
      await page.evaluate(() => {
        const guard = (window as unknown as MailWindow).__relayMailGuard;
        if (guard) { guard.expected = undefined; guard.events = []; }
      }).catch(() => undefined);
    }
    await this.safe(page, signal);
  }

  private async thread(page: Page, input: BrowserMailRequest, beforeRead: () => void | Promise<void>, signal: AbortSignal):
    Promise<{ capture: BrowserCapture; proof: RowProof }> {
    let proof: RowProof | undefined;
    const rowDeadline = Date.now() + 12_000;
    while (!proof && Date.now() < rowDeadline) {
      await this.safe(page, signal);
      const handle = await page.evaluateHandle(input =>
        (window as unknown as MailWindow).RelayExtractors.exactMailRow(document, location.href, input)?.element, input);
      const row = handle.asElement();
      try {
        if (row) {
          proof = await row.evaluate((element, input) => {
            const row = (window as unknown as MailWindow).RelayExtractors.exactMailRow(document, location.href, input);
            if (!row || row.element !== element) throw new Error("interrupted");
            return row.proof;
          }, input);
          await this.authorize(beforeRead, signal); await this.safe(page, signal);
          await row.evaluate((element, { input, proof }) => {
            const current = (window as unknown as MailWindow).RelayExtractors.exactMailRow(document, location.href, input);
            if (!current || current.element !== element || JSON.stringify(current.proof) !== JSON.stringify(proof))
              throw new Error("interrupted");
          }, { input, proof });
          await this.click(page, row, signal);
          proof.clicked = true;
        }
      } finally { await handle.dispose(); }
      if (!proof) await this.wait(signal);
    }
    if (!proof) throw new PlaywrightMailError("unsupported");
    let previous = "", stable = 0, expandedAll = false;
    const until = Date.now() + 55_000;
    while (Date.now() < until) {
      await this.safe(page, signal);
      if (page.url() === proof.inboxUrl) { await this.wait(signal); continue; }
      const state = await page.evaluate(({ input, proof }) => {
        try {
          (window as unknown as MailWindow).RelayExtractors.verifyMailRequest(document, location.href, input, proof);
          return "ready";
        } catch (error) { return error instanceof Error ? error.message : "unsupported"; }
      }, { input, proof });
      if (state === "partial") { await this.wait(signal); continue; }
      if (state !== "ready") throw new PlaywrightMailError(state === "account-mismatch" ? state : "thread-mismatch");
      proof.conversationUrl ??= page.url();
      const handle = await page.evaluateHandle(({ input, proof, expandedAll }) => {
        const extractor = (window as unknown as MailWindow).RelayExtractors;
        return (!expandedAll && extractor.mailExpandAllControl(document, location.href, input, proof)) ||
          extractor.collapsedMailHeaders(document, location.href, input, proof)[0];
      }, { input, proof, expandedAll });
      const control = handle.asElement();
      try {
        if (control) {
          const isExpandAll = await control.evaluate((element, { input, proof }) =>
            (window as unknown as MailWindow).RelayExtractors.mailExpandAllControl(document, location.href, input, proof) === element,
          { input, proof });
          await this.authorize(beforeRead, signal); await this.safe(page, signal);
          await control.evaluate((element, { input, proof }) => {
            const extractor = (window as unknown as MailWindow).RelayExtractors;
            if (extractor.mailExpandAllControl(document, location.href, input, proof) !== element &&
              !extractor.collapsedMailHeaders(document, location.href, input, proof).includes(element as HTMLElement))
              throw new Error("interrupted");
          }, { input, proof });
          await this.click(page, control, signal);
          if (isExpandAll) expandedAll = true;
          stable = 0; await this.wait(signal); continue;
        }
      } finally { await handle.dispose(); }
      const result = await page.evaluate(({ input, proof }) => {
        const extractor = (window as unknown as MailWindow).RelayExtractors;
        try {
          const registration = extractor.verifyMailAccount(document, location.href, input);
          const clipped = [...document.querySelectorAll("[role='main'] a[href]")].some(node =>
            extractor.visible(node) && !node.closest(".a3s") &&
            /^(?:view entire message|afficher (?:l['\u2019]integralite du|tout le) message)$/i.test(
              (node.textContent || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()));
          if (clipped) return { code: "clipped" };
          const extracted = extractor.mail(document, location.href, input, proof);
          const capture: BrowserCapture = { ...registration, messages: extracted.messages, meetings: [] };
          if (new TextEncoder().encode(JSON.stringify(capture)).length > 1_900_000) return { code: "unsupported" as const };
          return { capture };
        } catch (error) { return { code: error instanceof Error ? error.message : "unsupported" }; }
      }, { input, proof });
      if (result.capture) {
        const signature = JSON.stringify(result.capture);
        stable = signature === previous ? stable + 1 : 0; previous = signature;
        if (stable >= 2) return { capture: result.capture, proof };
      } else {
        stable = 0;
        if (result.code === "clipped") throw new PlaywrightMailError("partial");
        if (result.code !== "partial") throw new PlaywrightMailError(
          result.code === "account-mismatch" || result.code === "thread-mismatch" ? result.code : "unsupported");
      }
      await this.wait(signal);
    }
    throw new PlaywrightMailError("partial");
  }

  private async refresh(page: Page, input: BrowserMailRequest, beforeRead: () => void | Promise<void>, signal: AbortSignal): Promise<BrowserCapture> {
    const inboxUrl = page.url();
    const handle = await page.evaluateHandle(input => {
      const extractor = (window as unknown as MailWindow).RelayExtractors;
      extractor.verifyMailAccount(document, location.href, input);
      const main = [...document.querySelectorAll("[role='main']")].find(extractor.visible);
      if (!main || location.hash !== "#inbox" || main.querySelector("[data-message-id] .a3s, [data-legacy-message-id] .a3s"))
        throw new Error("unsupported");
      const controls = [...main.querySelectorAll<HTMLElement>("button, [role='button']")].filter(node =>
        extractor.visible(node) && node.getAttribute("aria-disabled") !== "true" && !(node as HTMLButtonElement).disabled &&
        !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog'], form, [contenteditable='true']") &&
        /^(?:Refresh|Actualiser)$/i.test(node.getAttribute("aria-label") || node.getAttribute("data-tooltip") || ""));
      return controls.length === 1 ? controls[0] : undefined;
    }, input);
    const button = handle.asElement();
    if (!button) { await handle.dispose(); throw new PlaywrightMailError("unsupported"); }
    let responseCompleted = false, clickedAt = 0;
    const requests = new Set<Request>();
    const slot = /^\/mail\/u\/(\d+)\/$/.exec(new URL(inboxUrl).pathname)?.[1];
    const onRequest = (request: Request) => {
      const url = new URL(request.url());
      if (!clickedAt || Date.now() - clickedAt > 2_000 || !["xhr", "fetch"].includes(request.resourceType()) ||
        url.origin !== "https://mail.google.com" || url.pathname !== `/sync/u/${slot}/i/bv`) return;
      requests.add(request);
    };
    const onResponse = (response: Response) => {
      if (!requests.has(response.request()) || response.status() !== 200) return;
      void response.finished().then(error => { if (!error) responseCompleted = true; }).catch(() => undefined);
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    try {
      await this.authorize(beforeRead, signal); await this.safe(page, signal);
      await button.evaluate((element, input) => {
        const host = window as unknown as MailWindow, extractor = host.RelayExtractors;
        extractor.verifyMailAccount(document, location.href, input);
        if (!element.isConnected || location.hash !== "#inbox") throw new Error("interrupted");
        const main = element.closest("[role='main']")!;
        const busy = () => element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled ||
          main.getAttribute("aria-busy") === "true" ||
          [...document.querySelectorAll("#loading, .b8, [role='alert'], [role='status'], [role='progressbar'], [aria-busy='true']")]
            .some(node => extractor.visible(node) && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog']") &&
              (node.getAttribute("role") === "progressbar" || node.getAttribute("aria-busy") === "true" ||
                /^(?:Loading|Chargement(?: en cours)?)(?:\s*(?:\.{3}|\u2026))?$/i.test((node.textContent || "").trim())));
        const state = { loadingSeen: false, busy, observer: new MutationObserver(() => { if (busy()) state.loadingSeen = true; }) };
        state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        host.__relayMailGuard.refresh = state;
      }, input);
      clickedAt = Date.now();
      await this.click(page, button, signal);
      let previous = "", stable = 0;
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        await this.wait(signal); await this.safe(page, signal);
        if (page.url() !== inboxUrl) throw new PlaywrightMailError("thread-mismatch");
        const result = await page.evaluate(input => {
          const host = window as unknown as MailWindow, extractor = host.RelayExtractors;
          const registration = extractor.verifyMailAccount(document, location.href, input);
          const main = [...document.querySelectorAll("[role='main']")].find(extractor.visible);
          if (!main) return { busy: true };
          const failed = [...document.querySelectorAll("[role='alert'], [role='status']")].some(node =>
            extractor.visible(node) && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id]") &&
            /offline|unable to connect|trying to connect|connection (?:lost|failed)|system encountered|hors connexion|connexion impossible|erreur|échec/i.test(node.textContent || ""));
          if (failed) throw new Error("unavailable");
          const refresh = host.__relayMailGuard.refresh!;
          if (refresh.busy()) { refresh.loadingSeen = true; return { busy: true }; }
          try {
            const extracted = extractor.mail(document, location.href);
            const rows = [...main.querySelectorAll("tr.zA, [role='row'][data-legacy-thread-id]")]
              .filter(node => extractor.visible(node) && !node.closest(".a3s, .ii"));
            if (rows.length !== extracted.messages.length || extracted.messages.some(message => message.completeness !== "preview"))
              return { busy: true };
            return { loadingSeen: refresh.loadingSeen, capture: { ...registration, messages: extracted.messages, meetings: [] } as BrowserCapture };
          } catch { return { busy: true }; }
        }, input);
        if (result.capture && (responseCompleted || result.loadingSeen)) {
          const signature = JSON.stringify(result.capture);
          stable = signature === previous ? stable + 1 : 0; previous = signature;
          if (stable >= 3) {
            if (Buffer.byteLength(signature, "utf8") > 1_900_000) throw new PlaywrightMailError("unsupported");
            return result.capture;
          }
        } else stable = 0;
      }
      throw new PlaywrightMailError("partial");
    } finally {
      page.off("request", onRequest); page.off("response", onResponse); await handle.dispose();
      await page.evaluate(() => (window as unknown as MailWindow).__relayMailGuard?.refresh?.observer.disconnect()).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.generation++;
    for (const pending of this.pending) pending.abort(new PlaywrightMailError("interrupted"));
    await this.tail;
    const context = this.context;
    if (!context) return;
    // Application shutdown must not discard a compose or a sign-in form the user is editing.
    for (const page of context.pages()) {
      if (!this.owned.has(page) || this.relinquished.has(page) || await page.evaluate(dirtyPage).catch(() => true))
        throw new PlaywrightMailError("busy");
    }
    await context.close();
  }
}
