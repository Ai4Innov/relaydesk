(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayWhatsApp = api;
})(globalThis, function () {
  "use strict";
  const CHAT = /^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/;

  function visible(element) {
    if (!element || element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }
  function text(element) { return visible(element) ? (element.innerText || "").replace(/\u00a0/g, " ").trim() : ""; }
  function page(value) {
    const url = new URL(value);
    if (url.origin !== "https://web.whatsapp.com" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Open https://web.whatsapp.com/ in your paired browser profile.");
  }
  function phone(value) {
    const clean = value.replace(/[\s().\-\u200e\u200f]/g, "");
    return /^\+[1-9]\d{6,14}$/.test(clean) ? clean : undefined;
  }
  function messageKey(element) {
    const marker = element.hasAttribute("data-id") ? element
      : [...element.querySelectorAll("[data-id]")].find(visible);
    const match = /^(?:true|false)_([^_]+)_([A-Za-z0-9_@.-]{1,300})$/.exec(marker?.getAttribute("data-id") || "");
    return match && CHAT.test(match[1]) ? { chatId: match[1], id: marker.getAttribute("data-id") } : undefined;
  }
  function loadedChat(document) {
    const main = document.querySelector("#main");
    if (!visible(main)) return undefined;
    const messages = [...main.querySelectorAll(".message-in, .message-out")]
      .map(node => node.hasAttribute("data-id") || node.querySelector("[data-id]") ? node : node.closest("[data-id]")).filter(visible);
    const keys = messages.map(messageKey).filter(Boolean);
    const ids = new Set(keys.map(key => key.chatId));
    if (ids.size !== 1) return undefined;
    const title = [...main.querySelectorAll("header [title], header [data-testid='conversation-info-header-chat-title']")].find(visible);
    return { id: keys[0].chatId, name: text(title) || title?.getAttribute("title") || keys[0].chatId, messages: [...new Set(messages)] };
  }
  function identity(document, pageUrl) {
    page(pageUrl);
    // Re-verify the own-profile phone on every read: no name/avatar cache survives account switches.
    const candidates = [];
    for (const drawer of document.querySelectorAll("#app [data-testid='profile-drawer'], #app [data-testid='drawer-left'], #app [data-animate-drawer='true'], #app [aria-label='Profile'], #app [aria-label='Profil']")) {
      if (!visible(drawer) || drawer.closest("#main, #pane-side, [data-id], [data-pre-plain-text]")) continue;
      const heading = [...drawer.querySelectorAll("header, h1, h2, [role='heading']")]
        .some(node => /^(?:Profile|Profil)$/i.test(text(node)));
      if (!heading) continue;
      const labels = [...drawer.querySelectorAll("span, div, label")]
        .filter(node => /^(?:Phone number|Numéro de téléphone|Votre numéro de téléphone)$/i.test(text(node)));
      for (const label of labels) {
        const row = label.parentElement;
        for (const node of [row, ...row.querySelectorAll("span, div")]) {
          const value = phone(text(node));
          if (value) candidates.push(value);
        }
      }
    }
    const phones = [...new Set(candidates)];
    if (phones.length !== 1) throw new Error("WhatsApp identity is not verified. Open your own Profile panel from the left navigation and keep its Phone number visible while capturing. Contact names, chat phone numbers and QR codes are never account identity.");
    const chat = loadedChat(document);
    return { accountEmail: phones[0], accountName: `WhatsApp ${phones[0]}`, kind: "whatsapp", pageUrl,
      ...(chat ? { chat: { id: chat.id, name: chat.name.slice(0, 512) } } : {}) };
  }
  function attachments(element) {
    const result = [];
    for (const tile of element.querySelectorAll("[data-testid='document-thumb'], [data-testid='document-message'], [data-testid='document-container']")) {
      if (!visible(tile)) continue;
      const node = [...tile.querySelectorAll("[data-testid='document-title'], [title]")].find(visible);
      const name = text(node) || node?.getAttribute("title") || "";
      if (!name || name.length > 512 || /[/\\\u0000-\u001f]/.test(name) || result.some(item => item.name === name)) continue;
      result.push({ id: name, name, mimeType: "application/octet-stream" });
    }
    return result;
  }
  function extract(document, registration) {
    const current = identity(document, registration.pageUrl);
    if (current.accountEmail !== registration.accountEmail || !current.chat || current.chat.id !== registration.chat?.id)
      throw new Error("WhatsApp account or conversation changed. Open a chat with loaded messages and refresh discovery.");
    const chat = loadedChat(document);
    const messages = [];
    for (const element of chat.messages) {
      const key = messageKey(element);
      if (!key || key.chatId !== chat.id) continue;
      const copy = [...element.querySelectorAll("[data-pre-plain-text]")].find(visible);
      const header = copy?.getAttribute("data-pre-plain-text") || "";
      const metadata = /^\[([^\]]+)\]\s*([\s\S]*?):\s*$/.exec(header);
      const outgoing = element.matches(".message-out") || Boolean(element.querySelector(".message-out"));
      const sender = outgoing ? registration.accountEmail : metadata?.[2]?.trim();
      if (!sender) continue;
      const bodies = [...element.querySelectorAll(".selectable-text")].filter(node => visible(node) && !node.closest("[data-testid='quoted-message']"));
      const files = attachments(element);
      const body = bodies.map(text).filter(Boolean).join("\n");
      if (!body && !files.length) continue;
      const time = [...element.querySelectorAll("time[datetime]")].find(visible)?.getAttribute("datetime");
      const receivedAt = time && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time))
        ? new Date(time).toISOString() : undefined;
      messages.push({ id: key.id, threadId: chat.id, subject: chat.name, sender,
        recipients: outgoing ? [chat.name] : [registration.accountEmail], body: body || "[Document attachment; bytes not imported]",
        ...(receivedAt ? { receivedAt } : {}), dateText: metadata?.[1] || "", url: "https://web.whatsapp.com/",
        unread: false, completeness: "full", attachments: files });
    }
    if (!messages.length) throw new Error("No supported visible WhatsApp message bubbles were found. Open a conversation yourself; unloaded, view-once and unsupported media are not imported.");
    return { messages: messages.slice(-200).reverse(), meetings: [],
      coverage: `${Math.min(messages.length, 200)} loaded message bubble(s) from this selected chat only. Displayed dates are preserved; ambiguous dates are not guessed. Older/unloaded messages and unsupported media are omitted. File names are metadata only: manually download and import a copy in Relay Desk. No message is sent.` };
  }
  return { identity, extract, loadedChat };
});
