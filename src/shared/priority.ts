import type { Message } from "./contracts";

/** Organizations whose mail comes first, highest priority first. */
export const DEFAULT_PRIORITY_DOMAINS = ["finco.digital", "ai4innov.tech"];

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "ymail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr",
  "live.com", "live.fr", "msn.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "gmx.fr", "mail.com"
]);
const BULK_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|noreply[-.\w]*|newsletters?|news|notifications?|notify|alerts?|mailer(?:-daemon)?|marketing|digest|updates?|info|hello|team|support|community|events?|promo(?:tions?)?|offers?|bounce[-.\w]*|reply)$/i;
const BULK_DOMAIN = /(?:^|\.)(?:substack\.com|medium\.com|linkedin\.com|facebookmail\.com|mailchimp(?:app)?\.com|mcsv\.net|sendgrid\.net|hubspot(?:email)?\.(?:com|net)|beehiiv\.com|convertkit\.com|quora\.com|academia-mail\.com|researchgate\.net|eventbrite\.com|meetup\.com)$/i;
const UNSUBSCRIBE = /unsubscribe|se d[ée]sabonner|d[ée]sinscri|d[ée]sabonnement|manage (?:your )?(?:email )?preferences|view (?:this email )?in (?:your )?browser/i;

export type PriorityTier = "priority" | "professional" | "personal" | "bulk";
export interface MessagePriority {
  tier: PriorityTier;
  /** Matching priority domain, when tier is "priority". */
  domain?: string;
  /** 0-based position in the priority list (lower is more important). */
  rank?: number;
  /** Short label for prompts and the UI, e.g. "finco.digital (priority 1)". */
  label: string;
  /** Focus-score adjustment. */
  boost: number;
}

export function emailAddress(value: string | undefined): string | undefined {
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value || "") ?? /([^\s<>"',;:()]+@[^\s<>"',;:()]+\.[a-z]{2,})/i.exec(value || "");
  return match?.[1]?.toLowerCase();
}
export function emailDomain(value: string | undefined): string | undefined {
  return emailAddress(value)?.split("@")[1]?.replace(/\.$/, "");
}
export function normalizePriorityDomains(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? DEFAULT_PRIORITY_DOMAINS) {
    const domain = value.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) && !out.includes(domain)) out.push(domain);
  }
  return out.slice(0, 20);
}
function domainMatches(domain: string | undefined, target: string): boolean {
  return !!domain && (domain === target || domain.endsWith(`.${target}`));
}

/** Newsletters, notifications and marketing: never urgent and normally not tasks. */
export function isBulkMessage(message: Pick<Message, "sender" | "body">): boolean {
  const address = emailAddress(message.sender);
  const local = address?.split("@")[0] ?? "";
  if (BULK_LOCAL.test(local) || BULK_DOMAIN.test(address?.split("@")[1] ?? "")) return true;
  return UNSUBSCRIBE.test(message.body.slice(-4000)) || UNSUBSCRIBE.test(message.body.slice(0, 1500));
}

/**
 * Orders mail by who it is for: configured organizations first (in list order), then other
 * professional mail, then personal mail, then newsletters and notifications.
 */
export function messagePriority(message: Pick<Message, "sender" | "recipients" | "body">, accountEmail: string | undefined, domains: readonly string[]): MessagePriority {
  const bulk = isBulkMessage(message);
  const accountDomain = emailDomain(accountEmail);
  const senderDomain = emailDomain(message.sender);
  const involved = [accountDomain, senderDomain, ...message.recipients.map(emailDomain)];
  const rank = domains.findIndex(domain => involved.some(value => domainMatches(value, domain)));
  if (bulk) {
    // An organization's own newsletter still ranks above other bulk mail, but below real work.
    return { tier: "bulk", label: rank >= 0 ? `${domains[rank]} newsletter/notification` : "newsletter/notification", boost: rank >= 0 ? -120 : -220 };
  }
  if (rank >= 0) return { tier: "priority", domain: domains[rank], rank, label: `${domains[rank]} (priority ${rank + 1})`, boost: Math.max(140, 300 - rank * 60) };
  if ((accountDomain && !FREE_MAIL.has(accountDomain)) || (senderDomain && !FREE_MAIL.has(senderDomain)))
    return { tier: "professional", label: "other professional", boost: 80 };
  return { tier: "personal", label: "personal", boost: 0 };
}
