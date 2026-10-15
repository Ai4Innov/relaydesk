import type { Account, Attachment, CalendarEvent, Draft, EventChange, Message, Source } from "../../shared/contracts";
import { cancelledEvent, ConflictError, HttpClient, ProviderError, UncertainWriteError, emptyPage, id, list, number, object, optionalObject, query, required,
  revision, source, text, textBody, type Json, type OnPage, type Vault } from "./core";
import { eventBody, isReminderMinutes, validateChange } from "./calendar";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0/";
function address(value: unknown): string { return text(optionalObject(optionalObject(value).emailAddress).address); }
export function graphMessage(account: Account, selected: Source, data: Json, historical: boolean): Message {
  const providerId = required(data.id);
  const body = optionalObject(data.body);
  return { id: id(account.id, "message", providerId), accountId: account.id, sourceId: selected.id, providerId,
    threadId: id(account.id, "thread", text(data.conversationId, providerId)), subject: text(data.subject), sender: address(data.from),
    recipients: list(data.toRecipients).map(address), body: text(body.contentType).toLowerCase() === "html" ? textBody(text(body.content)) : text(body.content),
    html: text(body.contentType).toLowerCase() === "html" ? text(body.content).slice(0, 1_000_000) : undefined,
    receivedAt: text(data.receivedDateTime, new Date(0).toISOString()), url: text(data.webLink), unread: data.isRead === false,
    revision: revision(data), historical };
}
export function graphEvent(account: Account, selected: Source, data: Json): CalendarEvent {
  const start = optionalObject(data.start);
  const end = optionalObject(data.end);
  const cancelled = data.isCancelled === true || !!data["@removed"];
  const allDay = data.isAllDay === true;
  const reminderMinutes = data.isReminderOn === true && isReminderMinutes(data.reminderMinutesBeforeStart) ? data.reminderMinutesBeforeStart : undefined;
  const date = (value: Json) => allDay ? text(value.dateTime).slice(0, 10) : text(value.dateTime) + (text(value.timeZone) === "UTC" && !/Z$|[+-]\d\d:\d\d$/.test(text(value.dateTime)) ? "Z" : "");
  return { id: id(account.id, "event", `${selected.providerId}:${required(data.id)}`), accountId: account.id, sourceId: selected.id,
    providerId: required(data.id), title: `${cancelled ? "(Cancelled) " : ""}${text(data.subject)}`,
    start: date(start), end: date(end), timeZone: text(start.timeZone, "UTC"), allDay,
    attendees: list(data.attendees).map(address).filter(Boolean), location: text(optionalObject(data.location).displayName),
    description: textBody(text(optionalObject(data.body).content)), revision: revision(data), url: text(data.webLink),
    recurring: !!data.recurrence || !!data.seriesMasterId || data.type === "seriesMaster", writable: !cancelled && data.isOrganizer !== false, reminderMinutes };
}
interface MailCursor { next?: string; delta?: string; historical: boolean }
interface EventCursor { next?: string; start: string; end: string; seenIds?: string[] }
export class MicrosoftConnector {
  constructor(private readonly http: HttpClient, private readonly vault: Vault) {}
  async discover(account: Account): Promise<Source[]> {
    const result: Source[] = [];
    const folders = ["me/mailFolders?includeHiddenFolders=false&$top=100"];
    const seen = new Set<string>();
    for (let index = 0; index < folders.length; index++) {
      let next: string | undefined = folders[index];
      while (next) {
        const page = await this.http.json(next);
        for (const folder of list(page.value)) {
          const providerId = required(folder.id);
          if (seen.has(providerId)) continue;
          seen.add(providerId);
          result.push(source(account, providerId, text(folder.displayName), "mail"));
          if (number(folder.childFolderCount) > 0) folders.push(`me/mailFolders/${encodeURIComponent(providerId)}/childFolders?includeHiddenFolders=false&$top=100`);
        }
        next = text(page["@odata.nextLink"]) || undefined;
      }
    }
    let next: string | undefined = "me/calendars?$top=100";
    while (next) {
      const page = await this.http.json(next);
      result.push(...list(page.value).map(value => source(account, required(value.id), text(value.name), "calendar")));
      next = text(page["@odata.nextLink"]) || undefined;
    }
    return result;
  }
  async sync(account: Account, selected: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    if (selected.kind === "calendar") return this.syncCalendar(account, selected, onPage, signal);
    if (selected.kind !== "mail") throw new Error("Unsupported Microsoft source");
    const checkpointId = id(account.id, "checkpoint", selected.id);
    const cursor = this.vault.get<MailCursor>("checkpoints", checkpointId);
    let next: string | undefined = cursor?.next || cursor?.delta || `me/mailFolders/${encodeURIComponent(selected.providerId)}/messages/delta?$top=50`;
    const historical = cursor?.historical ?? true;
    try {
      while (next) {
        const page = await this.http.json(next, { signal });
        const result = emptyPage();
        for (const value of list(page.value)) {
          const providerId = required(value.id);
          if (value["@removed"]) {
            const existing = this.vault.get<Message>("messages", id(account.id, "message", providerId));
            if (existing?.sourceId === selected.id) result.messages.push({ ...existing, deleted: true });
            continue;
          }
          const message = graphMessage(account, selected, value, historical);
          result.messages.push(message);
          if (value.hasAttachments === true) result.attachments.push(...await this.attachments(account, message, signal));
        }
        next = text(page["@odata.nextLink"]) || undefined;
        result.checkpoint = { id: checkpointId, value: next ? { next, historical } : { delta: required(page["@odata.deltaLink"]), historical: false } };
        await onPage(result);
      }
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 410) throw error;
      await onPage(emptyPage({ id: checkpointId, value: { historical: true } }));
      throw new Error("Microsoft delta cursor expired; retry sync for a full selected-folder refresh");
    }
  }
  private async attachments(account: Account, message: Message, signal?: AbortSignal): Promise<Attachment[]> {
    const result: Attachment[] = [];
    let next: string | undefined = `me/messages/${encodeURIComponent(message.providerId)}/attachments?$select=id,name,contentType,size,isInline&$top=100`;
    while (next) {
      const page = await this.http.json(next, { signal });
      for (const value of list(page.value)) {
        if (value.isInline === true) continue;
        const providerId = JSON.stringify({ messageId: message.providerId, attachmentId: required(value.id) });
        const reference = value["@odata.type"] === "#microsoft.graph.referenceAttachment";
        result.push({ id: id(account.id, "attachment", providerId), accountId: account.id, messageId: message.id, providerId,
          name: text(value.name), mimeType: text(value.contentType, "application/octet-stream"), size: number(value.size),
          status: reference ? "blocked" : "pending", ...(reference ? { reason: "External references require a separately authorized connector" } : {}) });
      }
      next = text(page["@odata.nextLink"]) || undefined;
    }
    return result;
  }
  private async syncCalendar(account: Account, selected: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    const checkpointId = id(account.id, "checkpoint", selected.id);
    const prior = this.vault.get<EventCursor>("checkpoints", checkpointId);
    const now = Date.now();
    // Graph v1.0 calendarView delta is not available for arbitrary selected calendars.
    // Reconcile a documented rolling window, with a durable continuation for every page.
    const window = prior?.next ? prior : { start: new Date(now - 365 * 86400000).toISOString(), end: new Date(now + 730 * 86400000).toISOString() };
    let next: string | undefined = window.next || query(`me/calendars/${encodeURIComponent(selected.providerId)}/calendarView`,
      { startDateTime: window.start, endDateTime: window.end, "$top": "100" });
    const seen = new Set(window.seenIds ?? []);
    const canReconcile = !window.next || Array.isArray(window.seenIds);
    while (next) {
      const page = await this.http.json(next, { signal });
      const events = list(page.value).map(value => {
        const event = graphEvent(account, selected, value);
        const existing = this.vault.get<CalendarEvent>("events", event.id);
        return (value.isCancelled === true || !!value["@removed"]) && existing ? cancelledEvent(existing, event.revision) : event;
      });
      for (const event of events) seen.add(event.id);
      next = text(page["@odata.nextLink"]) || undefined;
      if (!next && canReconcile) {
        for (const existing of this.vault.all<CalendarEvent>("events")) {
          if (existing.accountId === account.id && existing.sourceId === selected.id && !seen.has(existing.id) &&
            Date.parse(existing.start) >= Date.parse(window.start) && Date.parse(existing.end) <= Date.parse(window.end)) {
            events.push(cancelledEvent(existing));
          }
        }
      }
      await onPage({ ...emptyPage(), events, checkpoint: { id: checkpointId,
        value: { start: window.start, end: window.end, next, ...(next ? { seenIds: [...seen] } : {}) } } });
    }
  }
  async saveDraft(_account: Account, message: Message, draft: Draft): Promise<{ providerId: string; providerRevision: string }> {
    const original = await this.http.json(`me/messages/${encodeURIComponent(message.providerId)}`);
    if (revision(original) !== draft.sourceRevision) throw new ConflictError();
    const body = { subject: draft.subject, body: { contentType: "text", content: draft.body },
      toRecipients: draft.recipients.map(address => ({ emailAddress: { address } })) };
    let result: Json;
    if (draft.providerId) {
      const remote = await this.http.json(`me/messages/${encodeURIComponent(draft.providerId)}`);
      if (!draft.providerRevision || revision(remote) !== draft.providerRevision || remote.isDraft !== true ||
        text(remote.conversationId) !== text(original.conversationId)) throw new ConflictError();
      result = await this.http.write(`me/messages/${encodeURIComponent(draft.providerId)}`, "PATCH", body, draft.providerRevision);
    } else {
      result = await this.http.write(`me/messages/${encodeURIComponent(message.providerId)}/createReplyAll`, "POST", { message: body });
    }
    try {
      const providerId = required(result.id);
      const saved = await this.http.json(`me/messages/${encodeURIComponent(providerId)}`);
      if (saved.isDraft !== true) throw new ConflictError();
      return { providerId, providerRevision: revision(saved) };
    } catch { throw new UncertainWriteError(); }
  }
  async downloadAttachment(attachment: Attachment, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const reference = object(JSON.parse(attachment.providerId));
    const response = await this.http.response(`me/messages/${encodeURIComponent(required(reference.messageId))}/attachments/${encodeURIComponent(required(reference.attachmentId))}/$value`, { signal });
    if (!response.body) throw new Error("Provider returned no attachment body");
    return response.body;
  }
  async writeEvent(account: Account, selected: Source, change: EventChange, operationId: string): Promise<CalendarEvent> {
    validateChange(change);
    const path = `me/calendars/${encodeURIComponent(selected.providerId)}/events`;
    let result: Json;
    if (change.eventId) {
      const existing = this.vault.get<CalendarEvent>("events", change.eventId);
      if (!existing || existing.sourceId !== selected.id) throw new Error("Unknown event");
      const remote = await this.http.json(`${path}/${encodeURIComponent(existing.providerId)}`);
      if (remote.recurrence || remote.seriesMasterId || remote.type === "seriesMaster") throw new Error("Recurring event edits are not supported; use Outlook");
      if (!change.expectedRevision || revision(remote) !== change.expectedRevision || remote.isCancelled === true || remote.isOrganizer === false) throw new ConflictError();
      result = await this.http.write(`${path}/${encodeURIComponent(existing.providerId)}`, "PATCH", eventBody("microsoft", change), change.expectedRevision);
    } else {
      result = await this.http.write(path, "POST", { ...eventBody("microsoft", change), transactionId: operationId });
    }
    return graphEvent(account, selected, result);
  }
}
