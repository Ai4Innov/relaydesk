(function () {
  "use strict";
  if (window.top !== window || globalThis.__relayDeskCompanion) return;
  globalThis.__relayDeskCompanion = true;
  const extractors = globalThis.RelayExtractors;
  const HEARTBEAT_MS = 8000;
  let busy = false;
  let activeRun;
  let activeAction;
  let scheduled;
  let status = "Waiting to discover this account. Only selected sources can be captured.";
  let lastCaptureAt = 0;
  let lastCaptureSignature = "";
  let lastObservedRefreshRequestAt = 0;
  let lastRegistrationKey = "";
  let accountMenuOpenedByRelay;
  let mailReadActive = false;
  let mailReadController;
  let mailReadJob;
  const host = document.createElement("aside");
  host.id = "relay-desk-coverage";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = ":host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:390px;pointer-events:none}p{margin:0;padding:10px 13px;border:1px solid #667085;border-radius:9px;background:#101828;color:#fff;font:12px/1.45 system-ui;box-shadow:0 2px 12px #0004;white-space:normal}";
  const label = document.createElement("p");
  label.setAttribute("role", "status");
  label.setAttribute("aria-live", "polite");
  shadow.append(style, label);
  document.documentElement.append(host);

  function show(value) {
    status = value;
    label.textContent = `Relay Desk: ${value}`;
  }

  async function send(type, payload) {
    let result;
    try { result = await chrome.runtime.sendMessage({ type, payload }); }
    catch { throw new Error("The extension connection was interrupted. Reload this tab and open Relay Desk to reconnect."); }
    if (!result || !result.ok) throw new Error(result && result.error || "Relay Desk did not respond.");
    return result.value;
  }

  function cadenceLabel(seconds) {
    if (seconds === 0) return "manual refresh only";
    if (seconds % 3600 === 0) return `every ${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
    if (seconds % 60 === 0) return `every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
    return `every ${seconds} seconds`;
  }

  function visiblePage() {
    return document.visibilityState === "visible";
  }

  function trustedAccountHeader(registration) {
    const current = extractors.identity(document, location.href);
    if (current.accountEmail === registration.accountEmail) return extractors.accountHeader(document, location.href);
    throw new Error("Google's trusted account header changed before the account menu could be opened. Wait for the header to load and retry.");
  }

  function activateAccountHeader(header) {
    extractors.activateNativeControl(header);
  }

  function closeAccountMenu() {
    const opened = accountMenuOpenedByRelay;
    accountMenuOpenedByRelay = undefined;
    if (!opened || !opened.header.isConnected || opened.pageUrl !== location.href) return;
    try {
      const current = extractors.identity(document, location.href);
      if (current.accountEmail === opened.accountEmail && opened.header.getAttribute("aria-expanded") !== "false") {
        activateAccountHeader(opened.header);
      }
    } catch { }
  }

  async function openAccountMenu() {
    const registration = extractors.identity(document, location.href);
    const header = trustedAccountHeader(registration);
    if (header.getAttribute("aria-expanded") !== "true") {
      activateAccountHeader(header);
      accountMenuOpenedByRelay = { header, accountEmail: registration.accountEmail, pageUrl: registration.pageUrl };
    }
    return { accountEmail: registration.accountEmail, kind: registration.kind };
  }

  function backgroundCaptureAllowed(access) {
    return access && access.backgroundCapture === true;
  }

  function captureAllowed(access) {
    return visiblePage() || backgroundCaptureAllowed(access);
  }

  function captureSignature(payload) {
    return JSON.stringify({
      pageUrl: payload.pageUrl,
      kind: payload.kind,
      accountEmail: payload.accountEmail,
      chat: payload.chat,
      messages: payload.messages,
      meetings: payload.meetings
    });
  }

  function schedule(delay = HEARTBEAT_MS) {
    if (scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      run("heartbeat").catch(() => { });
    }, Math.max(0, delay));
  }

  function normalizeInterval(access) {
    if (Number.isInteger(access && access.refreshIntervalSeconds)
      && (access.refreshIntervalSeconds === 0 || (access.refreshIntervalSeconds >= 30 && access.refreshIntervalSeconds <= 3600))) {
      return access.refreshIntervalSeconds;
    }
    return 60;
  }

  function pendingManualRefresh(access) {
    const value = Number.isInteger(access && access.refreshRequestedAt) && access.refreshRequestedAt >= 0 ? access.refreshRequestedAt : 0;
    return value > lastObservedRefreshRequestAt ? value : 0;
  }

  function resetCaptureState(registration) {
    const key = `${registration.kind}:${registration.accountEmail}:${registration.pageUrl}:${registration.chat?.id || ""}`;
    if (key === lastRegistrationKey) return;
    lastRegistrationKey = key;
    lastCaptureAt = 0;
    lastCaptureSignature = "";
  }

  async function discoverCurrent() {
    const registration = extractors.identity(document, location.href);
    resetCaptureState(registration);
    const access = await send("discover", registration);
    return { registration, access };
  }

  function disabledStatus(registration) {
    return `${registration.accountEmail}: discovered, but capture is not enabled in Relay Desk. Select this source there, resume sync if paused, and keep consent on. No content was captured.`;
  }

  function hiddenStatus(registration, access, interval) {
    const provider = registration.kind === "mail" ? "Gmail" : registration.kind === "whatsapp" ? "WhatsApp" : "Calendar";
    if (backgroundCaptureAllowed(access)) {
      if (interval === 0) {
        return `${registration.accountEmail}: source selected. Background capture is allowed for this loaded hidden ${provider} page; manual refresh only.`;
      }
      return `${registration.accountEmail}: source selected. Relay Desk will read this loaded hidden ${provider} page ${cadenceLabel(interval)} while it stays open.`;
    }
    return `${registration.accountEmail}: source selected. Account discovery can continue while this tab stays hidden, but content capture resumes only when the tab is visible.`;
  }

  function readyStatus(registration, access, interval) {
    if (!visiblePage()) return hiddenStatus(registration, access, interval);
    if (interval === 0) {
      const hidden = backgroundCaptureAllowed(access) ? " Background capture is allowed when this loaded page is hidden." : "";
      return `${registration.accountEmail}: source selected. Manual refresh only; use Relay Desk Refresh now or Capture now in this popup to read the current loaded view.${hidden}`;
    }
    const hidden = backgroundCaptureAllowed(access)
      ? " Background capture is allowed for this loaded page while the tab is hidden."
      : " Hidden tabs still disclose account metadata only.";
    return `${registration.accountEmail}: source selected. Relay Desk will read this loaded ${registration.kind === "mail" ? "Gmail" : registration.kind === "whatsapp" ? "WhatsApp" : "Calendar"} page ${cadenceLabel(interval)} while the tab stays open.${hidden}`;
  }

  async function refreshLoadedInbox(registration) {
    if (registration.kind !== "mail") return false;
    const main = [...document.querySelectorAll("[role='main']")].find(extractors.visible);
    if (!main || main.querySelector("[data-message-id] .a3s, [data-legacy-message-id] .a3s")) return false;
    const button = [...main.querySelectorAll("[role='button'], button")].find(node =>
      extractors.visible(node) && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog']")
      && /^(?:Refresh|Actualiser)$/i.test(node.getAttribute("aria-label") || node.getAttribute("data-tooltip") || ""));
    if (!button) return false;
    extractors.activateNativeControl(button);
    await new Promise(resolve => {
      let quiet;
      const finish = () => { clearTimeout(deadline); clearTimeout(quiet); observer.disconnect(); resolve(); };
      const settle = () => { clearTimeout(quiet); quiet = setTimeout(finish, 700); };
      const observer = new MutationObserver(settle);
      observer.observe(main, { childList: true, subtree: true, characterData: true });
      const deadline = setTimeout(finish, 4000);
      quiet = setTimeout(finish, 1500);
    });
    return true;
  }

  async function maybeCapture(registration, access, action) {
    if (access.mailReadTab || mailReadActive) return { status, captured: false, enabled: access.enabled };
    if (!access.enabled) {
      show(disabledStatus(registration));
      return { status, captured: false, enabled: false };
    }
    const interval = normalizeInterval(access);
    const manualRefreshAt = pendingManualRefresh(access);
    const force = action === "capture";
    const manualRequest = force || manualRefreshAt > 0;
    const periodic = !manualRequest && interval > 0 && (lastCaptureAt === 0 || (Date.now() - lastCaptureAt) >= interval * 1000);
    if (action === "connect") {
      show(readyStatus(registration, access, interval));
      return { status, captured: false, enabled: true };
    }
    if (!captureAllowed(access)) {
      show(hiddenStatus(registration, access, interval));
      return { status, captured: false, enabled: true, backgroundCapture: false };
    }
    if (!manualRequest && !periodic) {
      show(readyStatus(registration, access, interval));
      return { status, captured: false, enabled: true };
    }
    if (location.href !== registration.pageUrl || !captureAllowed(access)) {
      throw new Error("The page changed or hidden capture was not authorized during discovery. Retry from the loaded view.");
    }
    if (manualRequest && await refreshLoadedInbox(registration)) {
      const refreshed = await discoverCurrent();
      if (!refreshed.access.enabled || !captureAllowed(refreshed.access) || refreshed.registration.pageUrl !== registration.pageUrl
        || refreshed.registration.accountEmail !== registration.accountEmail) {
        throw new Error("The account, source permission or page changed during inbox refresh. Retry from the current selected inbox.");
      }
    }
    const extracted = extractors.extract(document, registration);
    const current = extractors.identity(document, location.href);
    if (current.pageUrl !== registration.pageUrl || current.accountEmail !== registration.accountEmail || current.kind !== registration.kind
      || current.chat?.id !== registration.chat?.id) {
      throw new Error("The tab or account changed during extraction. Retry from the new account's loaded view.");
    }
    const payload = { ...registration, messages: extracted.messages, meetings: extracted.meetings };
    const signature = captureSignature(payload);
    if (!manualRequest && signature === lastCaptureSignature) {
      lastCaptureAt = Date.now();
      const scope = visiblePage() ? "visible loaded" : "loaded hidden";
      show(`${registration.accountEmail}: no ${scope} changes since the last capture. Still watching ${cadenceLabel(interval)}.`);
      return { status, captured: false, enabled: true, unchanged: true };
    }
    await send("capture", payload);
    if (manualRefreshAt > 0) lastObservedRefreshRequestAt = manualRefreshAt;
    lastCaptureSignature = signature;
    lastCaptureAt = Date.now();
    const scope = visiblePage() ? "Visible loaded pages only" : "Loaded hidden page DOM only";
    show(`${registration.accountEmail}: captured at ${new Date().toLocaleTimeString()}. ${extracted.coverage} ${scope}, not full history.`);
    return { status, captured: true, enabled: true };
  }

  async function run(action = "heartbeat") {
    if (activeRun) {
      if (action === "heartbeat") return { status, captured: false };
      const runningAction = activeAction;
      try {
        const result = await activeRun;
        if (action === "connect") return result;
        if (action === "capture" && (runningAction === "capture" || result.enabled === false)) return result;
      } catch (error) {
        if (action === "connect" || action === "capture") throw error;
      }
    }
    const runPromise = (async () => {
      busy = true;
      try {
        const { registration, access } = await discoverCurrent();
        const result = await maybeCapture(registration, access, action);
        if (registration.kind === "calendar" && access.enabled && visiblePage() && globalThis.RelayCalendarActions) {
          await runCalendarAction(registration);
        }
        return result;
      } catch (error) {
        show(`Not captured: ${error.message}`);
        throw error;
      } finally {
        busy = false;
        schedule();
      }

      async function runCalendarAction(registration) {
        const response = await send("calendar-poll", { registration });
        if (!response?.job) return;
        const job = response.job;
        show("Applying your reviewed Calendar move. Please leave this tab untouched until verification finishes.");
        const result = await globalThis.RelayCalendarActions.execute(job, {
          document, extractors,
          authorize: current => send("calendar-authorize", {
            registration: current, requestId: job.requestId, lease: job.lease
          })
        });
        // No retries, including when the document/account changes or the completion acknowledgment is lost.
        const current = extractors.identity(document, location.href);
        await send("calendar-complete", { registration: current, requestId: job.requestId, lease: job.lease, code: result.code });
        show(result.code === "saved" ? "Reviewed Calendar move saved and verified."
          : `Calendar move needs attention (${result.code}). Check the browser editor and Relay Desk before trying again.`);
      }
    })();
    activeRun = runPromise;
    activeAction = action;
    try { return await runPromise; }
    finally {
      if (activeRun === runPromise) {
        activeRun = undefined;
        activeAction = undefined;
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    clearTimeout(scheduled);
    scheduled = undefined;
    schedule(visiblePage() ? 250 : 0);
  });
  window.addEventListener("hashchange", () => {
    clearTimeout(scheduled);
    scheduled = undefined;
    schedule(250);
  });
  window.addEventListener("popstate", () => {
    clearTimeout(scheduled);
    scheduled = undefined;
    schedule(250);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== "relay-tab") return false;
    if (message.action === "mail-read-status") {
      let registration;
      try { registration = extractors.identity(document, location.href); } catch { }
      respond({ ok: true, value: { dirty: !globalThis.RelayMailRead || globalThis.RelayMailRead.dirty(),
        registration, diagnostics: extractors.mailDiagnostics(document, message.input) } });
      return false;
    }
    if (message.action === "mail-read-cancel") {
      if (mailReadJob?.requestId === message.requestId && mailReadJob?.lease === message.lease)
        mailReadController?.abort();
      respond({ ok: true, value: {} });
      return false;
    }
    if (message.action === "mail-read" && globalThis.RelayMailRead && !mailReadActive) {
      mailReadActive = true;
      mailReadJob = message.job;
      mailReadController = new AbortController();
      show("Reading the exact conversation requested in Relay Desk. No mail will be sent, deleted or archived.");
      globalThis.RelayMailRead.execute(message.job, {
        signal: mailReadController.signal,
        authorizeRow: (registration, rowProof) => send("mail-row-proof", { registration, rowProof,
          requestId: message.job.requestId, lease: message.job.lease })
      }).then(value => respond({ ok: true, value }),
        () => respond({ ok: true, value: { code: "unsupported", interacted: globalThis.RelayMailRead.dirty(),
          diagnostics: extractors.mailDiagnostics(document, message.job.input) } }))
        .finally(() => { mailReadActive = false; mailReadController = undefined; mailReadJob = undefined; });
      return true;
    }
    if (message.action === "status") {
      respond({ ok: true, value: { status } });
      return false;
    }
    if (message.action === "discover-accounts") {
      openAccountMenu().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message.action === "close-account-menu") {
      closeAccountMenu();
      respond({ ok: true, value: { closed: true } });
      return false;
    }
    if (!["connect", "capture"].includes(message.action)) {
      respond({ ok: false, error: "Unsupported tab command." });
      return false;
    }
    run(message.action).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  show(status);
  schedule(0);
})();
