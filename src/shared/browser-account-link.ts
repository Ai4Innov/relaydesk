import { z } from "zod";

export const ACCOUNT_LINK_MAX_LENGTH = 8192;
export const ACCOUNT_LINK_ERROR = "Enter an HTTPS Gmail (/mail/) or Google Calendar (/calendar/) link without credentials, a custom port or conflicting account routes.";
type AccountLink = { url: string; kind: "mail" | "calendar" };
type AccountLinkResult = { link: AccountLink; error?: never } | { link?: never; error: string };
const slotPattern = /^(0|[1-9]\d{0,3})$/;
const emailSchema = z.string().email().max(320);

// This produces navigation hints only. Identity still comes from companion header discovery.
export function parseBrowserAccountLink(input: string): AccountLinkResult {
  const invalid = { error: ACCOUNT_LINK_ERROR };
  if (input.length > ACCOUNT_LINK_MAX_LENGTH) return invalid;
  const value = input.trim();
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return invalid;
  const parts = /^https:\/\/(mail\.google\.com|calendar\.google\.com)(?::443)?(\/[^?#]*)(?:[?#].*)?$/i.exec(value);
  if (!parts) return invalid;
  let path: string;
  try { path = decodeURIComponent(parts[2]); }
  catch (error) {
    if (!(error instanceof URIError)) throw error;
    return invalid;
  }
  // Reject encoded separators, double encoding and traversal before URL normalization.
  if (/%(?:2f|5c)/i.test(parts[2]) || /[%\\?#\s\u0000-\u001f\u007f]/.test(path)
      || path.split("/").some(part => part === "." || part === "..")) return invalid;
  const kind = parts[1].toLowerCase() === "mail.google.com" ? "mail" : "calendar";
  const prefix = kind === "mail" ? "/mail/" : "/calendar/";
  if (!path.startsWith(prefix)) return invalid;
  const tail = path.slice(prefix.length);
  const slot = /^u\/(0|[1-9]\d{0,3})(?:\/|$)/.exec(tail)?.[1];
  if ((tail === "u" || tail.startsWith("u/")) && slot === undefined) return invalid;
  if (/(?:^|\/)u(?:\/|$)/.test(tail.replace(/^u\/\d+\/?/, ""))) return invalid;
  const selectors = new URL(value).searchParams.getAll("authuser");
  if (selectors.length > 1) return invalid;
  const selector = selectors[0];
  if (selector !== undefined && !slotPattern.test(selector) && !emailSchema.safeParse(selector).success) return invalid;
  if (slot !== undefined && selector !== undefined && selector !== slot) return invalid;
  const route = slot ?? (selector !== undefined && slotPattern.test(selector) ? selector : undefined);
  const query = selector !== undefined && route === undefined ? `?authuser=${encodeURIComponent(selector.toLowerCase())}` : "";
  return { link: {
    kind,
    url: `https://${parts[1].toLowerCase()}${prefix}${route === undefined ? "" : `u/${route}/`}${query}${kind === "mail" ? "#inbox" : ""}`
  } };
}
