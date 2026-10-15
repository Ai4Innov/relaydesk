(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayExtractors = api;
})(globalThis, function () {
  "use strict";
  const whatsapp = typeof module === "object" && module.exports ? require("./whatsapp.js") : globalThis.RelayWhatsApp;

  const untrustedContent = ".a3s, .ii, [role='main'], [role='dialog'], [data-message-id], [data-legacy-message-id], [data-eventid]";
  const identityLabelPattern = /^\s*(?:Google\s+Account|Compte\s+Google)\s*:\s*([\s\S]*?)\s*\(([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})\)(?:,\s*(?:Google membership|Abonnement Google))?\s*$/i;

  function activateNativeControl(element) {
    const view = element.ownerDocument.defaultView, rect = element.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, view, button: 0,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    // Gmail's Closure controls can handle mouseup rather than a standalone click.
    element.dispatchEvent(new view.PointerEvent("pointerdown", { ...options, pointerType: "mouse", buttons: 1 }));
    element.dispatchEvent(new view.MouseEvent("mousedown", { ...options, buttons: 1 }));
    element.dispatchEvent(new view.PointerEvent("pointerup", { ...options, pointerType: "mouse" }));
    element.dispatchEvent(new view.MouseEvent("mouseup", options));
    element.dispatchEvent(new view.MouseEvent("click", options));
  }

  function pageKind(pageUrl) {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password) throw new Error("Open an HTTPS Gmail or Google Calendar tab.");
    if (url.hostname === "mail.google.com" && /^\/mail(?:\/|$)/.test(url.pathname)) return "mail";
    if (url.hostname === "calendar.google.com" && /^\/calendar(?:\/|$)/.test(url.pathname)) return "calendar";
    if (url.hostname === "web.whatsapp.com" && url.pathname === "/" && !url.search && !url.hash) return "whatsapp";
    throw new Error("This page is not a supported Gmail, Google Calendar or WhatsApp Web page.");
  }

  function visible(element) {
    if (!element || element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && element.getClientRects().length > 0;
  }

  function text(element) {
    return element && visible(element) ? (element.innerText || "").replace(/\u00a0/g, " ").trim() : "";
  }

  function firstVisible(scope, selector) {
    return [...scope.querySelectorAll(selector)].find(visible);
  }

  function inspectIdentity(document, pageUrl) {
    const kind = pageKind(pageUrl);
    const identities = [];
    const anchors = [];
    const diagnostics = {
      ariaAnchors: 0,
      visibleAnchors: 0,
      trustedAccountHrefs: 0,
      matchingLabels: 0,
      eligibleAnchors: 0,
      excludedAncestors: {
        any: 0,
        main: 0,
        dialog: 0,
        message: 0,
        event: 0
      }
    };
    // Only Google's global header, never account-like text inside mail or event content.
    for (const anchor of document.querySelectorAll("#gb a[aria-label], #gb button[aria-label]")) {
      diagnostics.ariaAnchors++;
      const isVisible = visible(anchor);
      if (isVisible) diagnostics.visibleAnchors++;
      const header = anchor.closest("#gb");
      const excluded = Boolean(anchor.closest(untrustedContent) || (header && header.closest(untrustedContent)));
      if (excluded) {
        diagnostics.excludedAncestors.any++;
        if (anchor.closest("[role='main']") || (header && header.closest("[role='main']"))) diagnostics.excludedAncestors.main++;
        if (anchor.closest("[role='dialog']") || (header && header.closest("[role='dialog']"))) diagnostics.excludedAncestors.dialog++;
        if (anchor.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id]")
          || (header && header.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id]"))) diagnostics.excludedAncestors.message++;
        if (anchor.closest("[data-eventid]") || (header && header.closest("[data-eventid]"))) diagnostics.excludedAncestors.event++;
      }
      let href;
      try { href = new URL(anchor.getAttribute("href"), pageUrl); } catch { href = undefined; }
      const trustedHref = Boolean(href && href.protocol === "https:" && href.hostname === "accounts.google.com"
        && !href.port && !href.username && !href.password);
      // Google's newer account button has no navigation URL.
      const trustedButton = !anchor.hasAttribute("href") && (anchor.tagName === "BUTTON" || anchor.getAttribute("role") === "button")
        && header && header.tagName === "HEADER" && header.getAttribute("role") === "banner";
      if (trustedHref) diagnostics.trustedAccountHrefs++;
      const accountLabel = (anchor.getAttribute("aria-label") || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      const match = accountLabel.match(identityLabelPattern);
      if (match) diagnostics.matchingLabels++;
      if (!isVisible || !header || excluded || (!trustedHref && !trustedButton) || !match) continue;
      diagnostics.eligibleAnchors++;
      identities.push({ accountEmail: match[2].toLowerCase(), accountName: match[1].trim(), kind, pageUrl });
      anchors.push(anchor);
    }
    return { identities, diagnostics, anchors };
  }

  function identityDiagnostics(document, pageUrl) {
    return inspectIdentity(document, pageUrl).diagnostics;
  }

  function diagnosticText(diagnostics) {
    const excluded = diagnostics.excludedAncestors;
    return `Diagnostic counts (no account values): #gb aria anchors=${diagnostics.ariaAnchors}; visible=${diagnostics.visibleAnchors}; trusted accounts.google.com href=${diagnostics.trustedAccountHrefs}; known label pattern=${diagnostics.matchingLabels}; eligible=${diagnostics.eligibleAnchors}; excluded ancestors(any=${excluded.any}, main=${excluded.main}, dialog=${excluded.dialog}, message=${excluded.message}, event=${excluded.event}).`;
  }

  function verifiedIdentity(document, pageUrl) {
    const result = inspectIdentity(document, pageUrl);
    const { identities, diagnostics } = result;
    const emails = new Set(identities.map(account => account.accountEmail));
    if (emails.size !== 1) {
      throw new Error(`Cannot confidently identify the signed-in account from Google's top header. Wait for the page to load; account-menu or message text is not accepted. ${diagnosticText(diagnostics)}`);
    }
    return result;
  }

  function identity(document, pageUrl) {
    if (pageKind(pageUrl) === "whatsapp") return whatsapp.identity(document, pageUrl);
    return verifiedIdentity(document, pageUrl).identities[0];
  }

  function accountHeader(document, pageUrl) {
    return verifiedIdentity(document, pageUrl).anchors[0];
  }

  function safeMeetUrl(value, pageUrl) {
    try {
      const url = new URL(value, pageUrl);
      if (url.protocol === "https:" && url.hostname === "meet.google.com" && !url.port && !url.username && !url.password
        && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)) {
        return `${url.origin}${url.pathname}`;
      }
    } catch { /* Non-URL text is not a meeting link. */ }
    return undefined;
  }

  function meetingLink(element, pageUrl) {
    for (const link of element.querySelectorAll("a[href]")) {
      if (!visible(link)) continue;
      const url = safeMeetUrl(link.getAttribute("href"), pageUrl);
      if (url) return url;
    }
    return undefined;
  }

  function mailBody(element, pageUrl) {
    const body = text(element);
    const links = [...element.querySelectorAll("a[href]")].filter(visible)
      .map(link => safeMeetUrl(link.getAttribute("href"), pageUrl)).filter(url => url && !body.includes(url));
    return [body, ...[...new Set(links)].map(url => `Meeting link: ${url}`)].join("\n\n");
  }

  function mailAttachmentSize(value) {
    const match = String(value || "").trim().match(/^([\d.,\s\u00a0\u202f]+)\s*([bo]|bytes?|octets?|[kmgt](?:i?[bo]))$/i);
    if (!match) return undefined;
    let number = match[1].replace(/[\s\u00a0\u202f]/g, "");
    if (number.includes(".") && number.includes(",")) return undefined;
    // A three-digit suffix could be a thousands separator or a decimal: do not guess.
    if (/[.,]\d{3}$/.test(number) || (number.match(/[.,]/g) || []).length > 1) return undefined;
    number = Number(number.replace(",", "."));
    const unit = match[2].toLowerCase();
    const power = /^[kmgt]/.test(unit) ? "kmgt".indexOf(unit[0]) + 1 : 0;
    const bytes = Math.ceil(number * (unit.includes("i") ? 1024 : 1000) ** power);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }
  function nativeAttachmentTiles(message) {
    const entries = [];
    const seen = new Set();
    for (const nameNode of message.querySelectorAll(".aQH .aV3, .aQH [data-attachment-name]")) {
      if (!visible(nameNode) || nameNode.closest(".a3s, .ii, [role='dialog'], [contenteditable='true']") ||
        nameNode.closest("[data-message-id], [data-legacy-message-id]") !== message) continue;
      // Gmail's preview anchor (.aQy) can be nested inside the attachment wrapper
      // (.aZo); the native download URL and size belong to that outer wrapper.
      const tile = nameNode.closest(".aZo") || nameNode.closest(".aQy") || nameNode.parentElement;
      if (!tile || !tile.closest(".aQH") || seen.has(tile)) continue;
      const name = text(nameNode);
      if (!name || name.length > 512 || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f]/.test(name)) continue;
      seen.add(tile);
      const size = mailAttachmentSize(text(firstVisible(tile, ".SaH2Ve, .aV4, [data-attachment-size]")));
      entries.push({ tile, metadata: { id: name, name, mimeType: "application/octet-stream",
        ...(size !== undefined ? { size } : {}) } });
    }
    // Preserve legacy name IDs when unique; duplicate names remain visible, never silently merged.
    for (const [index, entry] of entries.entries()) {
      if (entries.filter(other => other.metadata.name === entry.metadata.name).length > 1)
        entry.metadata.id = `duplicate:${index}:${entry.metadata.name}`.slice(0, 512);
    }
    return entries;
  }
  function mailAttachments(message) {
    const entries = nativeAttachmentTiles(message);
    const native = selector => [...message.querySelectorAll(selector)].filter(node =>
      visible(node) && !node.closest(".a3s, .ii, [role='dialog'], [contenteditable='true']") &&
      node.closest("[data-message-id], [data-legacy-message-id]") === message);
    const tiles = native(".aQH .aZo, .aQH .aQy, .aQH .aV3, .aQH [data-attachment-name]");
    const busy = native(".aQH[aria-busy='true'], .aQH [aria-busy='true'], .aQH [role='progressbar']").length > 0;
    const unsupported = tiles.some(tile => !entries.some(entry => entry.tile === tile || entry.tile.contains(tile))) ||
      native(".aQH").some(region => text(region) && !entries.some(entry => region.contains(entry.tile)));
    if (busy || unsupported) return {};
    return { attachments: entries.map(entry => entry.metadata), attachmentManifestVersion: 1 };
  }
  function nativeAttachmentUrl(value, name) {
    if (typeof value !== "string" || value.length > 16384) return undefined;
    const wrapped = value.match(/^([^:]+):([^:]+):(https:\/\/.+)$/);
    if (wrapped) {
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(wrapped[1]) || wrapped[2] !== name) return undefined;
      value = wrapped[3];
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
        !(url.hostname === "mail.google.com" || url.hostname === "mail-attachment.googleusercontent.com")) return undefined;
      return url.href;
    } catch { return undefined; }
  }
  function mailAttachment(document, pageUrl, request, proof) {
    const main = verifyMailRequest(document, pageUrl, request, proof);
    const intent = request.attachment;
    if (!intent || !request.messageProviderId || request.messageProviderId.startsWith("thread:")) throw new Error("attachment-unavailable");
    const messages = mailContainers(main).filter(element => visible(element) &&
      (element.getAttribute("data-legacy-message-id") || element.getAttribute("data-message-id")) === request.messageProviderId);
    const captured = messages.length === 1 && mail(document, pageUrl, request, proof).messages.find(message =>
      message.id === request.messageProviderId);
    if (!captured?.attachments?.some(attachment => attachment.id === intent.metadataId && attachment.name === intent.name))
      throw new Error("attachment-unavailable");
    const entries = nativeAttachmentTiles(messages[0]);
    const matches = entries.filter(entry => entry.metadata.name === intent.name);
    if (matches.length !== 1 || matches[0].metadata.id !== intent.metadataId) throw new Error("attachment-unavailable");
    const { tile, metadata } = matches[0];
    if (!tile.matches(".aZo, .aQy")) throw new Error("attachment-unavailable");
    if ((metadata.size === undefined ? intent.approved !== true : !Number.isSafeInteger(metadata.size) || metadata.size < 0) ||
      !Number.isSafeInteger(intent.maxBytes) || intent.maxBytes <= 0 || metadata.size > intent.maxBytes)
      throw new Error("attachment-size-limit");
    const candidates = [tile, ...tile.querySelectorAll("[data-download-url], a[download][href]")].filter(node =>
      !node.closest(".a3s, .ii") && node.closest("[data-message-id], [data-legacy-message-id]") === messages[0]);
    const urls = candidates.map(node => node.getAttribute("data-download-url") ||
      (node.matches("a[download]") ? node.getAttribute("href") : undefined)).filter(Boolean)
      .map(value => nativeAttachmentUrl(value, metadata.name));
    if (!urls.length || urls.some(url => !url) || new Set(urls).size !== 1) throw new Error("attachment-unavailable");
    return { tile, metadata, url: urls[0] };
  }

  const messageSelector = "[data-message-id], [data-legacy-message-id]";
  function mailContainers(main) {
    return [...main.querySelectorAll(messageSelector)].filter(element =>
      !element.closest(".a3s, .ii") && !element.parentElement.closest(messageSelector));
  }
  function nativeMailRows(main) {
    return [...main.querySelectorAll("tr.zA, [role='row'][data-legacy-thread-id]")].filter(node =>
      visible(node) && !node.closest(".a3s, .ii, [role='dialog'], [contenteditable='true'], [data-message-id], [data-legacy-message-id]"));
  }
  function rowThreadMarkers(row) {
    return [row, ...row.querySelectorAll("[data-legacy-thread-id]")].filter(node =>
      node.hasAttribute("data-legacy-thread-id") && !node.closest(".a3s, .ii") &&
      node.closest("tr.zA, [role='row']") === row);
  }
  function mailDiagnostics(document, request) {
    const main = firstVisible(document, "[role='main']");
    const nodes = selector => main ? [...main.querySelectorAll(selector)].filter(node => !node.closest(".a3s, .ii")) : [];
    return {
      containers: Math.min(10000, main ? mailContainers(main).length : 0),
      bodies: Math.min(10000, main ? [...main.querySelectorAll(".a3s")].filter(node =>
        visible(node) && !node.parentElement.closest(".a3s")).length : 0),
      senders: Math.min(10000, nodes(".gD[email], .gE [email]").filter(visible).length),
      threadMarkers: Math.min(10000, nodes("[data-legacy-thread-id]").length),
      rows: Math.min(10000, main ? nativeMailRows(main).length : 0),
      matchingRows: Math.min(10000, main && request ? nativeMailRows(main).filter(row =>
        rowThreadMarkers(row).some(node => node.getAttribute("data-legacy-thread-id") === request.threadId)).length : 0)
    };
  }
  function verifyMailAccount(document, pageUrl, request) {
    const current = identity(document, pageUrl), url = new URL(pageUrl);
    if (current.kind !== "mail" || current.accountEmail !== request.accountEmail.toLowerCase())
      throw new Error("account-mismatch");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.threadId) || !/^\/mail\/u\/\d+\/$/.test(url.pathname))
      throw new Error("thread-mismatch");
    return current;
  }
  function mailConversationRoute(inboxUrl, conversationUrl) {
    const inbox = new URL(inboxUrl), conversation = new URL(conversationUrl);
    return !conversation.username && !conversation.password && inbox.origin === conversation.origin && inbox.pathname === conversation.pathname &&
      inbox.search === conversation.search && /^#(?:inbox|all)\/[A-Za-z0-9_-]{1,512}$/.test(conversation.hash);
  }
  function exactMailRow(document, pageUrl, request) {
    verifyMailAccount(document, pageUrl, request);
    if (new URL(pageUrl).hash !== "#inbox") throw new Error("thread-mismatch");
    const main = firstVisible(document, "[role='main']");
    if (!main || mailContainers(main).some(visible)) return undefined;
    const rows = nativeMailRows(main).filter(row => rowThreadMarkers(row).some(node =>
      node.getAttribute("data-legacy-thread-id") === request.threadId));
    if (!rows.length) return undefined;
    if (rows.length !== 1 || rowThreadMarkers(rows[0]).some(node =>
      node.getAttribute("data-legacy-thread-id") !== request.threadId)) throw new Error("unsupported");
    const row = rows[0];
    const subject = [...row.querySelectorAll(".bog, [data-thread-subject]")].find(node =>
      visible(node) && node.closest("tr.zA, [role='row']") === row &&
      !node.closest(".a3s, .ii, button, input, [role='button'], [role='checkbox'], [contenteditable='true']"));
    if (!subject || !text(subject)) throw new Error("unsupported");
    const anchor = subject.closest("a[href]");
    const targetUrl = anchor ? new URL(anchor.getAttribute("href"), pageUrl).href : undefined;
    if (targetUrl && (!row.contains(anchor) || !mailConversationRoute(pageUrl, targetUrl))) throw new Error("unsupported");
    const providerNode = [row, ...row.querySelectorAll("[data-thread-id]")].find(node =>
      node.hasAttribute("data-thread-id") && !node.closest(".a3s, .ii"));
    const providerThreadId = providerNode?.getAttribute("data-thread-id");
    return { element: subject, proof: { threadId: request.threadId, inboxUrl: pageUrl,
      ...(targetUrl ? { targetUrl } : {}), ...(providerThreadId && providerThreadId.length <= 512 ? { providerThreadId } : {}) } };
  }
  function verifyMailRequest(document, pageUrl, request, proof) {
    verifyMailAccount(document, pageUrl, request);
    const url = new URL(pageUrl);
    if (proof) {
      if (proof.threadId !== request.threadId || proof.clicked !== true || !mailConversationRoute(proof.inboxUrl, pageUrl) ||
        (proof.targetUrl && proof.targetUrl !== pageUrl) || (proof.conversationUrl && proof.conversationUrl !== pageUrl))
        throw new Error("thread-mismatch");
    } else if (url.hash !== `#all/${request.threadId}`) throw new Error("thread-mismatch");
    const main = firstVisible(document, "[role='main']");
    if (!main) throw new Error("partial");
    // Gmail changes the hash before replacing the inbox DOM. Those rows are not conversation proof.
    if (!mailContainers(main).some(visible)) throw new Error("partial");
    const markers = [...main.querySelectorAll("[data-legacy-thread-id]")].filter(node =>
      visible(node) && !node.closest(".a3s, .ii, tr.zA, [role='row']"));
    if (markers.some(node => node.getAttribute("data-legacy-thread-id") !== request.threadId)) throw new Error("thread-mismatch");
    const providerMarkers = [...main.querySelectorAll("[data-thread-id]")].filter(node =>
      visible(node) && !node.closest(".a3s, .ii, tr.zA, [role='row']"));
    if (proof?.providerThreadId && providerMarkers.some(node =>
      node.getAttribute("data-thread-id") !== proof.providerThreadId)) throw new Error("thread-mismatch");
    return main;
  }
  function collapsedMailHeaders(document, pageUrl, request, proof) {
    const main = verifyMailRequest(document, pageUrl, request, proof);
    return mailContainers(main).filter(visible).flatMap(container => {
      const body = [...container.querySelectorAll(".a3s")].find(node =>
        visible(node) && !node.parentElement.closest(".a3s") && node.closest(messageSelector) === container);
      if (body) return [];
      // Only Gmail's message header, never controls or links inside the sender's content.
      const header = [...container.querySelectorAll(".aju, .adf[aria-expanded='false'], .gG[aria-expanded='false']")].find(node =>
        visible(node) && !node.closest(".a3s, .ii") && node.closest(messageSelector) === container &&
        !node.matches("a, button, input") && !node.closest("[contenteditable='true']"));
      return header ? [header] : [];
    });
  }
  function mailExpandAllControl(document, pageUrl, request, proof) {
    if (!proof?.clicked || proof.conversationUrl !== pageUrl) return undefined;
    const main = verifyMailRequest(document, pageUrl, request, proof);
    const excluded = ".a3s, .ii, [data-message-id], [data-legacy-message-id], [role='dialog'], form, [contenteditable='true']";
    const folded = [...main.querySelectorAll(".adx")].some(node => visible(node) && !node.closest(excluded));
    const collapsed = mailContainers(main).some(container => visible(container) &&
      ![...container.querySelectorAll(".a3s")].some(node => visible(node) && !node.parentElement.closest(".a3s")));
    if (!folded && !collapsed) return undefined;
    const controls = [...main.querySelectorAll("[role='button'], button")].filter(node => {
      if (!visible(node) || node.closest(excluded) || node.matches("a, input") ||
        node.getAttribute("aria-disabled") === "true" || node.disabled) return false;
      const toolbar = node.closest("[role='toolbar'], .G-tF, .ha");
      if (!toolbar || !main.contains(toolbar) || toolbar.closest(excluded) ||
        (toolbar.matches(".ha") && !firstVisible(toolbar, "h2.hP"))) return false;
      return ["aria-label", "data-tooltip", "title"].some(attribute =>
        /^(?:Expand all|Tout développer|Développer tout)$/i.test((node.getAttribute(attribute) || "").trim()));
    });
    return controls.length === 1 ? controls[0] : undefined;
  }
  function mail(document, pageUrl, request, proof) {
    if (pageKind(pageUrl) !== "mail") throw new Error("Gmail extraction requires a Gmail page.");
    const main = firstVisible(document, "[role='main']");
    if (!main) throw new Error("Gmail has not loaded a supported message view. Open an inbox or a conversation.");
    if (request) verifyMailRequest(document, pageUrl, request, proof);
    const messages = [];
    const warnings = [];
    const seen = new Set();
    const containers = mailContainers(main);
    const conversation = containers.filter(element => visible(element) && element.querySelector(".a3s"));
    for (const element of conversation) {
      const body = [...element.querySelectorAll(".a3s")].find(node => visible(node) &&
        !node.parentElement.closest(".a3s") && node.closest(messageSelector) === element);
      if (!body) continue;
      const id = element.getAttribute("data-legacy-message-id") || element.getAttribute("data-message-id");
      if (seen.has(id)) continue;
      const sender = [...element.querySelectorAll(".gD[email], .gE [email]")].find(node => visible(node) && !node.closest(".a3s, .ii"));
      if (!sender) { warnings.push("Some loaded messages have unsupported sender headers."); continue; }
      const threadNode = [...main.querySelectorAll("[data-legacy-thread-id]")].find(node =>
        visible(node) && !node.closest(".a3s, .ii, tr.zA, [role='row']"));
      const threadId = element.getAttribute("data-legacy-thread-id") || (threadNode && threadNode.getAttribute("data-legacy-thread-id")) || request?.threadId || "";
      if (!threadId) { warnings.push("Some loaded messages have no stable thread identifier."); continue; }
      const date = [...element.querySelectorAll(".g3, time")].find(node => visible(node) && !node.closest(".a3s, .ii"));
      const subject = [...main.querySelectorAll("h2.hP, h2[data-legacy-thread-id]")].find(node => visible(node) && !node.closest(".a3s, .ii"));
      const recipients = [...element.querySelectorAll(".g2[email]")].filter(node => visible(node) && !node.closest(".a3s, .ii")).map(node => node.getAttribute("email"));
      messages.push({
        id, threadId, subject: text(subject), sender: sender.getAttribute("email"), recipients: [...new Set(recipients)],
        body: mailBody(body, pageUrl),
        ...(new TextEncoder().encode(body.innerHTML).length <= 1_000_000 ? { html: body.innerHTML } : {}),
        dateText: date ? date.getAttribute("title") || text(date) : "",
        url: pageUrl, unread: false, completeness: "full", ...mailAttachments(element)
      });
      seen.add(id);
    }
    if (request) {
      const clipped = [...main.querySelectorAll("a[href]")].some(node => visible(node) && !node.closest(".a3s") &&
        /^(?:view entire message|afficher (?:l['\u2019]integralite du|tout le) message)$/i.test(
          text(node).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ")));
      if (clipped) throw new Error("partial");
      const foldedGroups = [...main.querySelectorAll(".adx, [data-message-count]")].filter(node =>
        visible(node) && !node.closest(".a3s, .ii") &&
        (node.matches(".adx") || Number(node.getAttribute("data-message-count")) > containers.length));
      if (!messages.length || containers.length > 200 || messages.length !== containers.length || foldedGroups.length ||
        messages.some(message => message.threadId !== request.threadId || !message.html?.trim() ||
          (!message.body.trim() && !/<img\b/i.test(message.html)))) throw new Error("partial");
      const provider = request.messageProviderId;
      if (provider && !provider.startsWith("thread:") && !messages.some(message => message.id === provider))
        throw new Error("partial");
    }
    if (conversation.length) {
      if (!messages.length) throw new Error("No expanded conversation messages could be read safely. Expand a message yourself, or use the API connector.");
      const files = messages.reduce((count, message) => count + (message.attachments?.length || 0), 0);
      if (messages.some(message => message.attachmentManifestVersion !== 1))
        warnings.push("Some native attachment manifests are loading or unsupported; their metadata was not captured.");
      return { messages, meetings: [], coverage: `${messages.length} expanded message(s), ${files} attachment name(s); file bytes require importing a downloaded copy in Relay Desk; collapsed and unloaded messages are not captured. ${[...new Set(warnings)].join(" ")}`.trim() };
    }

    const rows = [...main.querySelectorAll("tr.zA, [role='row'][data-legacy-thread-id]")]
      .filter(element => visible(element) && !element.closest(".a3s, .ii"));
    for (const row of rows) {
      const marker = row.matches("[data-legacy-thread-id]") ? row : row.querySelector("[data-legacy-thread-id]");
      const threadId = marker && marker.getAttribute("data-legacy-thread-id");
      const sender = firstVisible(row, "[email]");
      const subject = firstVisible(row, ".bog, [data-thread-subject]");
      if (!threadId || !sender || !subject) { warnings.push("Some visible inbox rows use unsupported markup."); continue; }
      if (seen.has(threadId)) continue;
      const subjectText = text(subject), previewText = text(firstVisible(row, ".y2"));
      if (!subjectText && !previewText) {
        warnings.push("Some inbox previews are not painted yet. Activate this Gmail tab before capturing.");
        continue;
      }
      const date = firstVisible(row, ".xW [title]") || firstVisible(row, ".xW, time");
      const url = new URL(pageUrl);
      url.hash = `all/${encodeURIComponent(threadId)}`;
      messages.push({
        id: `thread:${threadId}`, threadId, subject: subjectText, sender: sender.getAttribute("email"),
        recipients: [], body: previewText,
        dateText: date ? date.getAttribute("title") || text(date) : "", url: url.href,
        unread: row.classList.contains("zE") || row.getAttribute("data-unread") === "true", completeness: "preview"
      });
      seen.add(threadId);
    }
    if (messages.length) return { messages, meetings: [], coverage: `${messages.length} loaded inbox preview(s), not full message bodies. ${[...new Set(warnings)].join(" ")}`.trim() };
    // Gmail's own empty-list cell, not arbitrary text from a message body.
    const empty = [...main.querySelectorAll("td.TC")].find(node => visible(node) && !node.closest(".a3s, .ii, [data-message-id], [data-legacy-message-id]"));
    if (!rows.length && empty && /^(Your (?:Primary |Social |Promotions |Updates |Forums )?(?:inbox|tab) is empty[.!]?|No conversations found[.!]?|There are no conversations with this label[.!]?|No conversations in (?:Spam|Trash)[.!]?)$/i.test(text(empty))) {
      return { messages: [], meetings: [], coverage: "Gmail explicitly reports an empty list in this view." };
    }
    throw new Error("Unsupported or still-loading Gmail view: no recognizable message rows or genuine empty state. Open an inbox or an expanded conversation; API access remains available.");
  }

  function calendar(document, pageUrl) {
    if (pageKind(pageUrl) !== "calendar") throw new Error("Calendar extraction requires a Google Calendar page.");
    const main = firstVisible(document, "[role='main']");
    const dialogs = [...document.querySelectorAll("[role='dialog']")].filter(visible);
    const meetings = new Map();
    let unsupported = 0;
    if (!main && !dialogs.length) throw new Error("Google Calendar has not loaded a supported agenda or event view.");
    const events = main ? [...main.querySelectorAll("[data-eventid]")].filter(visible) : [];
    for (const event of events) {
      if (event.closest("[role='dialog']")) continue;
      const id = event.getAttribute("data-eventid");
      const description = text(event);
      const labeledChip = firstVisible(event, "[role='button'][aria-label], button[aria-label]");
      const label = event.getAttribute("aria-label") || labeledChip?.getAttribute("aria-label") || "";
      // Modern Schedule/Grid chips expose the full event summary as their accessible label.
      const title = text(firstVisible(event, ".I0UMhf, [data-event-title]")) || label || description;
      // Preserve Google's display text rather than guessing a date from the current view.
      const whenText = label || description;
      if (!id || !title || !whenText) { unsupported++; continue; }
      meetings.set(id, { id, title, whenText, description: "", location: "", meetingUrl: meetingLink(event, pageUrl), url: pageUrl });
    }
    for (const dialog of dialogs) {
      const title = text(firstVisible(dialog, "#rAECCd, [role='heading'], h1, h2"));
      const marker = dialog.matches("[data-eventid]") ? dialog : dialog.querySelector("[data-eventid]");
      let id = marker && marker.getAttribute("data-eventid");
      if (!id) {
        // The selected agenda chip may own the identifier while the event popup is portalled.
        const selected = events.filter(event => event.getAttribute("aria-expanded") === "true" || event.getAttribute("aria-selected") === "true");
        if (selected.length === 1) id = selected[0].getAttribute("data-eventid");
      }
      const when = firstVisible(dialog, "[data-event-time], .AzuXid");
      const whenText = text(when);
      if (!id || !title || !whenText) { unsupported++; continue; }
      const location = firstVisible(dialog, "[data-event-location], .JAPzS");
      const description = firstVisible(dialog, "[data-event-description], .NI2kfb");
      meetings.set(id, {
        id, title, whenText, description: text(description), location: text(location),
        meetingUrl: meetingLink(dialog, pageUrl), url: pageUrl
      });
    }
    if (meetings.size) {
      return { messages: [], meetings: [...meetings.values()], coverage: `${meetings.size} loaded event(s); descriptions and links are limited to visible loaded details.${unsupported ? " Some visible events or dialogs have unsupported markup and were skipped." : ""}` };
    }
    const empty = main && firstVisible(main, "[role='status'], .qqmbid");
    if (!events.length && !dialogs.length && empty && /^(No events|No events to display|You have no events (?:today|on this day))[.!]?$/i.test(text(empty))) {
      return { messages: [], meetings: [], coverage: "Calendar explicitly reports no events in this view." };
    }
    throw new Error(`Unsupported or still-loading Calendar view: open Schedule/Agenda or an event. No recognizable events or genuine empty state were found; API access remains available. Diagnostic counts: main=${main ? 1 : 0}, document events=${document.querySelectorAll("[data-eventid]").length}, visible main events=${events.length}, titled events=${events.filter(event => firstVisible(event, ".I0UMhf, [data-event-title]")).length}, labeled events=${events.filter(event => event.getAttribute("aria-label")).length}, dialogs=${dialogs.length}.`);
  }

  function extract(document, registration) {
    const current = identity(document, registration.pageUrl);
    if (current.accountEmail !== registration.accountEmail || current.kind !== registration.kind) throw new Error("The signed-in account changed. Connect this tab again.");
    if (current.kind === "whatsapp") return whatsapp.extract(document, registration);
    return current.kind === "mail" ? mail(document, current.pageUrl) : calendar(document, current.pageUrl);
  }

  return { pageKind, visible, identity, accountHeader, identityDiagnostics, safeMeetUrl, mail, calendar, extract, activateNativeControl,
    verifyMailRequest, verifyMailAccount, mailConversationRoute, exactMailRow, mailDiagnostics, collapsedMailHeaders,
    mailExpandAllControl, mailAttachment, mailAttachmentSize, nativeAttachmentUrl };
});
