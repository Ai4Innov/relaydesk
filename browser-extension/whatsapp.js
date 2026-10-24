(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayWhatsApp = api;
})(globalThis, function () {
  "use strict";
  const CHAT = /^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/;
  const MESSAGE_ID = /^(?:true|false)_([^_]+)_([A-Za-z0-9_@.-]{1,300})$/;
  // WhatsApp Web stores the linked account's own WID ("<phone>[:device]@c.us") in its origin storage.
  const OWN_WID = /^"?([1-9]\d{6,14})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)"?$/;

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
    const clean = value.replace(/[\s().\-\u200e\u200f\u202a\u202c]/g, "");
    return /^\+[1-9]\d{6,14}$/.test(clean) ? clean : undefined;
  }
  /** Own phone from WhatsApp's own login record (never from contacts, chat headers or message text). */
  function storedPhones(document) {
    let storage;
    try { storage = document.defaultView && document.defaultView.localStorage; } catch { return []; }
    if (!storage) return [];
    const phones = [];
    for (const key of ["last-wid-md", "last-wid"]) {
      let value = null;
      try { value = storage.getItem(key); } catch { }
      const match = typeof value === "string" ? OWN_WID.exec(value.trim()) : null;
      if (match) phones.push(`+${match[1]}`);
    }
    return phones;
  }
  /** Fallback: the phone shown in your own Profile panel, when it is open. */
  function profilePhones(document) {
    const candidates = [];
    for (const drawer of document.querySelectorAll("#app [data-testid='profile-drawer'], #app [data-testid='drawer-left'], #app [data-animate-drawer='true'], #app [aria-label='Profile'], #app [aria-label='Profil']")) {
      if (!visible(drawer) || drawer.closest("#main, #pane-side, [data-id], [data-pre-plain-text]")) continue;
      const heading = [...drawer.querySelectorAll("header, h1, h2, [role='heading']")]
        .some(node => /^(?:Profile|Profil)$/i.test(text(node)));
      if (!heading) continue;
      const labels = [...drawer.querySelectorAll("span, div, label")]
        .filter(node => /^(?:Phone|Phone number|Téléphone|Numéro de téléphone|Votre numéro de téléphone)$/i.test(text(node)));
      for (const label of labels) {
        const row = label.parentElement;
        for (const node of [row, ...row.querySelectorAll("span, div")]) {
          const value = phone(text(node));
          if (value) candidates.push(value);
        }
      }
    }
    return candidates;
  }
  function messageKey(marker) {
    const id = marker && marker.getAttribute("data-id") || "";
    const match = MESSAGE_ID.exec(id);
    return match && CHAT.test(match[1]) ? { chatId: match[1], id, outgoing: id.startsWith("true_") } : undefined;
  }
  /** Outermost visible message markers in the open conversation (one per bubble). */
  function markers(main) {
    const all = [...main.querySelectorAll("[data-id]")].filter(node => messageKey(node));
    return all.filter(node => {
      const parent = node.parentElement && node.parentElement.closest("[data-id]");
      return !(parent && main.contains(parent) && messageKey(parent)) && visible(node);
    });
  }
  function chatTitle(main, fallback) {
    const header = [...main.querySelectorAll("header")].find(visible);
    if (!header) return fallback;
    const titled = [...header.querySelectorAll("[data-testid='conversation-info-header-chat-title'], [title]")].find(node => visible(node) && (text(node) || node.getAttribute("title")));
    if (titled) return text(titled) || titled.getAttribute("title");
    const named = [...header.querySelectorAll("span[dir='auto']")].find(node => text(node));
    return named ? text(named) : fallback;
  }
  function loadedChat(document) {
    const main = document.querySelector("#main");
    if (!visible(main)) return undefined;
    const messages = markers(main);
    const keys = messages.map(messageKey);
    const ids = new Set(keys.map(key => key.chatId));
    if (ids.size !== 1) return undefined;
    return { id: keys[0].chatId, name: chatTitle(main, keys[0].chatId), messages };
  }
  function identity(document, pageUrl) {
    page(pageUrl);
    // Re-verified on every read: no name/avatar cache survives account switches.
    const phones = [...new Set([...storedPhones(document), ...profilePhones(document)])];
    if (phones.length !== 1) throw new Error(phones.length
      ? "WhatsApp identity is ambiguous (the linked account and the visible Profile phone differ). Reload WhatsApp Web and retry."
      : "WhatsApp identity is not verified yet. Wait until WhatsApp Web has finished loading (scan the QR code if asked). If it still fails, open your own Profile from the left navigation once. Contact names, chat phone numbers and QR codes are never account identity.");
    const chat = loadedChat(document);
    return { accountEmail: phones[0], accountName: `WhatsApp ${phones[0]}`, kind: "whatsapp", pageUrl,
      ...(chat ? { chat: { id: chat.id, name: String(chat.name).slice(0, 512) } } : {}) };
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
  /** Whether the user's locale writes the month before the day (9/23 vs 23/9). */
  function monthFirst(locale) {
    try {
      const order = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(2026, 0, 15)).filter(part => part.type === "day" || part.type === "month");
      return order[0]?.type === "month";
    } catch { return undefined; }
  }
  function pageLocale(document) {
    const view = document.defaultView, language = view && view.navigator && view.navigator.language || "";
    const lang = document.documentElement.getAttribute("lang") || "";
    return lang && language && !language.toLowerCase().startsWith(lang.toLowerCase().split("-")[0]) ? lang : language || lang || undefined;
  }
  /**
   * Parses WhatsApp's displayed "[time, date]" header ("09:20, 23/09/2026", "9:20 PM, 9/23/2026", "14:05, 23.09.26").
   * Unambiguous dates are always used; day/month ambiguity follows the page locale and is skipped if that is unknown.
   */
  function displayedDate(value, locale, now = Date.now()) {
    const match = /^(\d{1,2})[:.h](\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?,\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec((value || "").trim());
    if (!match) return undefined;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (match[3]) {
      if (hour < 1 || hour > 12) return undefined;
      hour = hour % 12 + (/p/i.test(match[3]) ? 12 : 0);
    }
    const a = Number(match[4]), b = Number(match[5]), c = Number(match[6]);
    let year, month, day;
    if (match[4].length === 4) { year = a; month = b; day = c; }
    else if (match[6].length === 4 || match[6].length === 2) {
      year = match[6].length === 2 ? 2000 + c : c;
      if (a > 12 && b <= 12) { day = a; month = b; }
      else if (b > 12 && a <= 12) { month = a; day = b; }
      else if (a === b) { day = a; month = b; }
      else {
        const first = monthFirst(locale);
        if (first === undefined) return undefined;
        [month, day] = first ? [a, b] : [b, a];
      }
    } else return undefined;
    const date = new Date(year, month - 1, day, hour, minute);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour
      || date.getMinutes() !== minute || date.getTime() > now + 86_400_000) return undefined;
    return date.toISOString();
  }
  function extract(document, registration) {
    const current = identity(document, registration.pageUrl);
    if (current.accountEmail !== registration.accountEmail || !current.chat || current.chat.id !== registration.chat?.id)
      throw new Error("WhatsApp account or conversation changed. Open a chat with loaded messages and refresh discovery.");
    const chat = loadedChat(document), locale = pageLocale(document), group = chat.id.endsWith("@g.us");
    const messages = [];
    for (const element of chat.messages) {
      const key = messageKey(element);
      if (!key || key.chatId !== chat.id || messages.some(item => item.id === key.id)) continue;
      const copy = [...element.querySelectorAll("[data-pre-plain-text]")].find(visible);
      const header = copy?.getAttribute("data-pre-plain-text") || "";
      const metadata = /^\[([^\]]+)\]\s*([\s\S]*?):\s*$/.exec(header);
      const outgoing = key.outgoing || element.matches(".message-out") || Boolean(element.querySelector(".message-out"));
      const sender = outgoing ? registration.accountEmail : metadata?.[2]?.trim() || (group ? "" : chat.name);
      if (!sender) continue;
      const bodies = [...element.querySelectorAll(".selectable-text")]
        .filter(node => visible(node) && !node.closest("[data-testid='quoted-message']") && !node.parentElement?.closest(".selectable-text"));
      const files = attachments(element);
      const body = bodies.map(text).filter(Boolean).join("\n");
      if (!body && !files.length) continue;
      const time = [...element.querySelectorAll("time[datetime]")].find(visible)?.getAttribute("datetime");
      const receivedAt = time && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time))
        ? new Date(time).toISOString() : displayedDate(metadata?.[1], locale);
      messages.push({ id: key.id, threadId: chat.id, subject: chat.name, sender,
        recipients: outgoing ? [chat.name] : [registration.accountEmail], body: body || "[Document attachment; bytes not imported]",
        ...(receivedAt ? { receivedAt } : {}), dateText: metadata?.[1] || "", url: "https://web.whatsapp.com/",
        unread: false, completeness: "full", attachments: files });
    }
    if (!messages.length) {
      const main = document.querySelector("#main");
      throw new Error(`No supported visible WhatsApp message bubbles were found. Open a conversation and let its messages load; view-once and media-only messages are not imported. Diagnostic counts: conversation=${visible(main) ? 1 : 0}, message markers=${main ? markers(main).length : 0}, text blocks=${main ? main.querySelectorAll("[data-pre-plain-text]").length : 0}.`);
    }
    return { messages: messages.slice(-200).reverse(), meetings: [],
      coverage: `${Math.min(messages.length, 200)} loaded message bubble(s) from this open chat. Dates come from WhatsApp's displayed timestamps. Older/unloaded messages and media-only messages are omitted. File names are metadata only: manually download and import a copy in Relay Desk. No message is sent.` };
  }
  return { identity, extract, loadedChat, displayedDate };
});