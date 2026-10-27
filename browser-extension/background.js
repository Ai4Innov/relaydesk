(function (root) {
  "use strict";
  const extractors = typeof module === "object" && module.exports ? require("./extractors.js") : (importScripts("whatsapp.js", "extractors.js"), root.RelayExtractors);
  const BASE = "http://127.0.0.1:43891";
  const GOOGLE_URLS = ["https://mail.google.com/*", "https://calendar.google.com/*"];
  const SUPPORTED_URLS = [...GOOGLE_URLS, "https://web.whatsapp.com/*"];
  const ACCOUNT_SCRIPT_ID = "relay-google-account-menu";
  const ACCOUNT_SCRIPT_MATCHES = [
    "https://ogs.google.com/*/widget/account*",
    "https://ogs.google.com/widget/account*"
  ];
  const MAX_MENU_ACCOUNTS = 24;
  const MENU_TIMEOUT_MS = 8000;
  const REGISTRATION_TIMEOUT_MS = 45000;
  const MAIL_WAKE_ALARM = "relay-mail-dispatch";
  const TAB_LIMITS = { reader: 3, wake: 3, view: 24 };
  const TAB_IDLE_MS = 15 * 60 * 1000;
  const TAB_INSPECTION_MS = 1500;
  const TAB_MANAGEMENT_MS = 10000;
  const ATTACHMENT_CODES = ["attachment-unavailable", "attachment-size-limit", "attachment-dangerous",
    "attachment-interrupted", "attachment-path-mismatch", "attachment-authorization-denied", "attachment-download-failed"];
  const ATTACHMENT_COMPLETION_CODES = {
    "attachment-unavailable": "unsupported", "attachment-size-limit": "unsupported",
    "attachment-dangerous": "unsupported", "attachment-path-mismatch": "unsupported",
    "attachment-interrupted": "interrupted", "attachment-authorization-denied": "interrupted",
    "attachment-download-failed": "unavailable",
  };

  function validAttachmentIntent(input) {
    const attachment = input?.attachment;
    return attachment && typeof input.messageProviderId === "string" && !input.messageProviderId.startsWith("thread:") &&
      typeof attachment.metadataId === "string" && attachment.metadataId.length > 0 &&
      typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 200 &&
      !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(attachment.name) && !/[. ]$/.test(attachment.name) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(attachment.name) &&
      (attachment.approved === undefined || typeof attachment.approved === "boolean") &&
      Number.isSafeInteger(attachment.maxBytes) && attachment.maxBytes > 0 && attachment.maxBytes <= 512 * 1024 * 1024 &&
      /^RelayDesk\/[a-f0-9-]{36}\/[^/]+$/.test(attachment.relativePath) &&
      attachment.relativePath.split("/")[2] === attachment.name;
  }

  async function cancelOwnedDownload(chrome, id) {
    if (!Number.isInteger(id)) return;
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item?.id === id && item.byExtensionId === chrome.runtime.id && item.state === "in_progress")
        await chrome.downloads.cancel(id);
    } catch { /* Never substitute another download when this ID is unavailable. */ }
  }

  async function downloadAttachment(chrome, pending, check, remember) {
    const attachment = pending.job.input.attachment;
    if (!validAttachmentIntent(pending.job.input) || !chrome.downloads?.download) throw new Error("attachment-unavailable");
    let complete = false, id, timer, listener;
    let wake;
    try {
      if (!Number.isFinite(pending.job.expiresAt) || pending.job.expiresAt <= Date.now() + 1500)
        throw new Error("attachment-interrupted");
      await check();
      id = await chrome.downloads.download({ url: pending.attachmentProof.url, filename: attachment.relativePath,
        conflictAction: "uniquify", saveAs: false });
      if (!Number.isInteger(id) || id < 0) throw new Error("attachment-interrupted");
      pending.downloadId = id;
      await remember();
      listener = delta => { if (delta.id === id) wake?.(); };
      chrome.downloads.onChanged.addListener(listener);
      while (Date.now() < pending.job.expiresAt - 1500) {
        await check();
        const [item] = await chrome.downloads.search({ id });
        if (!item || item.id !== id || item.byExtensionId !== chrome.runtime.id ||
          item.url !== pending.attachmentProof.url ||
          (item.finalUrl && extractors.nativeAttachmentUrl(item.finalUrl, attachment.name) !== item.finalUrl))
          throw new Error("attachment-interrupted");
        if (item.danger !== "safe") throw new Error("attachment-dangerous");
        if ([item.totalBytes, item.bytesReceived, item.fileSize].some(bytes => bytes > attachment.maxBytes))
          throw new Error("attachment-size-limit");
        if (item.state === "interrupted") throw new Error(["USER_CANCELED", "USER_SHUTDOWN"].includes(item.error)
          ? "attachment-interrupted" : "attachment-download-failed");
        if (item.state === "complete") {
          // Chrome reports the platform's absolute path: C:\Users\…\Downloads\… or /Users|/home/…/Downloads/….
          const filename = typeof item.filename === "string" ? item.filename : "";
          const windows = /^[A-Za-z]:\\/.test(filename);
          const separator = windows ? "\\" : "/";
          const relative = attachment.relativePath.replaceAll("/", separator);
          if (!(windows || filename.startsWith("/")) || filename.includes("\0") ||
            !filename.endsWith(`${separator}Downloads${separator}${relative}`)) throw new Error("attachment-path-mismatch");
          if (!Number.isSafeInteger(item.bytesReceived) || item.bytesReceived < 0 ||
            item.bytesReceived > attachment.maxBytes || item.totalBytes !== item.bytesReceived ||
            (item.fileSize !== undefined && item.fileSize !== item.bytesReceived))
            throw new Error("attachment-size-limit");
          await check();
          complete = true;
          return { metadataId: attachment.metadataId, name: attachment.name, relativePath: attachment.relativePath,
            bytes: item.bytesReceived };
        }
        await new Promise(resolve => {
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
          timer = setTimeout(wake, 250);
        });
      }
      throw new Error("attachment-interrupted");
    } catch (error) {
      throw new Error(ATTACHMENT_CODES.includes(error.message) ? error.message : "attachment-download-failed");
    } finally {
      clearTimeout(timer);
      if (listener) chrome.downloads.onChanged.removeListener(listener);
      if (!complete) await cancelOwnedDownload(chrome, id);
    }
  }

  function createBridge(chrome, fetchRequest) {
    const grants = new Map();
    const verifiedTabs = new Map();
    const expectedTabs = new Map();
    const blockedTabs = new Map();
    const pendingMenuScans = new Map();
    const calendarJobs = new Map();
    const mailJobs = new Map();
    const mailPolling = new Set();
    const mailFinishing = new Set();
    const mailRoutes = new Map();
    const mailWakes = new Map();
    const mailCreations = new Map();
    const mailCleanup = new Map();
    const mailConnections = new Set();
    const ownedTabs = new Map();
    const tabCreations = new Set();
    const tabReasons = { readerCapacity: 0, wakeCapacity: 0, viewCapacity: 0, inspectionTimeout: 0,
      inspectionUnavailable: 0, readerLoading: 0, readerStatusUnavailable: 0, protectedTab: 0,
      documentMismatch: 0, allocationFailed: 0, readUnavailable: 0, waitingHeader: 0, waitingMain: 0,
      waitingExactRow: 0, waitingNavigation: 0, waitingExpansion: 0, waitingStableBody: 0 };
    let lastTabReason = "none";
    let tabOperations = Promise.resolve();
    let mailGeneration = 0;
    let accountScanActive = false;
    let wakeCheck;
    let lastWakeCheck = 0;
    let saving = Promise.resolve();
    const workStorage = chrome.storage.session;
    const ready = (async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      if (chrome.storage.session) await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const saved = { ...await chrome.storage.local.get("mailRoutes"), ...(workStorage ? await workStorage.get("mailWork") : {}) };
      for (const key of Object.keys(tabReasons)) {
        const count = saved.mailWork?.diagnostics?.reasons?.[key];
        if (Number.isInteger(count) && count >= 0 && count <= 1000000) tabReasons[key] = count;
      }
      if (Object.hasOwn(tabReasons, saved.mailWork?.diagnostics?.lastReason || ""))
        lastTabReason = saved.mailWork.diagnostics.lastReason;
      for (const entry of saved.mailWork?.owned || []) {
        if (entry && typeof entry.key === "string" && Object.hasOwn(TAB_LIMITS, entry.role)) {
          // An interrupted creation with no returned ID still consumes a slot. Never
          // infer which existing tab it was from its URL after worker termination.
          entry.busy = false;
          entry.creating = false;
          entry.protected ||= Boolean(entry.nextUrl);
          ownedTabs.set(entry.key, entry);
        }
      }
      if (saved.mailWork && saved.mailWork.owned === undefined) {
        // Earlier workers journaled IDs only after their own tabs.create. Import
        // that session-only provenance, never a route, DOM label or local-storage
        // ID. Without the original document binding, retain but never reclaim.
        for (const pending of [...(saved.mailWork.jobs || []), ...(saved.mailWork.wakes || []), ...(saved.mailWork.cleanup || [])]) {
          const email = normalizeCandidateEmail(pending.accountEmail || pending.job?.input?.accountEmail);
          const requestId = pending.requestId || pending.job?.requestId;
          if (!Number.isInteger(pending.tabId) || pending.tabId < 0 || pending.creating || ownedTab(pending.tabId) ||
            !email || !/^[a-f0-9]{32}$/.test(requestId || "") ||
            (!safeWakeRoute(pending.targetUrl) && pending.targetUrl !== canonicalInbox(email))) continue;
          const documentId = typeof pending.boundDocument === "string" && pending.boundDocument.length > 0 &&
            pending.boundDocument.length <= 128 ? pending.boundDocument : undefined;
          const key = `legacy-session-${pending.tabId}`;
          ownedTabs.set(key, { key, tabId: pending.tabId, role: pending.job ? "reader" : "wake",
            url: pending.targetUrl, requestedUrl: pending.targetUrl, email, kind: "mail", documentId,
            busy: false, creating: false, loading: false, idleAt: Date.now(),
            protected: pending.interacted === true || !documentId });
        }
      }
      for (const route of saved.mailRoutes || []) {
        if (typeof route.accountId === "string" && normalizeCandidateEmail(route.email) && safeWakeRoute(route.url))
          mailRoutes.set(route.accountId, route);
      }
      for (const wake of saved.mailWork?.wakes || []) {
        if (Number.isInteger(wake.tabId) && ownedTab(wake.tabId)?.role === "wake") mailWakes.set(wake.requestId, wake);
      }
      for (const pending of saved.mailWork?.cleanup || []) mailCleanup.set(pending.tabId, pending);
      for (const pending of saved.mailWork?.jobs || []) {
        if (!Number.isInteger(pending.tabId) || ownedTab(pending.tabId)?.role !== "reader") continue;
        await cancelOwnedDownload(chrome, pending.downloadId);
        pending.restored = true;
        mailJobs.set(pending.job.requestId, pending);
      }
    })();

    function safeWakeRoute(value) {
      try {
        const url = new URL(value);
        return url.origin === "https://mail.google.com" && !url.username && !url.password && !url.search &&
          /^\/mail\/u\/(?:0|[1-9]\d{0,3})\/$/.test(url.pathname) && url.hash === "#inbox";
      } catch { return false; }
    }

    function wakeLocation(wake, value) {
      return value === wake.targetUrl || (wake.awaitingHeader === true && safeWakeRoute(value));
    }

    function wakeTabChanged(wake, tab) {
      return !tab || (tab.pendingUrl && !wakeLocation(wake, tab.pendingUrl)) ||
        (tab.url && !wakeLocation(wake, tab.url) && !wakeLocation(wake, tab.pendingUrl)) ||
        (wake.seenUrl && !tab.url && !tab.pendingUrl && tab.status === "complete");
    }

    function saveMailWork() {
      saving = saving.catch(() => {}).then(async () => {
        const journal = ({ timer, attachmentProof, ...pending }) => pending;
        if (chrome.alarms) await chrome.storage.local.set({ mailRoutes: [...mailRoutes.values()].slice(-64) });
        // Session storage survives worker suspension, but not browser restart/tab-ID reuse.
        await workStorage?.set({ mailWork: { owned: [...ownedTabs.values()], wakes: [...mailWakes.values()], cleanup: [...mailCleanup.values()].map(journal),
          diagnostics: { lastReason: lastTabReason, reasons: { ...tabReasons } },
          jobs: [...mailJobs.values()].map(journal) } });
      });
      return saving;
    }

    function tabOperation(action) {
      const result = tabOperations.catch(() => {}).then(action);
      tabOperations = result.catch(() => {});
      return result;
    }

    function recordTabReason(reason) {
      if (!Object.hasOwn(tabReasons, reason)) return;
      tabReasons[reason] = Math.min(1000000, tabReasons[reason] + 1);
      lastTabReason = reason;
    }

    function tabTimeout() {
      const error = new Error("Agent tab inspection timed out. Unverified tabs were retained. Wait for the browser to respond, then refresh tab status.");
      error.code = "TAB_OPERATION_TIMEOUT";
      return error;
    }

    async function boundedTabCall(promise, milliseconds = TAB_INSPECTION_MS) {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(tabTimeout()), milliseconds);
        })]);
      } finally { clearTimeout(timer); }
    }

    function managementOperation(action) {
      const deadline = Date.now() + TAB_MANAGEMENT_MS;
      let expired = false;
      const check = () => { if (expired || Date.now() >= deadline) throw tabTimeout(); };
      // A popup timeout must not enqueue a cleanup that runs unexpectedly later.
      return boundedTabCall(tabOperation(() => { check(); return action(check); }), TAB_MANAGEMENT_MS)
        .catch(error => { expired = true; throw error; });
    }

    function ownedStatus(entry) {
      return boundedTabCall(chrome.tabs.sendMessage(entry.tabId, { type: "relay-tab", action: "mail-read-status" },
        { documentId: entry.documentId }));
    }

    function ownedTab(tabId) {
      return [...ownedTabs.values()].find(entry => entry.tabId === tabId);
    }

    function tabInUse(tabId) {
      return [...mailJobs.values(), ...mailWakes.values()].some(pending => pending.tabId === tabId) ||
        expectedTabs.has(tabId) || [...calendarJobs.values()].some(job => job.tabId === tabId);
    }

    // Inspection never establishes ownership. Only the journal written around our
    // own tabs.create does that; a matching URL alone is insufficient.
    async function inspectOwned(entry, allowBusy = false, observed, operational = false) {
      if (!entry || entry.protected || entry.creating || (!allowBusy && (entry.busy || tabInUse(entry.tabId))) ||
        !Number.isInteger(entry.tabId)) return undefined;
      let tab;
      try { tab = await boundedTabCall(chrome.tabs.get(entry.tabId)); }
      catch (error) {
        if (operational) recordTabReason(error.code === "TAB_OPERATION_TIMEOUT" ? "inspectionTimeout" : "inspectionUnavailable");
        if (/No tab with id|Invalid tab ID|Tab closed/i.test(error.message || "")) ownedTabs.delete(entry.key);
        return undefined;
      }
      if (observed) observed.tab = tab;
      if (tab?.active || tab?.pinned) entry.protected = true;
      if (!tab || entry.protected || tab.pendingUrl || !tab.url || tab.url !== entry.url ||
        tab.status === "loading" || !entry.documentId || !entry.email) return undefined;
      try {
        if (observed) observed.statusAttempted = true;
        const response = await ownedStatus(entry);
        if (observed) observed.response = response;
        const status = response?.ok && response.value;
        if (status?.dirty === true) entry.protected = true;
        if (status?.dirty !== false || status.registration?.pageUrl !== tab.url ||
          status.registration?.accountEmail !== entry.email || status.registration?.kind !== entry.kind) {
          if (operational) recordTabReason(status?.dirty === true ? "protectedTab" :
            status?.dirty === false ? "documentMismatch" : "inspectionUnavailable");
          return undefined;
        }
        const current = await boundedTabCall(chrome.tabs.get(entry.tabId));
        if (entry.protected || current.active || current.pinned || current.pendingUrl || current.status === "loading" ||
          current.url !== tab.url) return undefined;
        return current;
      } catch (error) {
        if (operational) recordTabReason(error.code === "TAB_OPERATION_TIMEOUT" ? "inspectionTimeout" : "inspectionUnavailable");
        return undefined;
      }
    }

    async function sweepOwned(all = false, check = () => {}) {
      let closed = 0;
      for (const entry of [...ownedTabs.values()]) {
        check();
        if (!all && Date.now() - entry.idleAt < TAB_IDLE_MS) continue;
        if (!await inspectOwned(entry)) continue;
        check();
        try { await boundedTabCall(chrome.tabs.remove(entry.tabId)); }
        catch (error) {
          if (error.code === "TAB_OPERATION_TIMEOUT") throw error;
          continue;
        }
        ownedTabs.delete(entry.key);
        mailCleanup.delete(entry.tabId);
        closed++;
      }
      await boundedTabCall(saveMailWork());
      return { closed, retained: ownedTabs.size,
        message: `Closed ${closed} verified idle agent tab${closed === 1 ? "" : "s"}. Retained tabs may be active, in use, edited or not yet verifiable.` };
    }

    async function tabManagement() {
      await ready;
      return await managementOperation(async check => {
        let mailIdle = 0;
        const debug = { roles: { reader: 0, wake: 0, view: 0 }, busy: 0, protected: 0, loading: 0,
          bound: 0, sameUrl: 0, statusUnavailable: 0, pending: 0, active: 0, pinned: 0, dirty: 0,
          identityMismatch: 0, unbound: 0, reservations: 0 };
        for (const entry of [...ownedTabs.values()]) {
          check();
          const observed = {};
          if (entry.role !== "view" && await inspectOwned(entry, false, observed)) mailIdle++;
          if (!ownedTabs.has(entry.key)) continue;
          debug.roles[entry.role]++;
          if (entry.busy || tabInUse(entry.tabId)) debug.busy++;
          if (entry.protected) debug.protected++;
          if (entry.documentId) debug.bound++; else debug.unbound++;
          if (!Number.isInteger(entry.tabId)) { debug.reservations++; continue; }
          const tab = observed.tab || await boundedTabCall(chrome.tabs.get(entry.tabId)).catch(() => undefined);
          if (entry.loading || tab?.status === "loading") debug.loading++;
          if (tab?.url && tab.url === entry.url) debug.sameUrl++;
          if (tab?.pendingUrl) debug.pending++;
          if (tab?.active) debug.active++;
          if (tab?.pinned) debug.pinned++;
          if (!entry.documentId) continue;
          check();
          try {
            const response = observed.statusAttempted ? observed.response : await ownedStatus(entry);
            if (!response?.ok || typeof response.value?.dirty !== "boolean") debug.statusUnavailable++;
            else {
              if (response.value.dirty) debug.dirty++;
              if (response.value.registration?.pageUrl !== tab?.url || response.value.registration?.accountEmail !== entry.email ||
                response.value.registration?.kind !== entry.kind) debug.identityMismatch++;
            }
          } catch { debug.statusUnavailable++; }
        }
        check();
        await boundedTabCall(saveMailWork());
        return { mailOwned: [...ownedTabs.values()].filter(entry => entry.role !== "view").length,
          mailIdle, viewOwned: [...ownedTabs.values()].filter(entry => entry.role === "view").length,
          limit: Object.values(TAB_LIMITS).reduce((sum, limit) => sum + limit, 0),
          debug: { ...debug, lastReason: lastTabReason, reasons: { ...tabReasons } } };
      });
    }

    async function acquireMailTab(role, url, email, windowId, excludeTabId, current = () => true) {
      return await tabOperation(async () => {
        await sweepOwned();
        if (!current()) throw new Error("The full email request ended before a tab was available.");
        for (const entry of ownedTabs.values()) {
          if (entry.role !== role || entry.email !== email || entry.tabId === excludeTabId) continue;
          const tab = await inspectOwned(entry, false, undefined, true);
          if (!tab) continue;
          entry.busy = true;
          mailCleanup.delete(entry.tabId);
          entry.idleAt = Date.now();
          await saveMailWork();
          if (!current()) {
            entry.busy = false;
            await saveMailWork();
            throw new Error("The full email request ended before tab reuse.");
          }
          if (role === "reader" && tab.url !== url) {
            // Only a freshly checked same-account, untouched owned reader may be
            // reset to its inbox. Never navigate a bootstrap/user/discovery tab.
            entry.nextUrl = url;
            await saveMailWork();
            if (!current() || !await inspectOwned(entry, true, undefined, true) || entry.protected) {
              entry.busy = false;
              delete entry.nextUrl;
              await saveMailWork();
              throw new Error("The reader changed before safe reuse.");
            }
            const previous = new URL(entry.url), target = new URL(url);
            previous.hash = ""; target.hash = "";
            entry.url = url;
            // Returning to #inbox is same-document navigation. Keep the known
            // document binding; a different document must not inherit ownership.
            if (previous.href !== target.href) entry.documentId = undefined;
            entry.loading = true;
            delete entry.nextUrl;
            await chrome.tabs.update(tab.id, { url });
            await saveMailWork();
          }
          return { ...(await chrome.tabs.get(tab.id)), reused: true };
        }
        return await createOwnedTab(role, url, email, windowId, current);
      });
    }

    async function createOwnedTab(role, url, email, windowId, current = () => true) {
      if ([...ownedTabs.values()].filter(entry => entry.role === role).length >= TAB_LIMITS[role]) {
        recordTabReason(`${role}Capacity`);
        await saveMailWork();
        const error = new Error(`Agent ${role} tab limit reached. Close unused agent tabs or use Close idle agent tabs, then retry.`);
        error.code = "TAB_CAPACITY";
        throw error;
      }
      const entry = { key: `${Date.now()}-${Math.random()}`, role, url, requestedUrl: url, email,
        kind: extractors.pageKind(url), creating: true, busy: true, loading: true, idleAt: Date.now(), activations: [], changedTabs: [] };
      ownedTabs.set(entry.key, entry);
      await saveMailWork();
      if (!current()) {
        ownedTabs.delete(entry.key);
        await saveMailWork();
        throw new Error("The full email request ended before tab creation.");
      }
      let release;
      const barrier = new Promise(resolve => { release = resolve; });
      tabCreations.add(barrier);
      let created = false;
      try {
        const tab = await chrome.tabs.create({ url, active: false,
          ...(Number.isInteger(windowId) ? { windowId } : {}) });
        created = true;
        if (!Number.isInteger(tab?.id)) throw new Error("Browser did not return the new tab.");
        entry.tabId = tab.id;
        entry.protected = Boolean(tab.active || tab.pinned || entry.activations.includes(tab.id) || entry.changedTabs.includes(tab.id));
        entry.creating = false;
        if (role === "view") entry.busy = false;
        await saveMailWork();
        return tab;
      } catch (error) {
        // An explicit browser API rejection created no tab. A worker killed while
        // awaiting the API instead leaves the persisted reservation occupied.
        if (!created) ownedTabs.delete(entry.key);
        await saveMailWork();
        throw error;
      } finally { tabCreations.delete(barrier); release(); }
    }

    async function openView(url, email) {
      await ready;
      return await tabOperation(async () => {
        const kind = extractors.pageKind(url);
        for (const tab of await boundedTabCall(chrome.tabs.query({ url: SUPPORTED_URLS }))) {
          const entry = ownedTab(tab.id);
          const verified = verifiedTabs.get(tab.id) || (entry?.documentId ? {
            email: entry.email, pageUrl: entry.url, documentId: entry.documentId } : undefined);
          if (!verified || !verified.documentId || tab.pendingUrl || tab.status === "loading" || tab.url !== verified.pageUrl) continue;
          if (entry && entry.role !== "view") continue;
          if (email ? verified.email !== email || extractors.pageKind(tab.url) !== kind :
            tab.url !== url && entry?.requestedUrl !== url) continue;
          try {
            const response = await ownedStatus({ tabId: tab.id, documentId: verified.documentId });
            const current = await boundedTabCall(chrome.tabs.get(tab.id));
            if (response?.ok && response.value?.registration?.accountEmail === verified.email &&
              response.value.registration.pageUrl === tab.url && current.url === tab.url && !current.pendingUrl) {
              // No navigation, activation or cleanup of the existing page, even if
              // it is user-owned or has an editor open.
              if (entry) entry.idleAt = Date.now();
              await saveMailWork();
              return { tab: current, reused: true, verified: true };
            }
          } catch { }
        }
        // Coalesce repeated clicks while our same view is still loading. This
        // reserves capacity without claiming its account identity is verified.
        const loading = [...ownedTabs.values()].find(entry => entry.role === "view" &&
          entry.requestedUrl === url && !entry.protected);
        if (loading) {
          const tab = await boundedTabCall(chrome.tabs.get(loading.tabId)).catch(() => undefined);
          if (tab && !tab.pinned && (!tab.pendingUrl || tab.pendingUrl === url) &&
            (tab.url === url || (loading.loading && loading.kind === "mail" && safeWakeRoute(tab.url)) ||
              (!tab.url && tab.status === "loading"))) return { tab, reused: true, verified: false };
        }
        await sweepOwned();
        return { tab: await createOwnedTab("view", url, email), reused: false, verified: false };
      });
    }

    async function dispatchResult(requestId, code) {
      return await request("/mail/dispatch", { protocol: 1, requestId, code });
    }

    function stopMailRead(pending) {
      if (!pending.boundDocument || !Number.isInteger(pending.tabId)) return;
      void chrome.tabs.sendMessage(pending.tabId, { type: "relay-tab", action: "mail-read-cancel",
        requestId: pending.job.requestId, lease: pending.job.lease }, { documentId: pending.boundDocument }).catch(() => {});
    }

    async function connectMailTab(pending) {
      if (mailConnections.has(pending)) return;
      mailConnections.add(pending);
      const generation = mailGeneration;
      const requestId = pending.job?.requestId || pending.requestId;
      const deadline = pending.job ? pending.job.expiresAt - 1000
        : Math.min(pending.expiresAt - 1000, pending.createdAt + REGISTRATION_TIMEOUT_MS);
      const current = () => generation === mailGeneration && Date.now() < deadline && !pending.ended
        && !pending.boundDocument && (pending.job ? mailJobs : mailWakes).get(requestId) === pending;
      try {
        while (current()) {
          const tab = await boundedTabCall(chrome.tabs.get(pending.tabId), Math.max(1, Math.min(TAB_INSPECTION_MS, deadline - Date.now())))
            .catch(() => undefined);
          if (!current()) return;
          if (pending.interacted || ownedTab(pending.tabId)?.protected || tab?.active || tab?.pinned
            || (tab && (pending.job ? tab.url !== pending.targetUrl
              || (tab.pendingUrl && tab.pendingUrl !== pending.targetUrl) : wakeTabChanged(pending, tab)))) return;
          if (tab) {
            // No command has been accepted yet: an unloaded content script or a
            // temporarily missing header is retriable, not failed delivery.
            await boundedTabCall(sendTabAction(pending.tabId, "connect"),
              Math.max(1, Math.min(TAB_INSPECTION_MS, deadline - Date.now()))).catch(() => {});
          }
          if (current()) await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        }
      } finally { mailConnections.delete(pending); }
    }

    async function retireWake(wake) {
      mailWakes.delete(wake.requestId);
      if (Number.isInteger(wake.tabId)) mailCleanup.set(wake.tabId, wake);
      await saveMailWork();
      await retryMailCleanup();
    }

    async function retryMailCleanup() {
      for (const [tabId, pending] of mailCleanup) {
        if (await cleanMailTab(pending)) mailCleanup.delete(tabId);
      }
      await saveMailWork();
      await tabOperation(() => sweepOwned());
    }

    // An alarm is the independent dispatch path; page messages only accelerate it.
    // Neither a stored numeric route nor a pending hint is account identity proof.
    async function checkMailWake(force = false) {
      if (!chrome.alarms) return;
      await ready;
      if (wakeCheck) return wakeCheck;
      if (!force && Date.now() - lastWakeCheck < 5000) return;
      lastWakeCheck = Date.now();
      wakeCheck = (async () => {
        await retryMailCleanup();
        const { token } = await chrome.storage.local.get("token");
        if (!token) return;
        const generation = mailGeneration;
        const response = await request("/mail/pending", { protocol: 1 });
        if (generation !== mailGeneration || (await chrome.storage.local.get("token")).token !== token) return;
        if (!Array.isArray(response?.pending) || response.pending.length > 3) return;
        const hints = response.pending.filter(hint => /^[a-f0-9]{32}$/.test(hint?.requestId) &&
          typeof hint.accountId === "string" && normalizeCandidateEmail(hint.accountEmail) === hint.accountEmail &&
          Number.isFinite(hint.expiresAt) && hint.expiresAt > Date.now() && hint.expiresAt <= Date.now() + 301000 &&
          ["pending", "waking", "leased", "reading"].includes(hint.state));
        const retired = new Set();
        for (const pending of [...mailJobs.values()]) {
          const hint = hints.find(item => item.requestId === pending.job.requestId);
          if (pending.restored && hint?.state === "leased" && !pending.boundDocument && Number.isInteger(pending.tabId)) {
            pending.restored = false;
            pending.running = false;
            pending.creating = false;
            armMailDeadline(pending);
            await saveMailWork();
          }
          if (pending.restored || !hint || pending.job.expiresAt <= Date.now()) {
            // Never replay a read/row authorization after suspension. Report interruption
            // explicitly instead of losing a lease and waiting for the desktop timeout.
            if (hint) await dispatchResult(hint.requestId, "interrupted");
            retired.add(pending.job.requestId);
            pending.ended = true;
            stopMailRead(pending);
            clearTimeout(pending.timer);
            mailJobs.delete(pending.job.requestId);
            if (Number.isInteger(pending.tabId)) mailCleanup.set(pending.tabId, { ...pending, timer: undefined });
            await saveMailWork();
            await retryMailCleanup();
          } else if (!pending.boundDocument && !pending.creating) {
            const tab = await boundedTabCall(chrome.tabs.get(pending.tabId)).catch(() => undefined);
            if (!tab) { void connectMailTab(pending); continue; }
            if (tab?.url === pending.targetUrl) void connectMailTab(pending);
            else await finishMailJob(pending, { code: "interrupted", interacted: true });
          }
        }
        for (const wake of [...mailWakes.values()]) {
          const hint = hints.find(item => item.requestId === wake.requestId);
          if (mailJobs.has(wake.requestId)) continue;
          if (!hint || retired.has(wake.requestId) || ["leased", "reading"].includes(hint.state) || wake.expiresAt <= Date.now()) {
            await retireWake(wake);
            continue;
          }
          if (Date.now() - wake.createdAt >= REGISTRATION_TIMEOUT_MS) {
            await dispatchResult(wake.requestId, "document-not-ready");
            retired.add(wake.requestId);
            await retireWake(wake);
            continue;
          }
          // Only our new bootstrap tab can be nudged; sleeping user tabs are never touched.
          if (Number.isInteger(wake.tabId)) {
            const tab = await boundedTabCall(chrome.tabs.get(wake.tabId)).catch(() => undefined);
            if (!tab) { void connectMailTab(wake); continue; }
            if (wakeTabChanged(wake, tab)) {
              wake.interacted = true;
              await dispatchResult(wake.requestId, "interrupted");
              retired.add(wake.requestId);
              await retireWake(wake);
            } else if (wakeLocation(wake, tab.url)) {
              wake.seenUrl = true;
              await saveMailWork();
              void connectMailTab(wake);
            }
          }
        }
        for (const hint of hints) {
          if (generation !== mailGeneration) return;
          if (retired.has(hint.requestId) || mailFinishing.has(hint.requestId)) continue;
          if (["leased", "reading"].includes(hint.state)) {
            if (!mailJobs.has(hint.requestId) && !mailPolling.has(hint.accountEmail))
              await dispatchResult(hint.requestId, "interrupted");
            continue;
          }
          if (mailWakes.has(hint.requestId) || [...mailWakes.values()].some(wake => wake.accountId === hint.accountId) ||
            [...mailJobs.values()].some(pending => pending.job.input.accountId === hint.accountId)) continue;
          // A waking hint with no journal is an interrupted creation, not permission
          // to create a second tab (including after extension/browser restart).
          if (hint.state === "waking") {
            await dispatchResult(hint.requestId, "interrupted");
            continue;
          }
          try {
            await dispatchResult(hint.requestId, "wake");
          } catch { continue; } // Another verified page/client may have leased it first.
          if (generation !== mailGeneration) return;
          const [original] = await chrome.tabs.query({ active: true, currentWindow: true });
          const owner = [...mailWakes.values(), ...mailJobs.values()].find(item => item.tabId === original?.id);
          const wake = { ...hint, targetUrl: canonicalInbox(hint.accountEmail), awaitingHeader: true,
            createdAt: Date.now(), windowId: original?.windowId,
            originalTabId: owner ? owner.originalTabId : original?.id, creating: true,
            activations: [], selectionChanged: Boolean(owner?.selectionChanged), interacted: false };
          mailWakes.set(hint.requestId, wake);
          await saveMailWork();
          let releaseCreation;
          const creation = new Promise(resolve => { releaseCreation = resolve; });
          mailCreations.set(wake.requestId, { wake, promise: creation });
          try {
            // Navigate only as part of creation. about:blank URLs are redacted without
            // broad tabs permission; never update an existing tab to work around that.
            const tab = await acquireMailTab("wake", wake.targetUrl, hint.accountEmail, wake.windowId, undefined,
              () => generation === mailGeneration && hint.expiresAt > Date.now() && mailWakes.get(hint.requestId) === wake);
            if (tab.reused) {
              wake.targetUrl = tab.url;
              wake.awaitingHeader = false;
            }
            wake.tabId = tab.id;
            wake.windowId = tab.windowId;
            wake.seenUrl = wakeLocation(wake, tab.url);
            wake.interacted ||= tab.active === true || wake.activations.includes(tab.id);
            wake.selectionChanged ||= wake.activations.some(id => id !== tab.id);
            wake.creating = false;
            await saveMailWork();
            if (generation !== mailGeneration || hint.expiresAt <= Date.now()) {
              await retireWake(wake);
              continue;
            }
            const untouched = await boundedTabCall(chrome.tabs.get(tab.id)).catch(() => undefined);
            if (generation !== mailGeneration) { await retireWake(wake); continue; }
            if (!untouched) { void connectMailTab(wake); continue; }
            if (wake.interacted || untouched.active || wakeTabChanged(wake, untouched)) {
              wake.interacted = true;
              await dispatchResult(hint.requestId, "interrupted");
              await retireWake(wake);
              continue;
            }
            void connectMailTab(wake);
          } catch (error) {
            if (error.code !== "TAB_CAPACITY")
              recordTabReason(error.code === "TAB_OPERATION_TIMEOUT" ? "inspectionTimeout" : "allocationFailed");
            await dispatchResult(hint.requestId, "delivery-failed");
            await retireWake(wake);
          } finally {
            mailCreations.delete(wake.requestId);
            releaseCreation();
          }
        }
      })().finally(() => { wakeCheck = undefined; });
      return wakeCheck;
    }

    // Relay Desk writes a per-launch secret into the installed companion folder, so a
    // companion whose storage was reset (reinstall, moved folder) re-pairs without a code.
    let autoPairing;
    let autoPairAttemptAt = 0;
    function autoPair() {
      if (autoPairing) return autoPairing;
      if (Date.now() - autoPairAttemptAt < 15000 || typeof chrome.runtime?.getURL !== "function") return Promise.resolve(undefined);
      autoPairAttemptAt = Date.now();
      autoPairing = (async () => {
        try {
          const stored = await chrome.storage.local.get(["token", "autoPairOff"]);
          if (stored.token) return stored.token;
          if (stored.autoPairOff) return undefined;
          const file = await fetchRequest(chrome.runtime.getURL("relay-pairing.json"), { cache: "no-store" });
          if (!file || !file.ok) return undefined;
          const data = await file.json();
          if (!data || typeof data.secret !== "string" || !/^[a-f0-9]{64}$/.test(data.secret)) return undefined;
          const result = await request("/pair", { bootstrap: data.secret }, true);
          if (!result || typeof result.token !== "string" || !result.token || result.token.length > 4096) return undefined;
          if ((await chrome.storage.local.get("token")).token) return (await chrome.storage.local.get("token")).token;
          await chrome.storage.local.set({ token: result.token });
          grants.clear();
          calendarJobs.clear();
          cancelMailJobs();
          void reconcileOpenTabs().catch(() => {});
          return result.token;
        } catch { return undefined; }
        finally { autoPairing = undefined; }
      })();
      return autoPairing;
    }

    chrome.alarms?.onAlarm.addListener(alarm => {
      if (alarm.name === MAIL_WAKE_ALARM) {
        void autoPair();
        void checkMailWake(true).catch(() => {});
      }
    });
    void ready.then(() => autoPair()).catch(() => {});
    if (chrome.alarms) {
      void Promise.resolve(chrome.alarms.create(MAIL_WAKE_ALARM, { periodInMinutes: 0.5 }))
        .then(() => checkMailWake(true)).catch(() => {});
    }

    async function request(path, body, pairing = false) {
      await ready;
      let { token } = await chrome.storage.local.get("token");
      if (!pairing && !token) token = await autoPair();
      if (!pairing && !token) throw new Error("Pair with Relay Desk first: open the desktop Browser settings and enter its pairing code.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetchRequest(`${BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(!pairing ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error"
        });
      } catch {
        throw new Error("Relay Desk is unavailable. Open and unlock the desktop app, enable browser access, then retry. Your pairing has been kept.");
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        if (!pairing && response.status === 401) {
          const current = await chrome.storage.local.get("token");
          if (current.token === token) await chrome.storage.local.remove("token");
          grants.clear();
          cancelMailJobs();
          throw new Error("Pairing was revoked or expired. Generate a new code in Relay Desk and pair again.");
        }
        let detail = "";
        try {
          const data = await response.json();
          if (typeof data.error === "string") detail = ` ${data.error.slice(0, 300)}`;
        } catch { }
        throw new Error(`Relay Desk rejected the request (${response.status}).${detail || " Check the desktop browser settings and selected sources."}`);
      }
      try { return await response.json(); }
      catch { throw new Error("Relay Desk returned an invalid response. Update or restart the desktop app; your pairing has been kept."); }
    }

    async function validateTab(sender, registration) {
      if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) {
        throw new Error("Only a top-level supported browser tab can register or capture.");
      }
      if (!registration || typeof registration.accountEmail !== "string"
        || !(registration.kind === "whatsapp" ? /^\+[1-9]\d{6,14}$/ : /^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(registration.accountEmail)
        || registration.accountEmail.length > 254 || typeof registration.accountName !== "string" || registration.accountName.length > 300
        || typeof registration.pageUrl !== "string" || registration.pageUrl.length > 4096) {
        throw new Error("Invalid account registration.");
      }
      const kind = extractors.pageKind(registration.pageUrl);
      if (registration.chat !== undefined && (kind !== "whatsapp" || !registration.chat
        || typeof registration.chat.id !== "string" || !/^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/.test(registration.chat.id)
        || typeof registration.chat.name !== "string" || !registration.chat.name || registration.chat.name.length > 512))
        throw new Error("Invalid WhatsApp conversation registration.");
      const current = await chrome.tabs.get(sender.tab.id);
      if (current.pendingUrl || sender.url !== registration.pageUrl || sender.tab.url !== registration.pageUrl || current.url !== registration.pageUrl
        || kind !== registration.kind) throw new Error("The tab URL or page type changed. Wait for the page to load and retry.");
      return {
        accountEmail: registration.accountEmail.toLowerCase(),
        accountName: registration.accountName,
        pageUrl: registration.pageUrl,
        kind,
        ...(registration.chat ? { chat: { id: registration.chat.id, name: registration.chat.name } } : {})
      };
    }

    function grantKey(sender, registration) {
      return `${sender.tab.id}:${registration.pageUrl}:${registration.kind}:${registration.accountEmail}:${registration.chat?.id || ""}`;
    }

    chrome.tabs.onActivated?.addListener(async info => {
      await ready;
      for (const entry of ownedTabs.values()) {
        if (entry.creating) entry.activations.push(info.tabId);
        if (entry.tabId === info.tabId) entry.protected = true;
      }
      for (const pending of mailJobs.values()) {
        if (pending.windowId !== info.windowId) continue;
        if (pending.creating) pending.activations.push(info.tabId);
        else if (info.tabId !== pending.tabId) pending.selectionChanged = true;
        else pending.interacted = true;
      }
      for (const wake of new Set([...mailWakes.values(), ...[...mailCreations.values()].map(item => item.wake)])) {
        if (wake.creating) (wake.activations ||= []).push(info.tabId);
        if (info.tabId === wake.tabId && !wake.creating) wake.interacted = true;
        if (wake.windowId === info.windowId && !wake.creating && info.tabId !== wake.tabId &&
          ![...mailJobs.values()].some(job => job.sourceTabId === wake.tabId && (job.creating || job.tabId === info.tabId)))
          wake.selectionChanged = true;
      }
      for (const pending of mailCleanup.values()) {
        if (pending.windowId !== info.windowId) continue;
        if (info.tabId === pending.tabId) pending.interacted = true;
        else pending.selectionChanged = true;
      }
      void ready.then(saveMailWork).catch(() => {});
    });
    chrome.tabs.onRemoved?.addListener(async tabId => {
      await ready;
      const entry = ownedTab(tabId);
      if (entry) ownedTabs.delete(entry.key);
      const pending = [...mailJobs.values()].find(job => job.tabId === tabId);
      if (pending) void finishMailJob(pending, { code: "interrupted", interacted: true });
      const wake = [...mailWakes.values()].find(item => item.tabId === tabId);
      if (wake) {
        mailWakes.delete(wake.requestId);
        void saveMailWork();
        if (!mailJobs.has(wake.requestId)) void dispatchResult(wake.requestId, "interrupted").catch(() => {});
      }
      verifiedTabs.delete(tabId);
      mailCleanup.delete(tabId);
      void saveMailWork();
    });
    chrome.tabs.onUpdated?.addListener(async (tabId, change) => {
      await ready;
      for (const pending of ownedTabs.values()) {
        if (pending.creating && (change.pinned === true || (change.url && change.url !== pending.url &&
          !(pending.kind === "mail" && safeWakeRoute(change.url))))) (pending.changedTabs ||= []).push(tabId);
      }
      const entry = ownedTab(tabId);
      if (entry && change.pinned === true) {
        entry.protected = true;
        void ready.then(saveMailWork).catch(() => {});
      }
      if (entry && change.status === "complete" &&
        [...mailWakes.values(), ...mailJobs.values()].some(pending => pending.tabId === tabId && !pending.boundDocument))
        for (const pending of [...mailWakes.values(), ...mailJobs.values()])
          if (pending.tabId === tabId && !pending.boundDocument) void connectMailTab(pending);
      if (!change.url && change.status !== "loading") return;
      if (entry) {
        const pending = [...mailWakes.values(), ...mailJobs.values(), ...mailCleanup.values()].find(item => item.tabId === tabId);
        const allowed = !change.url || change.url === entry.url || (entry.loading && entry.role !== "reader" &&
          entry.kind === "mail" && safeWakeRoute(change.url)) ||
          (pending?.rowProof && extractors.mailConversationRoute(pending.rowProof.inboxUrl, change.url) &&
            (!pending.rowProof.targetUrl || pending.rowProof.targetUrl === change.url));
        // Chrome also reports loading for same-document Gmail hash transitions.
        // Loading alone is not user interaction. Document-targeted status and the
        // next registration still reject replaced documents before reuse/read.
        if (change.url && !allowed) entry.protected = true;
      }
      for (const pending of [...mailWakes.values(), ...mailJobs.values(), ...mailCleanup.values()]) {
        if (pending.tabId === tabId && pending.awaitingHeader && wakeLocation(pending, change.url)) pending.seenUrl = true;
        if (!change.url) continue;
        if (pending.tabId !== tabId || pending.creating || change.url === pending.targetUrl ||
          (pending.awaitingHeader && wakeLocation(pending, change.url)) ||
          (pending.rowProof && extractors.mailConversationRoute(pending.rowProof.inboxUrl, change.url) &&
            (!pending.rowProof.targetUrl || pending.rowProof.targetUrl === change.url))) continue;
        pending.interacted = true;
      }
      void ready.then(saveMailWork).catch(() => {});
    });

    async function cleanMailTab(pending) {
      const entry = ownedTab(pending.tabId);
      if (!entry) return true; // Legacy records are not proof of pool ownership.
      entry.busy = false;
      entry.protected ||= pending.interacted === true;
      entry.idleAt = pending.retiredAt ||= Date.now();
      const tab = await chrome.tabs.get(pending.tabId).catch(() => undefined);
      if (!tab) { ownedTabs.delete(entry.key); return true; }
      const allowed = tab.url === (pending.cleanupUrl || pending.targetUrl) ||
        (pending.awaitingHeader && wakeLocation(pending, tab.url)) ||
        (pending.rowProof && extractors.mailConversationRoute(pending.rowProof.inboxUrl, tab.url) &&
          (!pending.rowProof.targetUrl || pending.rowProof.targetUrl === tab.url));
      if (allowed) entry.url = tab.url;
      else if (tab.url) entry.protected = true;
      if (entry.protected) return true;
      return Boolean(await inspectOwned(entry));
    }

    function cancelMailJobs() {
      mailGeneration++;
      for (const pending of mailJobs.values()) {
        pending.ended = true;
        stopMailRead(pending);
        void cancelOwnedDownload(chrome, pending.downloadId);
        clearTimeout(pending.timer);
        if (Number.isInteger(pending.tabId)) mailCleanup.set(pending.tabId, { ...pending, timer: undefined });
      }
      mailJobs.clear();
      mailPolling.clear();
      for (const wake of mailWakes.values()) if (Number.isInteger(wake.tabId)) mailCleanup.set(wake.tabId, wake);
      mailWakes.clear();
      mailRoutes.clear();
      void saveMailWork();
      void retryMailCleanup();
    }

    function safeMailDiagnostics(value) {
      const result = {};
      for (const key of ["containers", "bodies", "senders", "threadMarkers", "rows", "matchingRows",
        "refreshMutations", "refreshQuietMs", "refreshBusy", "extractedRows"])
        result[key] = Number.isInteger(value?.[key]) && value[key] >= 0 && value[key] <= 10000 ? value[key] : 0;
      return result;
    }

    async function mailTabStatus(pending, documentId) {
      try {
        const response = await boundedTabCall(chrome.tabs.sendMessage(pending.tabId,
          { type: "relay-tab", action: "mail-read-status", input: pending.job.input },
          documentId ? { documentId } : { frameId: 0 }), Math.max(1,
            Math.min(TAB_INSPECTION_MS, (pending.job.expiresAt || Date.now() + TAB_INSPECTION_MS) - Date.now())));
        if (response?.ok) {
          pending.diagnostics = safeMailDiagnostics(response.value?.diagnostics);
          return response.value;
        }
        recordTabReason("inspectionUnavailable");
      } catch (error) {
        recordTabReason(error.code === "TAB_OPERATION_TIMEOUT" ? "inspectionTimeout" : "inspectionUnavailable");
      }
      return undefined;
    }

    async function readyMailReader(pending) {
      const deadline = Math.min(pending.job.expiresAt - 1000, Date.now() + 5000);
      while (!pending.ended && Date.now() < deadline) {
        const entry = ownedTab(pending.tabId), observed = {};
        const tab = await inspectOwned(entry, true, observed, true);
        if (pending.ended) return undefined;
        if (tab) return tab;
        const registration = observed.response?.value?.registration;
        if (!entry || entry.protected || pending.interacted || observed.tab?.active || observed.tab?.pinned
          || (observed.tab?.url && observed.tab.url !== pending.targetUrl)
          || (observed.tab?.pendingUrl && observed.tab.pendingUrl !== pending.targetUrl)
          || (registration && (registration.accountEmail !== pending.job.input.accountEmail
            || registration.pageUrl !== pending.targetUrl))) return undefined;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))));
      }
      return undefined;
    }

    async function finishMailJob(pending, result) {
      if (pending.ended) return;
      pending.ended = true;
      if (result.code !== "complete") stopMailRead(pending);
      if (["partial", "unsupported"].includes(result.code)) {
        const phases = ["waitingHeader", "waitingMain", "waitingExactRow", "waitingNavigation", "waitingExpansion", "waitingStableBody"];
        if (Number.isInteger(result.diagnostics?.readPhase)) recordTabReason(phases[result.diagnostics.readPhase - 1]);
      }
      if (result.code !== "complete") await cancelOwnedDownload(chrome, pending.downloadId);
      mailFinishing.add(pending.job.requestId);
      clearTimeout(pending.timer);
      mailJobs.delete(pending.job.requestId);
      pending.interacted ||= result.interacted === true;
      if (Number.isInteger(pending.tabId)) mailCleanup.set(pending.tabId, { ...pending, timer: undefined });
      try {
        await saveMailWork();
        await request("/mail/complete", { ...pending.binding, requestId: pending.job.requestId, lease: pending.job.lease,
          code: ATTACHMENT_COMPLETION_CODES[result.code] || result.code,
          ...(result.code === "complete" && result.capture ? { capture: result.capture } : {}),
          diagnostics: safeMailDiagnostics(result.diagnostics || pending.diagnostics) });
      } catch { /* No retries: an expired/revoked lease must never upload later. */ }
      finally {
        await retryMailCleanup();
        const wake = mailWakes.get(pending.job.requestId);
        if (wake) await retireWake(wake);
        mailFinishing.delete(pending.job.requestId);
        void (wakeCheck || Promise.resolve()).then(() => checkMailWake(true)).catch(() => {});
      }
    }

    function armMailDeadline(pending) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        void dispatchResult(pending.job.requestId, pending.boundDocument ? "read-in-progress" : "document-not-ready")
          .catch(() => {}).finally(() => finishMailJob(pending, { code: "unavailable" }));
      }, Math.max(1, pending.job.expiresAt - Date.now() - 1000));
    }

    async function pollMail(sender, registration) {
      if (typeof sender.documentId !== "string" || !sender.documentId || sender.documentId.length > 128 ||
        mailPolling.has(registration.accountEmail) || mailJobs.size >= 3 ||
        [...mailJobs.values()].some(pending => pending.job.input.accountEmail === registration.accountEmail)) return;
      const current = new URL(registration.pageUrl);
      if (!/^\/mail\/u\/\d+\/$/.test(current.pathname) || current.hash !== "#inbox") return;
      const verified = verifiedTabs.get(sender.tab.id);
      if (verified?.email !== registration.accountEmail || verified.pageUrl !== registration.pageUrl) return;
      mailPolling.add(registration.accountEmail);
      const generation = mailGeneration;
      let pending;
      let leasedRequestId;
      try {
        const binding = { protocol: 1, registration, tabId: sender.tab.id, documentId: sender.documentId };
        const bootstrap = [...mailWakes.values()].find(wake => wake.tabId === sender.tab.id);
        const response = await request("/mail/poll", { ...binding, ...(bootstrap ? { wakeRequestId: bootstrap.requestId } : {}) });
        if (generation !== mailGeneration) return;
        if (!response?.job) return;
        const job = response.job;
        if (job.protocol !== 1 || !/^[a-f0-9]{32}$/.test(job.requestId) || !/^[a-f0-9]{64}$/.test(job.lease) ||
          job.input?.accountEmail !== registration.accountEmail || !/^[A-Za-z0-9_-]{1,256}$/.test(job.input.threadId) ||
          !Number.isFinite(job.expiresAt) || job.expiresAt <= Date.now() ||
          job.expiresAt > Date.now() + (job.input.attachment ? 301000 : 91000) ||
          (job.input.attachment && !validAttachmentIntent(job.input))) return;
        leasedRequestId = job.requestId;
        await validateTab(sender, registration);
        const source = await chrome.tabs.get(sender.tab.id);
        const [original] = await chrome.tabs.query({ active: true, windowId: source.windowId });
        if (generation !== mailGeneration) return;
        const target = new URL(current.origin + current.pathname);
        target.hash = "inbox";
        pending = { job, binding, targetUrl: target.href, windowId: source.windowId, originalTabId: original?.id,
          sourceTabId: sender.tab.id, sourceDocumentId: sender.documentId, creating: true, activations: [],
          selectionChanged: false, interacted: false, ended: false };
        const wake = mailWakes.get(job.requestId);
        if (wake) {
          pending.originalTabId = wake.originalTabId;
          pending.selectionChanged = wake.selectionChanged;
        }
        mailJobs.set(job.requestId, pending);
        await saveMailWork();
        armMailDeadline(pending);
        const tab = await acquireMailTab("reader", target.href, registration.accountEmail, source.windowId, sender.tab.id,
          () => generation === mailGeneration && !pending.ended && job.expiresAt > Date.now());
        pending.tabId = tab.id;
        pending.creating = false;
        pending.selectionChanged ||= pending.activations.some(id => id !== tab.id);
        pending.interacted ||= Boolean(tab.active || tab.pinned || ownedTab(tab.id)?.protected);
        await saveMailWork();
        if (pending.ended || generation !== mailGeneration) {
          mailCleanup.set(pending.tabId, { ...pending, timer: undefined });
          await saveMailWork();
          await retryMailCleanup();
        }
        else void connectMailTab(pending);
      } catch (error) {
        if (error.code !== "TAB_CAPACITY")
          recordTabReason(error.code === "TAB_OPERATION_TIMEOUT" ? "inspectionTimeout" : "allocationFailed");
        if (pending) await finishMailJob(pending, { code: "unavailable" });
        else if (leasedRequestId && generation === mailGeneration)
          await dispatchResult(leasedRequestId, "delivery-failed").catch(() => {});
      } finally { mailPolling.delete(registration.accountEmail); }
    }

    async function readDedicatedMail(pending, sender, registration) {
      if (pending.running || pending.ended) return;
      pending.running = true;
      try {
        const before = await mailTabStatus(pending, sender.documentId);
        const tab = await boundedTabCall(chrome.tabs.get(pending.tabId)).catch(() => undefined);
        if (pending.ended || pending.job.expiresAt <= Date.now()) return;
        if (!tab) {
          pending.running = false;
          void connectMailTab(pending);
          return;
        }
        if (registration.accountEmail !== pending.job.input.accountEmail) {
          recordTabReason("documentMismatch");
          await finishMailJob(pending, { code: "account-mismatch" });
          return;
        }
        if (pending.interacted || ownedTab(pending.tabId)?.protected || tab.active || tab.pinned
          || (tab.pendingUrl && tab.pendingUrl !== pending.targetUrl) || before?.dirty === true) {
          recordTabReason(pending.interacted || ownedTab(pending.tabId)?.protected || tab.active || tab.pinned || before?.dirty === true
            ? "protectedTab" : tab.pendingUrl ? "documentMismatch" : "readerStatusUnavailable");
          await finishMailJob(pending, { code: "interrupted", interacted: before?.dirty === true || tab.active || tab.pinned });
          return;
        }
        if (registration.pageUrl !== pending.targetUrl || typeof sender.documentId !== "string") {
          recordTabReason("documentMismatch");
          await finishMailJob(pending, { code: "thread-mismatch" });
          return;
        }
        if (tab.status === "loading" || tab.pendingUrl || before?.dirty !== false || !before.registration) {
          recordTabReason(tab.status === "loading" || tab.pendingUrl ? "readerLoading" : "readerStatusUnavailable");
          pending.running = false;
          await saveMailWork();
          void connectMailTab(pending);
          return; // onUpdated(complete), discover or the alarm retries this unbound lease.
        }
        if (before.registration.accountEmail !== registration.accountEmail || before.registration.pageUrl !== registration.pageUrl) {
          await finishMailJob(pending, { code: "account-mismatch" });
          return;
        }
        const binding = { protocol: 1, registration, tabId: sender.tab.id, documentId: sender.documentId };
        await request("/mail/poll", { ...binding, requestId: pending.job.requestId, lease: pending.job.lease,
          sourceTabId: pending.sourceTabId, sourceDocumentId: pending.sourceDocumentId });
        pending.binding = binding;
        pending.boundDocument = sender.documentId;
        await saveMailWork();
        await validateTab(sender, registration);
        if (pending.ended) return;
        if (!await readyMailReader(pending)) {
          await finishMailJob(pending, { code: "interrupted" });
          return;
        }
        const wake = mailWakes.get(pending.job.requestId);
        if (wake) {
          wake.selectionChanged = true;
          await retireWake(wake);
        }
        if (pending.ended || pending.job.expiresAt <= Date.now()) return;
        const response = await chrome.tabs.sendMessage(pending.tabId,
          { type: "relay-tab", action: "mail-read", job: pending.job }, { documentId: sender.documentId });
        const result = response?.ok && response.value;
        if (!result || !["complete", "unavailable", "account-mismatch", "thread-mismatch", "unsupported", "partial", "interrupted",
          ...ATTACHMENT_CODES].includes(result.code))
          throw new Error("Invalid mail read result.");
        const status = await mailTabStatus(pending, sender.documentId);
        const currentTab = await chrome.tabs.get(pending.tabId);
        if (result.code === "complete") {
          const captured = result.capture;
          if (pending.job.input.attachment &&
            (!pending.attachmentDownload || JSON.stringify(captured?.attachmentDownload) !== JSON.stringify(pending.attachmentDownload)))
            throw new Error("Missing verified attachment download.");
          if (!pending.job.input.attachment && captured?.attachmentDownload) throw new Error("Unexpected attachment download.");
          const inbox = pending.job.input.inboxRefresh === true;
          if ((!inbox && !pending.rowProof) || captured?.accountEmail !== registration.accountEmail || captured?.kind !== "mail" ||
            captured?.pageUrl !== currentTab.url || captured?.pageUrl !== status?.registration?.pageUrl ||
            captured?.accountEmail !== status?.registration?.accountEmail || status?.dirty !== false || result.interacted ||
            pending.interacted || ownedTab(pending.tabId)?.protected || currentTab.active || currentTab.pinned || currentTab.pendingUrl ||
            (inbox ? captured.pageUrl !== pending.targetUrl || new URL(captured.pageUrl).hash !== "#inbox"
              || captured.messages?.some(message => message.completeness !== "preview")
              : !extractors.mailConversationRoute(pending.rowProof.inboxUrl, captured.pageUrl) ||
                (pending.rowProof.targetUrl && pending.rowProof.targetUrl !== captured.pageUrl))) throw new Error("Mail read changed.");
          const { messages: _messages, meetings: _meetings, attachmentDownload: _download, ...completedRegistration } = captured;
          pending.binding = { ...binding, registration: completedRegistration };
          pending.cleanupUrl = captured.pageUrl;
        }
        if (result.code !== "complete") recordTabReason("readUnavailable");
        await finishMailJob(pending, result);
      } catch {
        recordTabReason("readUnavailable");
        await finishMailJob(pending, { code: "interrupted" });
      }
    }

    function accountMenuUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "ogs.google.com" && !url.port && !url.username && !url.password
          && !url.hash && /^\/(?:u\/\d+\/)?widget\/account\/?$/.test(url.pathname);
      } catch {
        return false;
      }
    }

    function supportedTabUrl(value) {
      try {
        extractors.pageKind(value);
        return true;
      } catch {
        return false;
      }
    }

    function candidateHref(value) {
      try {
        const url = new URL(value);
        const validRoute = (url.hostname === "mail.google.com" && /^\/mail\/u\/\d+\/$/.test(url.pathname))
          || (url.hostname === "calendar.google.com" && /^\/calendar\/u\/\d+\/?$/.test(url.pathname));
        if (url.protocol !== "https:" || !validRoute || url.port || url.username || url.password || url.search || url.hash) return undefined;
        return url.href;
      } catch {
        return undefined;
      }
    }

    function normalizeCandidateEmail(value) {
      if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return undefined;
      return value.toLowerCase();
    }

    function validateMenuMetadata(message) {
      if (!Array.isArray(message.candidates) || message.candidates.length > MAX_MENU_ACCOUNTS
        || !Number.isInteger(message.expired) || message.expired < 0 || message.expired > MAX_MENU_ACCOUNTS) {
        throw new Error("Google's account menu returned invalid or excessive metadata.");
      }
      const candidates = [];
      const seen = new Set();
      for (const candidate of message.candidates) {
        if (!candidate || typeof candidate !== "object") throw new Error("Google's account menu returned an invalid account row.");
        const email = normalizeCandidateEmail(candidate.email);
        const href = typeof candidate.href === "string" && candidate.href.length <= 2048 ? candidateHref(candidate.href) : undefined;
        if (!email || !href) throw new Error("Google's account menu returned an invalid account row.");
        if (seen.has(email)) continue;
        seen.add(email);
        candidates.push({ email, href });
      }
      return { candidates, expired: message.expired };
    }

    async function validateMenuSender(sender, scanId) {
      if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)
        || !Number.isInteger(sender.frameId) || sender.frameId <= 0 || !accountMenuUrl(sender.url)) {
        throw new Error("Only Google's account-menu child frame can report account candidates.");
      }
      const pending = pendingMenuScans.get(sender.tab.id);
      if (!pending || (scanId !== undefined && pending.scanId !== scanId)) {
        throw new Error("No explicit account discovery scan is pending for this tab.");
      }
      const current = await chrome.tabs.get(sender.tab.id);
      if (!current || current.url !== sender.tab.url || !supportedTabUrl(sender.tab.url)) {
        throw new Error("The Google tab changed while its account menu was being read.");
      }
      return pending;
    }

    function beginMenuScan(tabId) {
      const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const timer = setTimeout(() => {
        const pending = pendingMenuScans.get(tabId);
        if (!pending || pending.scanId !== scanId) return;
        pendingMenuScans.delete(tabId);
        reject(new Error("Google's account menu did not respond. Reload the chosen Gmail or Calendar tab once, wait for its header, and retry."));
      }, MENU_TIMEOUT_MS);
      pendingMenuScans.set(tabId, { scanId, resolve, reject, timer });
      return promise;
    }

    function cancelMenuScan(tabId, error) {
      const pending = pendingMenuScans.get(tabId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingMenuScans.delete(tabId);
      pending.reject(error);
    }

    async function expectTabRegistration(tabId, email) {
      const verified = verifiedTabs.get(tabId);
      if (verified?.documentId && (!email || verified.email === email)) {
        try {
          const status = await ownedStatus({ tabId, documentId: verified.documentId });
          const tab = await boundedTabCall(chrome.tabs.get(tabId));
          if (!tab.pendingUrl && tab.url === verified.pageUrl && status?.ok &&
            status.value?.registration?.pageUrl === tab.url && status.value.registration.accountEmail === verified.email)
            return verified;
        } catch { }
      }
      const waiting = expectedTabs.get(tabId);
      if (waiting && waiting.email === email) return waiting.promise;
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const timer = setTimeout(() => {
        const expected = expectedTabs.get(tabId);
        if (!expected || expected.email !== email) return;
        expectedTabs.delete(tabId);
        reject(new Error("The account did not load a verified Google header in time. Sign in or wait for the new tab to load, then use Discover open Google accounts."));
      }, REGISTRATION_TIMEOUT_MS);
      expectedTabs.set(tabId, { email, resolve, reject, timer, promise });
      return promise;
    }

    function rejectExpectedRegistration(tabId, error) {
      const expected = expectedTabs.get(tabId);
      if (!expected) return;
      clearTimeout(expected.timer);
      expectedTabs.delete(tabId);
      expected.reject(error);
    }

    async function ensureAccountReader() {
      const granted = await chrome.permissions.contains({
        permissions: ["scripting"],
        origins: ["https://ogs.google.com/*"]
      });
      if (!granted) {
        throw new Error("Optional Google account-menu access is missing. Use Discover signed-in Google accounts in the popup and allow the requested access.");
      }
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ACCOUNT_SCRIPT_ID] });
      if (existing.length) return;
      await chrome.scripting.registerContentScripts([{
        id: ACCOUNT_SCRIPT_ID,
        matches: ACCOUNT_SCRIPT_MATCHES,
        js: ["accounts.js"],
        allFrames: true,
        runAt: "document_idle",
        world: "ISOLATED",
        persistAcrossSessions: true
      }]);
    }

    function authuserEmail(value) {
      try {
        const url = new URL(value);
        if (!supportedTabUrl(url.href)) return undefined;
        return normalizeCandidateEmail(url.searchParams.get("authuser"));
      } catch {
        return undefined;
      }
    }

    function canonicalInbox(email) {
      const url = new URL("https://mail.google.com/mail/");
      url.searchParams.set("authuser", email);
      url.hash = "inbox";
      return url.href;
    }

    function accountLink(value) {
      if (typeof value !== "string" || value.length > 4096) throw new Error("Paste a Gmail or Google Calendar account link.");
      let url;
      try { url = new URL(value.trim()); } catch { throw new Error("Paste a complete HTTPS Gmail or Google Calendar link."); }
      const kind = extractors.pageKind(url.href);
      if (kind === "whatsapp") throw new Error("Use Open WhatsApp Web, not a Google account link.");
      const base = kind === "mail" ? "/mail" : "/calendar";
      const route = url.pathname.slice(base.length);
      if (/%|\\/.test(route) || (route.startsWith("/u/") && !/^\/u\/\d+(?:\/|$)/.test(route))) {
        throw new Error("The Google account route is invalid.");
      }
      const slot = route.match(/^\/u\/(\d+)(?:\/|$)/)?.[1];
      const values = url.searchParams.getAll("authuser");
      if (values.length > 1) throw new Error("The account link contains multiple account selectors.");
      const authuser = values[0];
      if (authuser !== undefined && !/^\d+$/.test(authuser) && !normalizeCandidateEmail(authuser)) {
        throw new Error("The account selector must be a Google account number or email address.");
      }
      const canonical = new URL(`${base}/${slot === undefined ? "" : `u/${slot}/`}`, url.origin);
      if (authuser !== undefined) canonical.searchParams.set("authuser", authuser);
      canonical.hash = kind === "mail" ? "inbox" : "agenda";
      return { url: canonical.href, email: normalizeCandidateEmail(authuser) };
    }

    async function openAccountLink(value) {
      const link = accountLink(value);
      await ready;
      if (!(await chrome.storage.local.get("token")).token) throw new Error("Pair this browser with Relay Desk before adding an account.");
      const { tab, verified } = await openView(link.url, link.email);
      if (!tab || !Number.isInteger(tab.id)) throw new Error("Could not create the account tab.");
      const registration = verified ? Promise.resolve() : expectTabRegistration(tab.id, link.email);
      registration.catch(() => { });
      try {
        if (!verified) void sendTabAction(tab.id, "connect").catch(() => {});
        await registration;
        return { message: "Account verified and added to Relay Desk. Select its Gmail and Calendar sources in the desktop app. AI remains a separate opt-in." };
      } catch (error) {
        rejectExpectedRegistration(tab.id, error);
        await registration.catch(() => { });
        throw error;
      }
    }

    async function discoverSignedInAccounts() {
      await ready;
      const { token } = await chrome.storage.local.get("token");
      if (!token) throw new Error("Pair with Relay Desk before discovering signed-in Google accounts.");
      if (accountScanActive) throw new Error("A signed-in Google account discovery scan is already running.");
      accountScanActive = true;
      try {
        await ensureAccountReader();
        const tabs = await chrome.tabs.query({ url: GOOGLE_URLS });
        const rank = tab => (verifiedTabs.get(tab.id)?.pageUrl === tab.url ? 0 : 2)
          + (typeof tab.url === "string" && tab.url.startsWith("https://mail.google.com/") ? 0 : 1);
        tabs.sort((left, right) => rank(left) - rank(right));
        let metadata;
        let responsiveTab;
        let lastError;
        for (const tab of tabs) {
          if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string" || !supportedTabUrl(tab.url)) continue;
          const menuPromise = beginMenuScan(tab.id);
          menuPromise.catch(() => { });
          try {
            await sendTabAction(tab.id, "discover-accounts");
            await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["accounts.js"], world: "ISOLATED" });
            metadata = await menuPromise;
            responsiveTab = tab;
            break;
          } catch (error) {
            lastError = error;
            cancelMenuScan(tab.id, error);
            await menuPromise.catch(() => { });
          } finally {
            try { await sendTabAction(tab.id, "close-account-menu"); } catch { }
          }
        }
        if (!metadata || !responsiveTab) {
          if (!tabs.length) {
            throw new Error("No loaded Gmail or Google Calendar tab is available. Open one in this browser profile, wait for Google's account header, then retry.");
          }
          throw new Error(lastError && lastError.message
            ? lastError.message
            : "No loaded Google tab could open its account menu. Reload one Gmail or Calendar tab after this extension update, then retry.");
        }

        let opened = 0;
        let existing = 0;
        let connected = 0;
        const registrationJobs = [];
        for (const candidate of metadata.candidates) {
          const view = await openView(canonicalInbox(candidate.email), candidate.email);
          const verified = view.verified;
          if (verified) {
            connected++;
            continue;
          }
          const existingTab = view.reused ? view.tab : undefined;
          if (existingTab) {
            existing++;
            const registration = expectTabRegistration(existingTab.id, candidate.email);
            registrationJobs.push((async () => {
              try {
                await sendTabAction(existingTab.id, "connect");
                return await registration;
              } catch (error) {
                rejectExpectedRegistration(existingTab.id, error);
                await registration.catch(() => { });
                throw error;
              }
            })());
            continue;
          }
          const created = view.tab;
          if (!created || !Number.isInteger(created.id)) throw new Error(`Could not open a background inbox for ${candidate.email}.`);
          opened++;
          const registration = expectTabRegistration(created.id, candidate.email);
          registration.catch(() => { });
          registrationJobs.push((async () => {
            try {
              void sendTabAction(created.id, "connect").catch(() => {});
              return await registration;
            } catch (error) {
              rejectExpectedRegistration(created.id, error);
              await registration.catch(() => { });
              throw error;
            }
          })());
        }
        const outcomes = await Promise.allSettled(registrationJobs);
        const failed = outcomes.filter(outcome => outcome.status === "rejected");
        if (failed.length) {
          const reason = failed[0].reason instanceof Error ? failed[0].reason.message : "A candidate inbox did not verify its Google account header.";
          throw new Error(`${reason} Opened ${opened}; reused ${existing}; skipped ${metadata.expired} expired account${metadata.expired === 1 ? "" : "s"}.`);
        }
        const discovered = connected + existing + opened;
        return {
          candidates: metadata.candidates.length,
          discovered,
          opened,
          existing,
          connected,
          expired: metadata.expired,
          message: metadata.candidates.length
            ? `Found ${metadata.candidates.length} signed-in account candidate${metadata.candidates.length === 1 ? "" : "s"}. Opened ${opened} new background inbox${opened === 1 ? "" : "es"}, reused ${existing} existing tab${existing === 1 ? "" : "s"}, and already knew ${connected}. ${metadata.expired} expired account${metadata.expired === 1 ? " was" : "s were"} skipped and must be signed in again. Accounts appear only after each inbox loads a matching verified Google header.`
            : `No additional signed-in account rows were available. ${metadata.expired} expired account${metadata.expired === 1 ? " was" : "s were"} skipped and must be signed in again.`
        };
      } finally {
        accountScanActive = false;
      }
    }

    async function discover(registration) {
      const access = await request("/discover", registration);
      const object = typeof access === "object" && access !== null ? access : null;
      const validInterval = Number.isInteger(access && access.refreshIntervalSeconds)
        && (access.refreshIntervalSeconds === 0 || (access.refreshIntervalSeconds >= 30 && access.refreshIntervalSeconds <= 3600));
      const validRefreshRequest = Number.isInteger(access && access.refreshRequestedAt) && access.refreshRequestedAt >= 0;
      const validBackgroundCapture = typeof (access && access.backgroundCapture) === "boolean";
      if (!object || typeof access.accountId !== "string" || typeof access.enabled !== "boolean"
        || ("refreshIntervalSeconds" in object && !validInterval)
        || ("refreshRequestedAt" in object && !validRefreshRequest)
        || ("backgroundCapture" in object && !validBackgroundCapture)) {
        throw new Error("Relay Desk returned an invalid source-selection response.");
      }
      return {
        accountId: access.accountId,
        enabled: access.enabled,
        ...(validBackgroundCapture ? { backgroundCapture: access.backgroundCapture } : {}),
        ...(validInterval ? { refreshIntervalSeconds: access.refreshIntervalSeconds } : {}),
        ...(validRefreshRequest ? { refreshRequestedAt: access.refreshRequestedAt } : {})
      };
    }

    async function sendTabAction(tabId, action) {
      let result;
      try { result = await chrome.tabs.sendMessage(tabId, { type: "relay-tab", action }, { frameId: 0 }); }
      catch { throw new Error("Reload this Gmail, Calendar or WhatsApp Web tab once after installing or updating the extension, then retry."); }
      if (!result || !result.ok) throw new Error(result && result.error || "The tab did not acknowledge the command.");
      return result.value;
    }

    // After an install or update, pages opened earlier keep an orphaned content script and
    // cannot capture. Reload them, but never the tab the user is looking at or a Calendar
    // editor (unsaved form); those are reloaded once the user switches away.
    const orphanedTabs = new Set();
    function safeToReload(tab) {
      return tab && !tab.active && typeof tab.url === "string" && !/^https:\/\/calendar\.google\.com\/calendar\/.*\/(?:eventedit|r\/eventedit)/.test(tab.url);
    }
    async function recoverOrphanedTabs() {
      let reloaded = 0;
      for (const tab of await chrome.tabs.query({ url: SUPPORTED_URLS })) {
        if (!tab || !Number.isInteger(tab.id) || tab.discarded) continue;
        try { await chrome.tabs.sendMessage(tab.id, { type: "relay-tab", action: "status" }, { frameId: 0 }); continue; }
        catch { /* no live content script */ }
        if (safeToReload(tab)) { await chrome.tabs.reload(tab.id); reloaded++; }
        else orphanedTabs.add(tab.id);
      }
      return { reloaded, deferred: orphanedTabs.size };
    }
    async function reloadDeferredTabs() {
      for (const tabId of [...orphanedTabs]) {
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch { orphanedTabs.delete(tabId); continue; }
        if (!safeToReload(tab)) continue;
        orphanedTabs.delete(tabId);
        try { await chrome.tabs.reload(tabId); } catch { /* tab closed */ }
      }
    }

    async function reconcileOpenTabs() {
      const tabs = await chrome.tabs.query({ url: SUPPORTED_URLS });
      let attempted = 0;
      let discovered = 0;
      let failed = 0;
      for (const tab of tabs) {
        if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") continue;
        attempted++;
        try {
          extractors.pageKind(tab.url);
          await sendTabAction(tab.id, "connect");
          discovered++;
        } catch { failed++; }
      }
      return {
        attempted,
        discovered,
        failed,
        message: attempted
          ? `Asked ${attempted} open supported tab${attempted === 1 ? "" : "s"} to disclose loaded account metadata. ${discovered} responded; ${failed} failed. Google needs its account header; WhatsApp needs to finish loading after you link your phone.${failed ? " Reload failed tabs after the extension update, then retry." : ""}`
          : "No open Gmail, Google Calendar or WhatsApp Web tabs were found."
      };
    }

    async function handle(message, sender) {
      if (!message || typeof message.type !== "string") throw new Error("Unknown browser companion command.");
      if (["tab-management", "cleanup-agent-tabs"].includes(message.type)) await boundedTabCall(ready, TAB_MANAGEMENT_MS);
      else await ready;
      if (["mail-attachment-authorize", "mail-attachment-download"].includes(message.type)) {
        const registration = await validateTab(sender, message.payload?.registration);
        const { requestId, lease, messageProviderId, metadataId, name, size, url } = message.payload || {};
        const pending = mailJobs.get(requestId);
        if (!pending || pending.ended || !pending.running || !pending.rowProof ||
          pending.job.lease !== lease || pending.tabId !== sender.tab.id || pending.boundDocument !== sender.documentId ||
          registration.kind !== "mail" || registration.accountEmail !== pending.job.input.accountEmail ||
          !extractors.mailConversationRoute(pending.rowProof.inboxUrl, registration.pageUrl) ||
          (pending.rowProof.targetUrl && pending.rowProof.targetUrl !== registration.pageUrl) ||
          !validAttachmentIntent(pending.job.input) || messageProviderId !== pending.job.input.messageProviderId ||
          metadataId !== pending.job.input.attachment.metadataId || name !== pending.job.input.attachment.name ||
          (size === undefined ? pending.job.input.attachment.approved !== true : !Number.isSafeInteger(size) || size < 0) ||
          size > pending.job.input.attachment.maxBytes ||
          extractors.nativeAttachmentUrl(url, name) !== url) throw new Error("attachment-unavailable");
        const binding = { ...pending.binding, registration, requestId, lease };
        const proof = { messageProviderId, metadataId, name, size, url, pageUrl: registration.pageUrl };
        const owned = ownedTab(pending.tabId);
        const status = await mailTabStatus(pending, pending.boundDocument);
        if (!owned || owned.documentId !== pending.boundDocument || status?.dirty !== false ||
          status.registration?.pageUrl !== registration.pageUrl || status.registration?.accountEmail !== registration.accountEmail)
          throw new Error("attachment-interrupted");
        owned.url = registration.pageUrl;
        const check = async () => {
          if (pending.ended || pending.job.expiresAt <= Date.now() + 1500 || pending.interacted ||
            !await inspectOwned(ownedTab(pending.tabId), true) ||
            (await chrome.tabs.get(pending.tabId)).url !== registration.pageUrl)
            throw new Error("attachment-interrupted");
        };
        await check();
        if (message.type === "mail-attachment-authorize") {
          if (pending.attachmentAuthorizing) throw new Error("attachment-authorization-denied");
          pending.attachmentAuthorizing = true;
          let response;
          try { response = await request("/mail/attachment/authorize", binding); }
          catch { throw new Error("attachment-authorization-denied"); }
          await check();
          if (response?.authorized !== true) throw new Error("attachment-authorization-denied");
          pending.attachmentProof = proof;
          await saveMailWork();
          return { authorized: true };
        }
        if (!pending.attachmentProof || pending.attachmentStarted ||
          JSON.stringify(proof) !== JSON.stringify(pending.attachmentProof)) throw new Error("attachment-authorization-denied");
        pending.attachmentStarted = true;
        let lastGuard = 0;
        const liveCheck = async () => {
          await check();
          if (Date.now() - lastGuard >= 2000) {
            let response;
            try { response = await request("/mail/attachment/status", binding); }
            catch { throw new Error("attachment-authorization-denied"); }
            if (response?.authorized !== true) throw new Error("attachment-authorization-denied");
            lastGuard = Date.now();
            await check();
          }
        };
        pending.attachmentDownload = await downloadAttachment(chrome, pending, liveCheck, saveMailWork);
        return pending.attachmentDownload;
      }
      if (message.type === "mail-row-proof") {
        const registration = await validateTab(sender, message.payload?.registration);
        const { requestId, lease, rowProof } = message.payload || {};
        const pending = mailJobs.get(requestId);
        if (!pending || pending.ended || !pending.running || pending.provingRow || pending.rowProof ||
          pending.job.lease !== lease || pending.tabId !== sender.tab.id || pending.boundDocument !== sender.documentId ||
          registration.kind !== "mail" || registration.accountEmail !== pending.job.input.accountEmail ||
          registration.pageUrl !== pending.targetUrl || rowProof?.threadId !== pending.job.input.threadId ||
          rowProof?.inboxUrl !== registration.pageUrl) throw new Error("Full email row proof is stale or belongs to another document.");
        pending.provingRow = true;
        if (!await inspectOwned(ownedTab(pending.tabId), true)) throw new Error("The full email reader is no longer untouched.");
        const response = await request("/mail/poll", { ...pending.binding, requestId, lease, rowProof });
        await validateTab(sender, registration);
        if (pending.ended || response?.authorized !== true || !await inspectOwned(ownedTab(pending.tabId), true))
          throw new Error("Full email read is no longer authorized.");
        pending.rowProof = rowProof;
        await saveMailWork();
        if (pending.interacted || ownedTab(pending.tabId)?.protected) throw new Error("The full email reader was used.");
        return { authorized: true };
      }
      if (["calendar-poll", "calendar-authorize", "calendar-complete"].includes(message.type)) {
        const registration = await validateTab(sender, message.payload?.registration);
        if (registration.kind !== "calendar" || typeof sender.documentId !== "string" || !sender.documentId ||
            sender.documentId.length > 128) throw new Error("Calendar actions require a verified top-level Calendar document.");
        const binding = { protocol: 1, registration, tabId: sender.tab.id, documentId: sender.documentId };
        for (const [id, pending] of calendarJobs) if (pending.deadline <= Date.now()) calendarJobs.delete(id);
        if (message.type === "calendar-poll") {
          if (calendarJobs.size) return { job: null };
          const verified = verifiedTabs.get(sender.tab.id);
          if (!verified || verified.email !== registration.accountEmail || verified.pageUrl !== registration.pageUrl)
            throw new Error("Discover this Calendar account before checking reviewed actions.");
          const response = await request("/calendar/poll", binding);
          if (!response?.job) return { job: null };
          const job = response.job;
          if (job.protocol !== 1 || !/^[a-f0-9]{32}$/.test(job.requestId) || !/^[a-f0-9]{64}$/.test(job.lease)
            || job.move?.accountEmail?.toLowerCase() !== registration.accountEmail ||
            Date.parse(job.move.expiresAt) <= Date.now()) throw new Error("Invalid reviewed Calendar action.");
          await validateTab(sender, registration);
          if (calendarJobs.size) throw new Error("Another Calendar action is active.");
          calendarJobs.set(job.requestId, { job, tabId: sender.tab.id, documentId: sender.documentId,
            deadline: Math.min(Date.parse(job.move.expiresAt), Date.now() + 90000), authorized: false });
          return { job };
        }
        const { requestId, lease } = message.payload || {};
        const pending = calendarJobs.get(requestId);
        if (!pending || pending.job.lease !== lease || pending.tabId !== sender.tab.id ||
            pending.documentId !== sender.documentId || pending.job.move.accountEmail.toLowerCase() !== registration.accountEmail)
          throw new Error("Calendar action is stale or belongs to another document.");
        if (message.type === "calendar-authorize") {
          if (pending.authorized) throw new Error("Calendar Save authorization was already consumed.");
          pending.authorized = true;
          const permission = await request("/calendar/authorize", { ...binding, requestId, lease });
          await validateTab(sender, registration);
          return permission;
        }
        const code = message.payload.code;
        if (!["saved", "busy", "expired", "unavailable", "account-mismatch", "event-not-found", "event-changed",
          "unsupported-editor", "time-zone-unverified", "recurring-event", "permission-denied", "authorization-denied",
          "notification-confirmation", "save-unverified"].includes(code) || (code === "saved" && !pending.authorized))
          throw new Error("Invalid Calendar result.");
        calendarJobs.delete(requestId);
        return await request("/calendar/complete", { ...binding, requestId, lease, code });
      }
      if (message.type === "account-menu-ready") {
        const pending = await validateMenuSender(sender);
        return { scanId: pending.scanId };
      }
      if (message.type === "account-menu") {
        const pending = await validateMenuSender(sender, message.scanId);
        const metadata = validateMenuMetadata(message);
        clearTimeout(pending.timer);
        pendingMenuScans.delete(sender.tab.id);
        pending.resolve(metadata);
        return { accepted: true };
      }
      if (message.type === "discover" || message.type === "capture") {
        // A fast header can arrive before tabs.create resolves. Do not treat our
        // bootstrap as a user tab before its ID and ownership have been journaled.
        await Promise.all([...mailCreations.values()].map(item => item.promise));
        await Promise.all([...tabCreations]);
        const registration = await validateTab(sender, message.payload);
        const owned = ownedTab(sender.tab.id);
        if (owned && !owned.protected) {
          const pending = [...mailJobs.values(), ...mailWakes.values(), ...mailCleanup.values()]
            .find(item => item.tabId === sender.tab.id);
          const allowed = registration.pageUrl === owned.url || (owned.loading && owned.kind === registration.kind &&
            (owned.role === "view" || safeWakeRoute(registration.pageUrl))) ||
            (pending?.rowProof && extractors.mailConversationRoute(pending.rowProof.inboxUrl, registration.pageUrl) &&
              (!pending.rowProof.targetUrl || pending.rowProof.targetUrl === registration.pageUrl));
          if (!allowed || (owned.email && owned.email !== registration.accountEmail) ||
            (owned.documentId && owned.documentId !== sender.documentId)) owned.protected = true;
          else {
            owned.url = registration.pageUrl;
            owned.email = registration.accountEmail;
            owned.kind = registration.kind;
            const awaitingRoute = owned.kind === "mail" && owned.loading && !safeWakeRoute(registration.pageUrl);
            owned.documentId = awaitingRoute ? undefined : sender.documentId;
            owned.loading = awaitingRoute;
          }
          await saveMailWork();
        }
        const cleanupOwned = mailCleanup.get(sender.tab.id);
        if (cleanupOwned) {
          if (message.type === "capture") throw new Error("Expired full-email tabs cannot capture automatically.");
          void retryMailCleanup().catch(() => {});
          return { accountId: cleanupOwned.accountId || cleanupOwned.job?.input.accountId, enabled: false, mailReadTab: true };
        }
        const mailJob = [...mailJobs.values()].find(pending => pending.tabId === sender.tab.id);
        if (mailJob) {
          if (message.type === "capture") throw new Error("Dedicated full-email reads use their one-shot lease only.");
          if (mailJob.restored || mailJob.job.expiresAt <= Date.now()) {
            void checkMailWake(true).catch(() => {});
            return { accountId: mailJob.job.input.accountId, enabled: false, mailReadTab: true };
          }
          void readDedicatedMail(mailJob, sender, registration);
          return { accountId: mailJob.job.input.accountId, enabled: false, mailReadTab: true };
        }
        const wake = [...mailWakes.values()].find(item => item.tabId === sender.tab.id);
        if (wake) {
          if (message.type === "capture") throw new Error("Full email bootstrap tabs cannot capture automatically.");
          if (mailJobs.has(wake.requestId)) return { accountId: wake.accountId, enabled: false, mailReadTab: true };
          if (wake.expiresAt <= Date.now() || registration.kind !== "mail" ||
            registration.accountEmail !== wake.accountEmail || !wakeLocation(wake, registration.pageUrl)) {
            const mismatch = registration.accountEmail !== wake.accountEmail;
            if (mismatch && [wake.targetUrl, registration.pageUrl].includes(mailRoutes.get(wake.accountId)?.url))
              mailRoutes.delete(wake.accountId);
            await dispatchResult(wake.requestId, mismatch ? "account-mismatch" : "interrupted").catch(() => {});
            await retireWake(wake);
            throw new Error("The full email bootstrap account or document changed; no read was dispatched.");
          }
          const response = await request("/mail/pending", { protocol: 1 });
          if (!response.pending?.some(item => item.requestId === wake.requestId && item.state === "waking")) {
            await retireWake(wake);
            throw new Error("The full email wake is no longer pending.");
          }
          // authuser is only a routing hint. Wait for Google's actual numeric inbox
          // and matching top header before discovering the account or taking a lease.
          if (!safeWakeRoute(registration.pageUrl))
            return { accountId: wake.accountId, enabled: false, mailReadTab: true };
          const status = await mailTabStatus({ tabId: wake.tabId, job: { input: {} } }, sender.documentId);
          const current = await boundedTabCall(chrome.tabs.get(wake.tabId)).catch(() => undefined);
          if (mailWakes.get(wake.requestId) !== wake || wake.expiresAt <= Date.now())
            return { accountId: wake.accountId, enabled: false, mailReadTab: true };
          if (!current) {
            void connectMailTab(wake);
            return { accountId: wake.accountId, enabled: false, mailReadTab: true };
          }
          if (wake.interacted || owned?.protected || current.active || current.pinned
            || (current.pendingUrl && !wakeLocation(wake, current.pendingUrl)) || status?.dirty === true) {
            wake.interacted ||= status?.dirty === true || current.active || current.pinned;
            await dispatchResult(wake.requestId, "interrupted").catch(() => {});
            await retireWake(wake);
            throw new Error("The full email bootstrap tab was used; it was left untouched.");
          }
          if (current.status === "loading" || current.pendingUrl || status?.dirty !== false || !status.registration) {
            void connectMailTab(wake);
            return { accountId: wake.accountId, enabled: false, mailReadTab: true };
          }
          if (status.registration.accountEmail !== wake.accountEmail || status.registration.pageUrl !== registration.pageUrl) {
            await dispatchResult(wake.requestId, "account-mismatch").catch(() => {});
            await retireWake(wake);
            throw new Error("The bootstrap identity changed during readiness verification.");
          }
          wake.targetUrl = registration.pageUrl;
          wake.awaitingHeader = false;
          wake.boundDocument = sender.documentId;
          await saveMailWork();
        }
        if (owned && owned.role !== "view" && !wake) {
          if (message.type === "capture") throw new Error("Idle full-email tabs cannot capture automatically.");
          return { enabled: false, mailReadTab: true };
        }
        const blocked = blockedTabs.get(sender.tab.id);
        if (blocked && blocked.expiresAt < Date.now()) blockedTabs.delete(sender.tab.id);
        if (blocked && blocked.email !== registration.accountEmail) {
          throw new Error(`This inbox was opened for ${blocked.email}, but Google's verified header shows ${registration.accountEmail}. The redirected account was not registered.`);
        }
        if (blocked && blocked.email === registration.accountEmail) blockedTabs.delete(sender.tab.id);
        const expected = expectedTabs.get(sender.tab.id);
        if (expected?.email && expected.email !== registration.accountEmail) {
          const error = new Error(`This inbox was opened for ${expected.email}, but Google's verified header shows ${registration.accountEmail}. The redirected account was not registered.`);
          blockedTabs.set(sender.tab.id, { email: expected.email, expiresAt: Date.now() + 60000 });
          rejectExpectedRegistration(sender.tab.id, error);
          throw error;
        }
        const key = grantKey(sender, registration);
        if (message.type === "discover") {
          const access = await discover(registration);
          verifiedTabs.set(sender.tab.id, { email: registration.accountEmail, pageUrl: registration.pageUrl, documentId: sender.documentId });
          if (registration.kind === "mail") {
            const page = new URL(registration.pageUrl);
            const url = `${page.origin}${page.pathname}#inbox`;
            if (safeWakeRoute(url)) {
              mailRoutes.set(access.accountId, { accountId: access.accountId, email: registration.accountEmail, url });
              await saveMailWork();
            }
          }
          if (expected) {
            clearTimeout(expected.timer);
            expectedTabs.delete(sender.tab.id);
            expected.resolve(registration);
          }
          if (wake) {
            void pollMail(sender, registration);
            return { accountId: access.accountId, enabled: false, mailReadTab: true };
          }
          for (const [oldKey, expiry] of grants) if (expiry < Date.now()) grants.delete(oldKey);
          grants.delete(key);
          if (access.enabled) grants.set(key, Date.now() + 15000);
          if (registration.kind === "mail") void pollMail(sender, registration);
          void checkMailWake().catch(() => {});
          return access;
        }
        if (!grants.has(key) || grants.get(key) < Date.now()) {
          throw new Error("Source selection must be confirmed before capturing content. Retry capture.");
        }
        grants.delete(key);
        const access = await discover(registration);
        if (!access.enabled) throw new Error("This account's source is not selected. Enable ingestion and select this source in Relay Desk before capturing.");
        await validateTab(sender, registration);
        const { messages, meetings } = message.payload;
        if (!Array.isArray(messages) || !Array.isArray(meetings) || messages.length > 200 || meetings.length > 100
          || (registration.kind === "calendar" ? messages.length !== 0 : meetings.length !== 0)
          || (registration.kind === "whatsapp" && (!registration.chat || messages.some(item => item.threadId !== registration.chat.id)))) {
          throw new Error("Invalid capture for this page type, or too many loaded items (limit 200 messages or 100 events). Open a smaller view or use the API connector.");
        }
        const payload = { ...registration, messages, meetings };
        if (new TextEncoder().encode(JSON.stringify(payload)).length > 2 * 1024 * 1024) {
          throw new Error("This loaded view is too large to capture safely. Open a smaller view or use the API connector.");
        }
        const result = await request("/capture", payload);
        if (!result || result.accepted !== true) throw new Error("Relay Desk did not acknowledge this capture.");
        return result;
      }
      if (sender.id !== chrome.runtime.id || (sender.url !== chrome.runtime.getURL("popup.html")
        && sender.url !== `${chrome.runtime.getURL("popup.html")}?`)) {
        throw new Error("This command is restricted to the extension popup.");
      }
      if (message.type !== "pair" && message.type !== "forget") void checkMailWake().catch(() => {});
      if (message.type === "pair") {
        if (typeof message.code !== "string" || !message.code.trim() || message.code.length > 128) {
          throw new Error("Enter the pairing code shown in the desktop app.");
        }
        const result = await request("/pair", { code: message.code.trim() }, true);
        if (!result || typeof result.token !== "string" || !result.token || result.token.length > 4096) {
          throw new Error("Relay Desk returned an invalid pairing token.");
        }
        await chrome.storage.local.set({ token: result.token });
        await chrome.storage.local.remove("autoPairOff");
        grants.clear();
        calendarJobs.clear();
        cancelMailJobs();
        void reconcileOpenTabs();
        return { paired: true };
      }
      if (message.type === "forget") {
        await ready;
        await chrome.storage.local.remove("token");
        grants.clear();
        verifiedTabs.clear();
        calendarJobs.clear();
        cancelMailJobs();
        blockedTabs.clear();
        for (const [tabId] of expectedTabs) rejectExpectedRegistration(tabId, new Error("Pairing was removed before account discovery completed."));
        await chrome.storage.local.set({ autoPairOff: true });
        return { paired: false };
      }
      if (message.type === "state") {
        await ready;
        const { token } = await chrome.storage.local.get("token");
        return { paired: Boolean(token || await autoPair()) };
      }
      if (message.type === "tab-management") return await tabManagement();
      if (message.type === "cleanup-agent-tabs") {
        await ready;
        return await managementOperation(check => sweepOwned(true, check));
      }
      if (message.type === "discover-open-tabs") {
        return await reconcileOpenTabs();
      }
      if (message.type === "open-whatsapp") {
        await openView("https://web.whatsapp.com/");
        return { message: "WhatsApp Web opened in this browser profile. Link your phone if needed, then open a conversation; each chat you open is captured (exclude chats in Relay Desk settings)." };
      }
      if (message.type === "discover-signed-in-accounts") {
        return await discoverSignedInAccounts();
      }
      if (message.type === "add-account-link") {
        return await openAccountLink(message.url);
      }
      if (message.type === "fresh-account-views") {
        const tabs = await chrome.tabs.query({ url: GOOGLE_URLS });
        const views = new Set();
        for (const tab of tabs) {
          if (!tab.url) continue;
          const kind = extractors.pageKind(tab.url);
          if (kind === "whatsapp") continue;
          const current = new URL(tab.url);
          const prefix = kind === "mail" ? "/mail/" : "/calendar/";
          const slot = current.pathname.slice(prefix.length).match(/^u\/(\d+)(?:\/|$)/)?.[1];
          const fresh = new URL(`${prefix}${slot === undefined ? "" : `u/${slot}/`}`, current.origin);
          const account = current.searchParams.get("authuser");
          if (account) fresh.searchParams.set("authuser", account);
          fresh.hash = kind === "mail" ? "inbox" : "agenda";
          views.add(fresh.href);
        }
        if (views.size > 24) throw new Error("More than 24 Google account views are open. Reload the specific tabs you want to reconnect instead.");
        let opened = 0, reused = 0;
        for (const url of views) {
          const result = await openView(url, authuserEmail(url));
          if (result.reused) reused++; else opened++;
        }
        return { opened, reused, message: views.size
          ? `Opened ${opened} background account views; reused ${reused} existing views without navigation. Original tabs and unsaved forms were left untouched. Accounts appear after their Google headers load.`
          : "No Google tabs were found. Open Gmail or Google Calendar for each account first." };
      }
      if (message.type === "current-tab") {
        if (!["connect", "capture", "status"].includes(message.action)) throw new Error("Unknown tab action.");
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !Number.isInteger(tab.id)) throw new Error("Open a Gmail, Google Calendar or WhatsApp Web tab first.");
        extractors.pageKind(tab.url);
        return await sendTabAction(tab.id, message.action);
      }
      throw new Error("Unknown browser companion command.");
    }

    return { handle, recoverOrphanedTabs, reloadDeferredTabs };
  }

  if (typeof module === "object" && module.exports) module.exports = { createBridge, downloadAttachment, validAttachmentIntent };
  else {
    const bridge = createBridge(root.chrome, root.fetch.bind(root));
    root.chrome.runtime.onMessage.addListener((message, sender, respond) => {
      bridge.handle(message, sender).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
      return true;
    });
    root.chrome.runtime.onInstalled?.addListener(details => {
      if (details.reason === "install" || details.reason === "update")
        void bridge.recoverOrphanedTabs().catch(() => {});
    });
    root.chrome.tabs.onActivated?.addListener(() => { void bridge.reloadDeferredTabs().catch(() => {}); });
  }
})(globalThis);
