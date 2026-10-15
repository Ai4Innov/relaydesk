(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.RelayAccountMenu = api;
    if (root.top !== root && api.isAccountMenuUrl(root.location.href) && root.chrome && root.chrome.runtime) {
      api.readForPendingScan(root).catch(() => { /* The initiating popup reports the bounded scan timeout. */ });
    }
  }
})(globalThis, function () {
  "use strict";

  const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
  const EMAIL_IN_TEXT = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  function isAccountMenuUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "ogs.google.com" && !url.port && !url.username && !url.password
        && !url.hash && /^\/(?:u\/\d+\/)?widget\/account\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function visible(element) {
    if (!element || element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && element.getClientRects().length > 0;
  }

  function accessibleText(anchor) {
    const values = [anchor.getAttribute("aria-label") || "", anchor.innerText || ""];
    return values.join("\n").replace(/\u00a0/g, " ").trim();
  }

  function mailAccountDestination(value) {
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

  function expiredDestination(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "accounts.google.com" && !url.port && !url.username && !url.password
        && /^\/AccountChooser\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function parseAccountMenu(document, pageUrl) {
    if (!isAccountMenuUrl(pageUrl)) throw new Error("Account menu reader is restricted to Google's account widget.");
    const candidates = [];
    let expired = 0;
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (!visible(anchor)) continue;
      const text = accessibleText(anchor);
      if (expiredDestination(anchor.href) && /\b(?:session expired|session expir[eé]e)\b/i.test(text)) {
        expired++;
        continue;
      }
      const href = mailAccountDestination(anchor.href);
      if (!href) continue;
      const emails = [...new Set((text.match(EMAIL_IN_TEXT) || []).map(value => value.toLowerCase()))];
      if (emails.length !== 1 || !EMAIL.test(emails[0])) continue;
      candidates.push({ email: emails[0], href });
    }
    return { candidates, expired };
  }

  async function readForPendingScan(window) {
    const ready = await window.chrome.runtime.sendMessage({ type: "account-menu-ready" });
    const scanId = ready && ready.ok && ready.value && ready.value.scanId;
    if (typeof scanId !== "string" || !scanId) return;
    const metadata = await new Promise(resolve => {
      let settle;
      const finish = () => {
        clearTimeout(deadline);
        clearTimeout(settle);
        observer.disconnect();
        resolve(parseAccountMenu(window.document, window.location.href));
      };
      const check = () => {
        clearTimeout(settle);
        const value = parseAccountMenu(window.document, window.location.href);
        if (value.candidates.length || value.expired) settle = setTimeout(finish, 300);
      };
      const observer = new window.MutationObserver(check);
      observer.observe(window.document.documentElement, { childList: true, subtree: true, attributes: true });
      const deadline = setTimeout(finish, 3500);
      check();
    });
    await window.chrome.runtime.sendMessage({ type: "account-menu", scanId, ...metadata });
  }

  return { isAccountMenuUrl, parseAccountMenu, readForPendingScan };
});
