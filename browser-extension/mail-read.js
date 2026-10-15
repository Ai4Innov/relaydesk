(function (root) {
  "use strict";
  let interacted = false;
  // Trusted events only: the reader's narrowly scoped header expansion is not user interaction.
  for (const type of ["pointerdown", "keydown", "input", "submit", "wheel"]) {
    document.addEventListener(type, event => { if (event.isTrusted) interacted = true; }, true);
  }
  document.addEventListener("visibilitychange", event => {
    if (event.isTrusted && !document.hidden) interacted = true;
  });
  function dirty() {
    return interacted || [...document.querySelectorAll("[contenteditable='true'], textarea, input:not([type='hidden'])")]
      .some(node => root.RelayExtractors.visible(node) && !node.closest("#gb") &&
        (node.isContentEditable || Boolean(node.value)));
  }
  async function attachmentCommand(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (!response?.ok) throw new Error(response?.error || "attachment-interrupted");
    return response.value;
  }
  function waitForPage(deadline, signal, interval = 500) {
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        observer.disconnect();
        root.removeEventListener("hashchange", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const observer = new MutationObserver(done);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      root.addEventListener("hashchange", done);
      signal?.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, Math.max(0, Math.min(interval, deadline - Date.now())));
      if (signal?.aborted) done();
    });
  }
  async function whileCurrent(action, deadline, signal) {
    let timer, abort;
    try {
      if (signal?.aborted || Date.now() >= deadline) throw new Error("interrupted");
      return await Promise.race([action(), new Promise((_, reject) => {
        abort = () => reject(new Error("interrupted"));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
        if (signal?.aborted) abort();
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  function pageBusy() {
    return [...document.querySelectorAll("#loading, .b8, [role='status'], [role='progressbar'], [aria-busy='true']")]
      .some(node => !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog']")
        && root.RelayExtractors.visible(node) && (node.getAttribute("role") === "progressbar"
          || node.getAttribute("aria-busy") === "true"
          || /^(?:Loading|Chargement(?: en cours)?)(?:\s*(?:\.{3}|\u2026))?$/i.test((node.textContent || "").trim())));
  }
  function readyAccount(input) {
    const extractors = root.RelayExtractors;
    // No eligible global-header identity is initialization, never evidence of the requested account.
    if (!extractors.identityDiagnostics(document, location.href).eligibleAnchors) throw new Error("partial");
    try { extractors.identity(document, location.href); }
    catch { throw new Error("account-mismatch"); }
    return extractors.verifyMailAccount(document, location.href, input);
  }
  async function execute(job, options = {}) {
    if (job.input.inboxRefresh) return refreshInbox(job, options);
    const extractors = root.RelayExtractors;
    const clicked = new WeakSet();
    const clickedMessages = new Set();
    let previous = "", stableSince = 0, code = "partial", phase = 1;
    const started = Date.now(), deadline = Math.min(job.expiresAt, started + 65000);
    const rowDeadline = Math.min(deadline, started + Math.min(45000, (deadline - started) * 0.7));
    const stopped = () => options.signal?.aborted || Date.now() >= deadline || dirty();
    let proof;
    let expandedAll = false;
    const diagnostics = () => ({ ...extractors.mailDiagnostics(document, job.input), readPhase: phase,
      readinessWaitMs: Math.min(10000, Date.now() - started),
      identityReady: Number(Boolean(extractors.identityDiagnostics(document, location.href).eligibleAnchors)),
      pageBusy: Number(pageBusy()), stableBodyMs: stableSince ? Math.min(10000, Date.now() - stableSince) : 0 });
    while (Date.now() < deadline) {
      if (stopped()) return { code: "interrupted", interacted: dirty(), diagnostics: diagnostics() };
      try {
        phase = 1;
        const registration = readyAccount(job.input);
        phase = 2;
        if (pageBusy() || ![...document.querySelectorAll("[role='main']")].some(extractors.visible)) throw new Error("partial");
        if (!proof && new URL(location.href).hash === "#inbox") {
          phase = 3;
          const row = extractors.exactMailRow(document, location.href, job.input);
          if (!row) {
            if (Date.now() >= rowDeadline) return { code: "unsupported", interacted: dirty(), diagnostics: diagnostics() };
            throw new Error("partial");
          }
          if (typeof options.authorizeRow !== "function") throw new Error("unsupported");
          try { await whileCurrent(() => options.authorizeRow(registration, row.proof), deadline, options.signal); }
          catch { return { code: "interrupted", interacted: dirty(), diagnostics: diagnostics() }; }
          const current = extractors.exactMailRow(document, location.href, job.input);
          if (stopped() || !current || current.element !== row.element || JSON.stringify(current.proof) !== JSON.stringify(row.proof))
            return { code: "interrupted", interacted: dirty(), diagnostics: diagnostics() };
          proof = { ...row.proof, clicked: true };
          phase = 4;
          extractors.activateNativeControl(row.element);
          await waitForPage(deadline, options.signal);
          continue;
        }
        phase = 4;
        if (proof && location.href === proof.inboxUrl) throw new Error("partial");
        extractors.verifyMailRequest(document, location.href, job.input, proof);
        if (proof && !proof.conversationUrl) proof.conversationUrl = location.href;
        const expandAll = !expandedAll && extractors.mailExpandAllControl(document, location.href, job.input, proof);
        if (expandAll) {
          extractors.verifyMailRequest(document, location.href, job.input, proof);
          expandedAll = true;
          phase = 5;
          extractors.activateNativeControl(expandAll);
          await waitForPage(deadline, options.signal);
          continue;
        }
        phase = 5;
        const headers = extractors.collapsedMailHeaders(document, location.href, job.input, proof);
        // Expand-all may still be loading; per-message clicks here can toggle its result closed.
        if (expandedAll && headers.length) throw new Error("partial");
        for (const header of headers) {
          const container = header.closest("[data-legacy-message-id], [data-message-id]");
          const id = container?.getAttribute("data-legacy-message-id") || container?.getAttribute("data-message-id");
          if (!clicked.has(header) && (!id || !clickedMessages.has(id))) {
            extractors.verifyMailRequest(document, location.href, job.input, proof);
            clicked.add(header);
            if (id) clickedMessages.add(id);
            extractors.activateNativeControl(header);
          }
        }
        phase = 6;
        const extracted = extractors.mail(document, location.href, job.input, proof);
        const capture = { ...registration, messages: extracted.messages, meetings: [] };
        const signature = JSON.stringify(capture);
        if (new TextEncoder().encode(signature).length > 1900000) return {
          code: "unsupported", interacted: dirty(), diagnostics: diagnostics()
        };
        if (signature !== previous) stableSince = Date.now();
        previous = signature;
        if (Date.now() - stableSince >= 1000) {
          extractors.verifyMailRequest(document, location.href, job.input, proof);
          if (job.input.attachment) {
            // Both the DOM element and its native URL must survive the fresh desktop permission check.
            const selected = extractors.mailAttachment(document, location.href, job.input, proof);
            const payload = { registration, requestId: job.requestId, lease: job.lease,
              messageProviderId: job.input.messageProviderId, metadataId: selected.metadata.id,
              name: selected.metadata.name, size: selected.metadata.size, url: selected.url };
            const command = options.attachmentCommand || attachmentCommand;
            await whileCurrent(() => command("mail-attachment-authorize", payload), deadline, options.signal);
            const current = extractors.mailAttachment(document, location.href, job.input, proof);
            if (stopped() || current.tile !== selected.tile || current.url !== selected.url ||
              JSON.stringify(current.metadata) !== JSON.stringify(selected.metadata)) throw new Error("attachment-interrupted");
            capture.attachmentDownload = await whileCurrent(() => command("mail-attachment-download", payload), job.expiresAt, options.signal);
            extractors.verifyMailRequest(document, location.href, job.input, proof);
            if (options.signal?.aborted || Date.now() >= job.expiresAt || dirty()) throw new Error("attachment-interrupted");
          }
          return { code: "complete", capture, interacted: dirty(), diagnostics: diagnostics() };
        }
      } catch (error) {
        if (options.signal?.aborted || error.message === "interrupted")
          return { code: "interrupted", interacted: dirty(), diagnostics: diagnostics() };
        if (job.input.attachment && /^attachment-/.test(error.message))
          return { code: error.message, interacted: dirty(), diagnostics: diagnostics() };
        previous = ""; stableSince = 0;
        code = ["account-mismatch", "thread-mismatch", "partial"].includes(error.message) ? error.message : "unsupported";
        if (code === "account-mismatch" || code === "thread-mismatch" || error.message === "unsupported") break;
      }
      await waitForPage(deadline, options.signal);
    }
    if (!proof && phase === 3 && new URL(location.href).hash === "#inbox" && code === "partial") code = "unsupported";
    return { code, interacted: dirty(), diagnostics: diagnostics() };
  }
  async function refreshInbox(job, options = {}) {
    const extractors = root.RelayExtractors;
    const deadline = Math.min(job.expiresAt, Date.now() + 20000);
    try {
      let registration, main, button;
      while (Date.now() < deadline) {
        if (options.signal?.aborted || dirty() || new URL(location.href).hash !== "#inbox") return { code: "interrupted" };
        try {
          registration = readyAccount(job.input);
          main = [...document.querySelectorAll("[role='main']")].find(extractors.visible);
          if (main?.querySelector("[data-message-id] .a3s, [data-legacy-message-id] .a3s")) return { code: "unsupported" };
          button = main && [...main.querySelectorAll("[role='button'], button")].find(node =>
            extractors.visible(node) && node.getAttribute("aria-disabled") !== "true" && !node.disabled
            && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog']")
            && /^(?:Refresh|Actualiser)$/i.test(node.getAttribute("aria-label") || node.getAttribute("data-tooltip") || ""));
          if (button && !pageBusy()) break;
        } catch (error) { if (error.message !== "partial") throw error; }
        await waitForPage(deadline, options.signal);
      }
      if (!button || Date.now() >= deadline) return { code: "partial" };
      let changed = false, lastChange = Date.now(), mutations = 0, extractedRows = 0, busy = false, loadingSeen = false;
      const loading = () => [...document.querySelectorAll("#loading, .b8, [role='alert'], [role='status'], [role='progressbar'], [aria-busy='true']")].some(node =>
        !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog']")
        && extractors.visible(node) && (node.getAttribute("role") === "progressbar" || node.getAttribute("aria-busy") === "true"
          || /^(?:Loading|Chargement(?: en cours)?)(?:\s*(?:\.{3}|\u2026))?$/i.test((node.textContent || "").trim())));
      const refreshBusy = () => loading() || main.getAttribute("aria-busy") === "true"
        || button.getAttribute("aria-disabled") === "true" || button.disabled;
      const diagnostics = () => ({ ...extractors.mailDiagnostics(document, job.input),
        refreshMutations: Math.min(10000, mutations), refreshQuietMs: Math.min(10000, Date.now() - lastChange),
        refreshBusy: Number(busy), extractedRows });
      const observer = new MutationObserver(records => {
        mutations += records.length;
        if (refreshBusy()) loadingSeen = true;
        const rows = "tr.zA, [role='row'][data-legacy-thread-id], td.TC";
        if (records.some(record => main.contains(record.target) && (
          (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(rows)
          || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
            && (node.matches(rows) || node.querySelector(rows)))))) {
          changed = true; lastChange = Date.now();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      try {
        const started = performance.now();
        // Unchanged inboxes may not repaint. Observe timing only for Gmail's own
        // completed inbox-view response; never issue or inspect a private request.
        const inboxResponseCompleted = () => performance.getEntriesByType("resource").some(entry => {
          if (!["fetch", "xmlhttprequest"].includes(entry.initiatorType) || entry.startTime < started
            || entry.startTime > started + 2000 || entry.responseEnd <= entry.startTime
            || entry.responseStatus !== 200 || entry.transferSize <= 0) return false;
          const url = new URL(entry.name);
          return url.origin === location.origin && /^\/sync\/u\/\d+\/i\/bv$/.test(url.pathname);
        });
        extractors.activateNativeControl(button);
        while (Date.now() < deadline) {
          await waitForPage(deadline, options.signal, 300);
          if (options.signal?.aborted || dirty()) return { code: "interrupted" };
          if (Date.now() >= deadline) break;
          let current;
          try { current = readyAccount(job.input); }
          catch (error) { if (error.message === "partial") continue; throw error; }
          if (current.pageUrl !== registration.pageUrl) return { code: "interrupted" };
          const failed = [...document.querySelectorAll("[role='alert'], [role='status']")].some(node =>
            extractors.visible(node) && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id]")
            && /offline|unable to connect|trying to connect|connection (?:lost|failed)|system encountered|hors connexion|connexion impossible|erreur|échec/i
              .test(node.textContent || ""));
          if (failed) return { code: "unavailable" };
          busy = refreshBusy()
            || [...main.querySelectorAll("[role='progressbar'], [aria-busy='true']")].some(extractors.visible);
          if ((!changed && !loadingSeen && !inboxResponseCompleted()) || Date.now() - lastChange < 1500 || busy) continue;
          const extracted = extractors.extract(document, current);
          extractedRows = extracted.messages.length;
          const rows = [...main.querySelectorAll("tr.zA, [role='row'][data-legacy-thread-id]")]
            .filter(node => extractors.visible(node) && !node.closest(".a3s, .ii"));
          if (rows.length > extracted.messages.length) return { code: "partial", diagnostics: diagnostics() };
          if (extracted.messages.some(message => message.completeness !== "preview")) return { code: "unsupported" };
          return { code: "complete", interacted: false,
            capture: { ...current, messages: extracted.messages, meetings: [] } };
        }
        return { code: "partial", diagnostics: diagnostics() };
      } finally { observer.disconnect(); }
    } catch (error) {
      return { code: error.message === "account-mismatch" ? "account-mismatch" : "unavailable", interacted: dirty() };
    }
  }
  root.RelayMailRead = { execute, dirty };
})(globalThis);
