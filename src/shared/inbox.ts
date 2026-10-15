import type { Account, Message } from "./contracts";
import { mailboxDate } from "./mail-date";

export function inboxLabel(account: Account): string {
  const provider = account.provider === "gmail" ? "Gmail" : account.provider === "microsoft" ? "Outlook"
    : account.provider === "whatsapp" ? "WhatsApp" : "Slack";
  const connection = account.demo ? "sample" : account.connection === "browser" ? "browser" : "API";
  return `${account.email || account.name} - ${provider} (${connection})`;
}

export function compareRecentMessages(left: Message, right: Message): number {
  const timestamp = (message: Message) => {
    const value = Date.parse(messageReceivedAt(message));
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  const leftTime = timestamp(left), rightTime = timestamp(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const inbox = left.accountId.localeCompare(right.accountId) || left.sourceId.localeCompare(right.sourceId);
  if (inbox) return inbox;
  const position = (left.browser?.position ?? Number.MAX_SAFE_INTEGER) - (right.browser?.position ?? Number.MAX_SAFE_INTEGER);
  return position || left.id.localeCompare(right.id);
}

export function messageReceivedAt(message: Message): string {
  if (message.receivedAt && Number.isFinite(Date.parse(message.receivedAt))) return message.receivedAt;
  return message.browser ? mailboxDate(message.browser.dateText) || "" : "";
}

export function inboxConversations(messages: Message[], selected: string, draftIds: Set<string>, chronology = messages) {
  const key = (message: Message) => JSON.stringify([message.accountId, message.sourceId, message.threadId]);
  const grouped = new Map<string, { message: Message; latest: Message }>();
  for (const message of messages) {
    const id = key(message), previous = grouped.get(id);
    if (!previous) grouped.set(id, { message, latest: message });
    else if (message.id === selected || (previous.message.id !== selected
      && !draftIds.has(previous.message.id) && draftIds.has(message.id))) previous.message = message;
  }
  for (const message of chronology) {
    const group = grouped.get(key(message));
    if (group && !message.deleted && compareRecentMessages(message, group.latest) < 0) group.latest = message;
  }
  return [...grouped.values()].sort((left, right) => compareRecentMessages(left.latest, right.latest));
}
