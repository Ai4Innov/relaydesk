import type { Message } from "./contracts";
import { messageReceivedAt } from "./inbox";

export function isMailPreview(message: Message): boolean {
  return message.browser?.completeness === "preview" || message.providerId.startsWith("thread:");
}

export function mailEvidenceLocation(message: Message): string {
  return isMailPreview(message) ? "Browser Inbox preview (incomplete)" : "Full message body";
}

export function mailThreadKey(message: Message): string {
  return JSON.stringify([message.accountId, message.sourceId, message.threadId]);
}

/** Resolves an account to its normalized mailbox address so relay, API and browser copies of one mailbox can be merged. */
type MailboxLookup = (accountId: string) => string | undefined;
const GMAIL_HEX = /^[0-9a-f]{8,24}$/i;

/** Gmail's native hexadecimal thread ID, from browser row markers or API/relay thread links. */
function gmailThreadHex(message: Message): string | undefined {
  const marker = message.threadId.lastIndexOf(":thread:");
  if (message.browser) {
    if (marker < 0) return undefined;
    try {
      const value = decodeURIComponent(message.threadId.slice(marker + 8));
      return GMAIL_HEX.test(value) ? value.toLowerCase() : undefined;
    } catch { return undefined; }
  }
  const linked = /#all\/([0-9a-f]{8,24})$/i.exec(message.url);
  return linked?.[1].toLowerCase();
}

function gmailMessageHex(message: Message): string | undefined {
  return !isMailPreview(message) && GMAIL_HEX.test(message.providerId) ? message.providerId.toLowerCase() : undefined;
}

/** Cross-connection thread key when the mailbox is known; otherwise the account-scoped key. */
export function mailboxThreadKey(message: Message, mailbox?: MailboxLookup): string {
  const email = mailbox?.(message.accountId), thread = gmailThreadHex(message);
  return email && thread ? JSON.stringify(["mailbox", email, thread]) : mailThreadKey(message);
}

export function fullThreadMessages(preview: Message, messages: readonly Message[], mailbox?: MailboxLookup): Message[] {
  if (!isMailPreview(preview) || !preview.threadId) return [];
  const key = mailboxThreadKey(preview, mailbox);
  return messages.filter(message => !message.deleted && !isMailPreview(message) &&
    (mailbox ? true : message.browser?.completeness === "full") && mailboxThreadKey(message, mailbox) === key);
}

/**
 * Prefers complete bodies: duplicate copies of one Gmail message keep the relay/API original,
 * and Inbox previews are hidden when a full body of the same thread is at least as recent.
 */
export function preferredMailEvidence(messages: readonly Message[], mailbox?: MailboxLookup): Message[] {
  let live = messages.filter(message => !message.deleted);
  if (mailbox) {
    const best = new Map<string, Message>();
    const rank = (message: Message) => message.browser ? 1 : 2;
    for (const message of live) {
      const email = mailbox(message.accountId), id = gmailMessageHex(message);
      if (!email || !id) continue;
      const key = `${email}\n${id}`, current = best.get(key);
      if (!current || rank(message) > rank(current)) best.set(key, message);
    }
    live = live.filter(message => {
      const email = mailbox(message.accountId), id = gmailMessageHex(message);
      return !email || !id || best.get(`${email}\n${id}`) === message;
    });
  }
  const fullThreads = new Map<string, number>();
  for (const message of live) {
    if (!message.threadId || isMailPreview(message) || (!mailbox && message.browser?.completeness !== "full")) continue;
    const key = mailboxThreadKey(message, mailbox), received = Date.parse(messageReceivedAt(message));
    fullThreads.set(key, Math.max(fullThreads.get(key) ?? -Infinity, Number.isFinite(received) ? received : -Infinity));
  }
  return live.filter(message => {
    if (!isMailPreview(message)) return true;
    const latestFull = fullThreads.get(mailboxThreadKey(message, mailbox));
    if (latestFull === undefined) return true;
    // A newly received reply preview must not disappear behind an older downloaded body.
    const received = Date.parse(messageReceivedAt(message));
    return Number.isFinite(received) && received > latestFull;
  });
}
