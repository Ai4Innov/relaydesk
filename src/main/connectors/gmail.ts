import type { Account, Attachment, CalendarEvent, Citation, Draft, EventChange, Message, Source } from "../../shared/contracts";
import type { BrowserCapture, BrowserMail } from "../../shared/browser";
import { cancelledEvent, ConflictError, HttpClient, ProviderError, UncertainWriteError, emptyPage, hash, id, list, number, object, optionalObject, query, required,
  revision, source, strings, text, textBody, type Json, type OnPage, type Page, type Vault } from "./core";
import { eventBody, isReminderMinutes, validateChange } from "./calendar";

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/";
export const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/";
interface MailCursor { phase: "backfill" | "history"; historyId: string; pageToken?: string }
interface CalendarCursor { syncToken?: string; pageToken?: string; seenIds?: string[] }
export interface GmailMailInput {
  accountId: string;
  accountEmail: string;
  threadId: string;
  messageProviderId?: string;
  inboxRefresh?: boolean;
}
const FULL_MAIL_BYTES = 2 * 1024 * 1024;
function checkMailSize(bytes: number): void {
  if (bytes > FULL_MAIL_BYTES) throw new Error("Gmail mail exceeds the 2 MB full-mail capture limit; open the original conversation.");
}
function nativeMailId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new Error("Invalid exact Gmail identifier");
  return value;
}
export interface BrowserThreadResolution {
  message: Message;
  citations: Citation[];
  threadProviderId: string;
  threadRevision: string;
}
const browserSourceId = (accountId: string) => id(accountId, "mail", "__browser-thread__");
export function gmailThreadRevision(thread: Json): string {
  // Saving our own draft changes thread.historyId, but not the conversation being replied to.
  return hash(JSON.stringify(list(thread.messages).filter(message => !strings(message.labelIds).includes("DRAFT"))
    .map(message => [required(message.id), required(message.historyId)]).sort((a, b) => a[0].localeCompare(b[0]))));
}
function header(payload: Json, name: string): string {
  return text(list(payload.headers).find(value => text(value.name).toLowerCase() === name.toLowerCase())?.value);
}
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
function emailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return normalizeEmail(match?.[1] ?? value);
}
function normalizeSubject(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase().replace(/^(?:(?:re|fwd?)\s*:\s*)+/i, "");
}
function browserThreadHint(accountId: string, message: Message): string | undefined {
  const prefix = `${accountId}:thread:`;
  const raw = message.threadId.startsWith(prefix) ? decodeURIComponent(message.threadId.slice(prefix.length))
    : message.providerId.startsWith("thread:") ? message.providerId.slice("thread:".length) : "";
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : undefined;
}
function browserMessageHint(message: Message): string | undefined {
  const raw = message.providerId.startsWith("thread:") ? "" : message.providerId;
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : undefined;
}
function isMimeAttachment(payload: Json): boolean {
  return !!text(payload.filename) || /^attachment(?:;|$)/i.test(header(payload, "Content-Disposition").trim());
}
function mimeText(payload: Json): string {
  const bytes = Buffer.from(text(optionalObject(payload.body).data), "base64url");
  checkMailSize(bytes.length);
  const charset = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(header(payload, "Content-Type"));
  try { return new TextDecoder(charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "utf-8").decode(bytes); }
  catch { throw new Error("Unsupported Gmail MIME charset; open the original message."); }
}
function mimeContent(payload: Json): string {
  if (isMimeAttachment(payload)) return "";
  const parts = list(payload.parts);
  if (parts.length) {
    const plain = parts.filter(part => text(part.mimeType) === "text/plain" && !isMimeAttachment(part));
    return (plain.length ? plain : parts).filter(part => !isMimeAttachment(part)).map(mimeContent).filter(Boolean).join("\n");
  }
  const type = text(payload.mimeType);
  if (type !== "text/plain" && type !== "text/html") return "";
  const value = mimeText(payload);
  return type === "text/html" ? textBody(value) : value;
}
function mimeHtml(payload: Json): string {
  if (isMimeAttachment(payload)) return "";
  if (text(payload.mimeType) === "text/html")
    return mimeText(payload);
  return list(payload.parts).map(mimeHtml).filter(Boolean).join("\n");
}
function gmailRecord(account: Account, sourceId: string, data: Json, historical: boolean): { message: Message; attachments: Attachment[] } {
  const providerId = required(data.id);
  const payload = optionalObject(data.payload);
  const message: Message = { id: id(account.id, "message", providerId), accountId: account.id, sourceId, providerId,
    threadId: id(account.id, "thread", required(data.threadId)), subject: header(payload, "Subject"), sender: header(payload, "From"),
    recipients: header(payload, "To").split(",").map(value => value.trim()).filter(Boolean), body: mimeContent(payload),
    html: mimeHtml(payload) || undefined,
    receivedAt: new Date(Number(text(data.internalDate, "0"))).toISOString(),
    url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#all/${encodeURIComponent(text(data.threadId))}`,
    unread: strings(data.labelIds).includes("UNREAD"), revision: required(data.historyId), historical };
  const attachments: Attachment[] = [];
  function visit(part: Json): void {
    const body = optionalObject(part.body);
    if (isMimeAttachment(part) && text(body.attachmentId)) {
      const providerAttachment = JSON.stringify({ messageId: providerId, attachmentId: required(body.attachmentId) });
      attachments.push({ id: id(account.id, "attachment", providerAttachment), accountId: account.id, messageId: message.id,
        providerId: providerAttachment, name: text(part.filename, "attachment"), mimeType: text(part.mimeType, "application/octet-stream"),
        size: typeof body.size === "number" && Number.isFinite(body.size) && body.size >= 0 ? body.size : undefined, status: "pending" });
    }
    for (const child of list(part.parts)) visit(child);
  }
  visit(payload);
  return { message, attachments };
}
export function gmailMessage(account: Account, selected: Source, data: Json, historical: boolean): { message: Message; attachments: Attachment[] } {
  return gmailRecord(account, selected.id, data, historical);
}
export function googleEvent(account: Account, selected: Source, data: Json): CalendarEvent {
  const start = optionalObject(data.start);
  const end = optionalObject(data.end);
  const reminders = optionalObject(data.reminders);
  const reminderMinutes = reminders.useDefault === false
    ? list(reminders.overrides).map(value => value.minutes).find(isReminderMinutes)
    : undefined;
  const cancelled = data.status === "cancelled";
  return { id: id(account.id, "event", `${selected.providerId}:${required(data.id)}`), accountId: account.id, sourceId: selected.id,
    providerId: required(data.id), title: `${cancelled ? "(Cancelled) " : ""}${text(data.summary)}`,
    start: text(start.dateTime) || text(start.date), end: text(end.dateTime) || text(end.date), timeZone: text(start.timeZone, "UTC"),
    allDay: !!text(start.date), attendees: list(data.attendees).map(value => text(value.email)).filter(Boolean),
    location: text(data.location), description: textBody(text(data.description)), revision: revision(data), url: text(data.htmlLink),
    recurring: !!data.recurringEventId || Array.isArray(data.recurrence), writable: !cancelled, reminderMinutes };
}
export class GmailConnector {
  constructor(private readonly mail: HttpClient, private readonly calendar: HttpClient, private readonly vault: Vault) {}
  private async guardedRead(path: string, beforeRead: () => void, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted();
    beforeRead();
    const result = await this.mail.json(path, { signal });
    signal?.throwIfAborted();
    beforeRead();
    return result;
  }
  async verifyMailbox(email: string, beforeRead: () => void, signal?: AbortSignal): Promise<void> {
    const profile = await this.guardedRead("users/me/profile", beforeRead, signal);
    if (normalizeEmail(required(profile.emailAddress)) !== normalizeEmail(email))
      throw new Error("Gmail API mailbox identity does not match the authorized account");
  }
  private async hydrateMime(messageId: string, payload: Json, beforeRead: () => void, signal?: AbortSignal): Promise<void> {
    let total = 0;
    const visit = async (part: Json): Promise<void> => {
      signal?.throwIfAborted();
      beforeRead();
      if (isMimeAttachment(part)) return;
      const type = text(part.mimeType);
      if (type === "text/plain" || type === "text/html") {
        const body = optionalObject(part.body);
        checkMailSize(total + number(body.size));
        if (typeof body.data !== "string" && text(body.attachmentId)) {
          const data = await this.guardedRead(`users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(required(body.attachmentId))}`, beforeRead, signal);
          if (typeof data.data !== "string") throw new Error("Gmail full message body is unavailable");
          body.data = data.data;
          part.body = body;
        }
        if (typeof body.data !== "string" && number(body.size) > 0)
          throw new Error("Gmail full message body is unavailable");
        const encoded = text(body.data);
        if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) throw new Error("Invalid Gmail MIME body encoding");
        const bytes = Buffer.from(encoded, "base64url").length;
        total += bytes;
        checkMailSize(total);
        if (typeof body.size === "number" && body.size !== bytes) throw new Error("Gmail full message body is unavailable or incomplete");
        if (number(body.size) > 0 && !encoded.length) throw new Error("Gmail full message body is unavailable");
      }
      for (const child of list(part.parts)) await visit(child);
    };
    await visit(payload);
  }
  async readMail(account: Account, selected: Source, input: GmailMailInput, beforeRead: () => void, signal?: AbortSignal): Promise<BrowserCapture> {
    return this.readMailData(account, selected, input, beforeRead, signal);
  }
  async readThreadPage(account: Account, selected: Source, providerMessageId: string, beforeRead: () => void,
    signal?: AbortSignal): Promise<Page> {
    nativeMailId(providerMessageId);
    await this.verifyMailbox(account.email, beforeRead, signal);
    const target = await this.guardedRead(query(`users/me/messages/${encodeURIComponent(providerMessageId)}`,
      { format: "metadata" }), beforeRead, signal);
    if (required(target.id) !== providerMessageId) throw new Error("Gmail returned a different message identifier");
    const page = emptyPage();
    await this.readMailData(account, selected, { accountId: account.id, accountEmail: account.email,
      threadId: nativeMailId(required(target.threadId)), messageProviderId: providerMessageId }, beforeRead, signal, page);
    beforeRead();
    return page;
  }
  private async readMailData(account: Account, selected: Source, input: GmailMailInput, beforeRead: () => void,
    signal?: AbortSignal, records?: Page): Promise<BrowserCapture> {
    beforeRead();
    if (account.provider !== "gmail" || account.connection === "browser" || account.status !== "connected" || !account.consent ||
      normalizeEmail(account.email) !== normalizeEmail(input.accountEmail) || !selected.selected ||
      selected.accountId !== account.id || selected.kind !== "mail" || !selected.providerId ||
      input.inboxRefresh && selected.providerId !== "INBOX")
      throw new Error("Gmail account or selected mail source authorization rejected");
    const threadId = input.inboxRefresh ? undefined : nativeMailId(input.threadId);
    const messageId = input.messageProviderId ? nativeMailId(input.messageProviderId) : undefined;
    await this.verifyMailbox(account.email, beforeRead, signal);
    const pageUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(normalizeEmail(account.email))}#${selected.providerId === "INBOX" ? "inbox" : "all"}`;
    const capture: BrowserCapture = { kind: "mail", accountEmail: normalizeEmail(account.email), accountName: account.name,
      pageUrl: threadId ? `${pageUrl}/${encodeURIComponent(threadId)}` : pageUrl, messages: [], meetings: [] };
    const threadIds = threadId ? [threadId] : list((await this.guardedRead(query("users/me/threads",
      { labelIds: selected.providerId, maxResults: "50" }), beforeRead, signal)).threads)
      .slice(0, 50).map(entry => nativeMailId(required(entry.id)));
    for (const target of [...new Set(threadIds)]) {
      const data = await this.guardedRead(query(`users/me/threads/${encodeURIComponent(target)}`,
        { format: input.inboxRefresh ? "metadata" : "full" }), beforeRead, signal);
      if (required(data.id) !== target) throw new Error("Gmail returned a different thread identifier");
      const members = list(data.messages);
      if (members.some(member => required(member.threadId) !== target)) throw new Error("Gmail message thread boundary rejected");
      const received = members.filter(member => !strings(member.labelIds).includes("DRAFT"));
      if (!received.some(member => strings(member.labelIds).includes(selected.providerId))) {
        if (input.inboxRefresh) continue; // A conversation may leave Inbox between listing and reading.
        throw new Error("Gmail conversation is outside the selected mail source");
      }
      if (messageId && !received.some(member => required(member.id) === messageId))
        throw new Error("Exact Gmail message is not in the selected conversation");
      const chosen = input.inboxRefresh ? received.reduce<Json[]>((latest, member) =>
        !latest.length || Number(required(member.internalDate)) > Number(required(latest[0].internalDate)) ? [member] : latest, []) : received;
      const seen = new Set<string>();
      for (const member of chosen) {
        const providerId = nativeMailId(required(member.id));
        if (seen.has(providerId)) throw new Error("Duplicate Gmail message identifier");
        seen.add(providerId);
        const timestamp = Number(required(member.internalDate));
        if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Gmail message date is unavailable");
        const receivedAt = new Date(timestamp).toISOString();
        const payload = optionalObject(member.payload);
        if (!input.inboxRefresh) {
          if (!text(payload.mimeType)) throw new Error("Gmail full message MIME payload is unavailable");
          await this.hydrateMime(providerId, payload, beforeRead, signal);
        }
        const item: BrowserMail = { id: input.inboxRefresh ? `thread:${target}` : providerId, threadId: target,
          subject: header(payload, "Subject"), sender: header(payload, "From"),
          recipients: header(payload, "To").split(",").map(value => value.trim()).filter(Boolean),
          body: input.inboxRefresh ? text(member.snippet) : mimeContent(payload),
          html: input.inboxRefresh ? undefined : mimeHtml(payload) || undefined,
          receivedAt, dateText: receivedAt, url: `${pageUrl}/${encodeURIComponent(target)}`,
          unread: input.inboxRefresh ? received.some(value => strings(value.labelIds).includes("UNREAD"))
            : strings(member.labelIds).includes("UNREAD"), completeness: input.inboxRefresh ? "preview" : "full" };
        if (!input.inboxRefresh) {
          const record = gmailRecord(account, selected.id, member, false);
          if (records) {
            records.messages.push(record.message);
            records.attachments.push(...record.attachments);
          }
          item.attachments = record.attachments.map(attachment =>
            ({ id: attachment.providerId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }));
          let complete = true;
          const inspect = (part: Json): void => {
            const type = text(part.mimeType);
            if ((isMimeAttachment(part) || !type.startsWith("multipart/") && type !== "text/plain" && type !== "text/html") &&
              (!isMimeAttachment(part) || !text(optionalObject(part.body).attachmentId))) complete = false;
            for (const child of list(part.parts)) inspect(child);
          };
          inspect(payload);
          if (complete) item.attachmentManifestVersion = 1;
        }
        capture.messages.push(item);
        checkMailSize(Buffer.byteLength(JSON.stringify(capture)));
      }
    }
    signal?.throwIfAborted();
    beforeRead();
    return capture;
  }
  async discover(account: Account): Promise<Source[]> {
    const labels = await this.mail.json("users/me/labels");
    const sources = list(labels.labels).map(label => source(account, required(label.id), text(label.name), "mail"));
    let next: string | undefined;
    do {
      const page = await this.calendar.json(query("users/me/calendarList", { maxResults: "250", pageToken: next }));
      for (const value of list(page.items)) sources.push(source(account, required(value.id), text(value.summary), "calendar"));
      next = text(page.nextPageToken) || undefined;
    } while (next);
    return sources;
  }
  async sync(account: Account, selected: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    if (selected.kind === "calendar") return this.syncCalendar(account, selected, onPage, signal);
    if (selected.kind !== "mail") throw new Error("Unsupported Gmail source");
    const checkpointId = id(account.id, "checkpoint", selected.id);
    let cursor = this.vault.get<MailCursor>("checkpoints", checkpointId);
    if (!cursor) cursor = { phase: "backfill", historyId: required((await this.mail.json("users/me/profile", { signal })).historyId) };
    if (cursor.phase === "backfill") {
      do {
        const page = await this.mail.json(query("users/me/messages", { labelIds: selected.providerId, maxResults: "100", pageToken: cursor.pageToken }), { signal });
        const results = emptyPage();
        for (const entry of list(page.messages)) {
          const result = await this.getMessage(account, selected, required(entry.id), true, signal);
          if (result) { results.messages.push(result.message); results.attachments.push(...result.attachments); }
        }
        cursor = { ...cursor, pageToken: text(page.nextPageToken) || undefined };
        if (!cursor.pageToken) cursor = { phase: "history", historyId: cursor.historyId };
        results.checkpoint = { id: checkpointId, value: cursor };
        await onPage(results);
      } while (cursor.phase === "backfill");
    }
    try {
      let next: string | undefined = cursor.pageToken;
      do {
        const page = await this.mail.json(query("users/me/history", { startHistoryId: cursor.historyId, maxResults: "100", pageToken: next }), { signal });
        const changed = new Set<string>();
        const deleted = new Set<string>();
        for (const entry of list(page.history)) {
          for (const message of list(entry.messages)) changed.add(required(message.id));
          for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved"]) {
            for (const item of list(entry[key])) changed.add(required(object(item.message).id));
          }
          for (const item of list(entry.messagesDeleted)) deleted.add(required(object(item.message).id));
        }
        const result = emptyPage();
        for (const providerId of changed) {
          if (deleted.has(providerId)) continue;
          const incoming = await this.getMessage(account, selected, providerId, false, signal);
          if (incoming) { result.messages.push(incoming.message); result.attachments.push(...incoming.attachments); }
        }
        for (const providerId of deleted) {
          const existing = this.vault.get<Message>("messages", id(account.id, "message", providerId));
          if (existing?.sourceId === selected.id) result.messages.push({ ...existing, deleted: true, revision: text(page.historyId, existing.revision) });
        }
        next = text(page.nextPageToken) || undefined;
        const value: MailCursor = next ? { ...cursor, pageToken: next } : { phase: "history", historyId: required(page.historyId) };
        result.checkpoint = { id: checkpointId, value };
        await onPage(result);
      } while (next);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 404) throw error;
      // An expired history cursor requires a new complete import, never a skipped history gap.
      await onPage(emptyPage({ id: checkpointId, value: { phase: "backfill", historyId: required((await this.mail.json("users/me/profile", { signal })).historyId) } }));
      throw new Error("Gmail history cursor expired; the next sync will safely rebuild selected history");
    }
  }
  private directMessage(account: Account, data: Json): Message {
    return gmailRecord(account, browserSourceId(account.id), data, false).message;
  }
  private async readMessageData(providerId: string): Promise<Json | undefined> {
    try { return await this.mail.json(`users/me/messages/${encodeURIComponent(providerId)}?format=full`); }
    catch (error) {
      if (error instanceof ProviderError && error.status === 404) return undefined;
      throw error;
    }
  }
  private async readThreadData(providerId: string): Promise<Json | undefined> {
    try { return await this.mail.json(`users/me/threads/${encodeURIComponent(providerId)}?format=full`); }
    catch (error) {
      if (error instanceof ProviderError && error.status === 404) return undefined;
      throw error;
    }
  }
  private threadFailure(reason: string): Error {
    return new Error(`${reason} Capture the exact Gmail conversation again before saving a native draft.`);
  }
  private candidate(account: Account, data: Json): { data: Json; message: Message; isDraft: boolean } {
    return { data, message: this.directMessage(account, data), isDraft: strings(data.labelIds).includes("DRAFT") };
  }
  private sameBrowserContext(message: Message, browser: Message): boolean {
    const sender = emailAddress(browser.sender);
    const subject = normalizeSubject(browser.subject);
    return (!sender || emailAddress(message.sender) === sender) && (!subject || normalizeSubject(message.subject) === subject);
  }
  private citation(prefix: string, message: Message, location: string): Citation {
    return { id: `${prefix}:${message.providerId}`, messageId: prefix, title: message.subject || "Gmail message",
      excerpt: message.body.slice(0, 6000), location };
  }
  private citations(browser: Message, target: Message, threadCandidates: Array<{ message: Message; isDraft: boolean }>): Citation[] {
    const recent = threadCandidates.filter(candidate => !candidate.isDraft && candidate.message.providerId !== target.providerId)
      .sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt)).slice(0, 5);
    return [
      this.citation(browser.id, target, `Matched reply target · ${target.sender || "Unknown sender"} · ${target.receivedAt}`),
      ...recent.map(candidate => this.citation(browser.id, candidate.message, `Same Gmail thread context · ${candidate.message.sender || "Unknown sender"} · ${candidate.message.receivedAt}`))
    ];
  }
  async resolveBrowserThread(account: Account, browser: Message): Promise<BrowserThreadResolution> {
    if (!browser.browser) throw new Error("This message was not captured from the browser.");
    if (account.provider !== "gmail" || account.connection === "browser" || normalizeEmail(account.email) !== normalizeEmail(this.vault.get<Account>("accounts", browser.accountId)?.email ?? ""))
      throw new Error("Connect the same Gmail address through the official Gmail API to verify and save native drafts.");
    const directMessageId = browserMessageHint(browser);
    const directThreadId = browserThreadHint(browser.accountId, browser) ?? browserThreadHint(account.id, browser);
    if (browser.browser.completeness === "full" && !directMessageId)
      throw this.threadFailure("The expanded capture has no usable exact Gmail message identifier.");
    if (!directMessageId && !directThreadId)
      throw this.threadFailure("Relay Desk could not find a trusted Gmail message or thread identifier in this browser capture.");
    let thread: Json | undefined;
    let targetCandidate: { data: Json; message: Message; isDraft: boolean } | undefined;
    if (directMessageId) {
      const data = await this.readMessageData(directMessageId);
      if (!data) throw this.threadFailure("The captured Gmail message identifier is unavailable in the authorized mailbox.");
      if (required(data.id) !== directMessageId) throw this.threadFailure("Gmail returned a different message identifier.");
      targetCandidate = this.candidate(account, data);
      if (targetCandidate.isDraft) throw this.threadFailure("The captured Gmail message identifier points to a draft, not a received reply target.");
      if (directThreadId && required(data.threadId) !== directThreadId)
        throw this.threadFailure("The captured Gmail message and thread identifiers do not match.");
      if (!this.sameBrowserContext(targetCandidate.message, browser))
        throw this.threadFailure("The captured Gmail message identifier resolved to a different sender or subject than the browser capture.");
      thread = await this.readThreadData(required(data.threadId));
      if (!thread) throw this.threadFailure("The captured Gmail thread is unavailable in the authorized mailbox.");
    } else {
      thread = await this.readThreadData(required(directThreadId));
      if (!thread) throw this.threadFailure("The captured Gmail thread identifier is unavailable in the authorized mailbox.");
    }
    if (required(thread.id) !== (targetCandidate ? required(targetCandidate.data.threadId) : directThreadId))
      throw this.threadFailure("The captured Gmail thread identifier resolved to a different native Gmail thread.");
    const candidates = list(thread.messages).map(item => this.candidate(account, item));
    if (!candidates.length) throw this.threadFailure("The captured Gmail thread contains no readable messages.");
    if (!targetCandidate) {
      const matches = candidates.filter(candidate => !candidate.isDraft && this.sameBrowserContext(candidate.message, browser))
        .sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt));
      targetCandidate = matches[0];
      if (!targetCandidate)
        throw this.threadFailure("No received Gmail message in the captured thread matches the browser sender and subject.");
    }
    return {
      message: targetCandidate.message,
      citations: this.citations(browser, targetCandidate.message, candidates),
      threadProviderId: required(thread.id),
      threadRevision: gmailThreadRevision(thread)
    };
  }
  private async getMessage(account: Account, selected: Source, providerId: string, historical: boolean, signal?: AbortSignal) {
    let data: Json;
    try {
      data = await this.mail.json(`users/me/messages/${encodeURIComponent(providerId)}?format=full`, { signal });
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return undefined;
      throw error;
    }
    if (required(data.id) !== providerId) throw new Error("Gmail returned a different message identifier");
    if (!strings(data.labelIds).includes(selected.providerId)) return undefined;
    await this.hydrateMime(providerId, optionalObject(data.payload), () => signal?.throwIfAborted(), signal);
    return gmailMessage(account, selected, data, historical);
  }
  private async syncCalendar(account: Account, selected: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    const checkpointId = id(account.id, "checkpoint", selected.id);
    const cursor = this.vault.get<CalendarCursor>("checkpoints", checkpointId) ?? {};
    let next = cursor.pageToken;
    const seen = new Set(cursor.seenIds ?? []);
    const fullRefresh = !cursor.syncToken;
    const canReconcile = fullRefresh && (!cursor.pageToken || Array.isArray(cursor.seenIds));
    try {
      do {
        const page = await this.calendar.json(query(`calendars/${encodeURIComponent(selected.providerId)}/events`,
          { maxResults: "250", singleEvents: "true", showDeleted: "true", syncToken: cursor.syncToken, pageToken: next }), { signal });
        const events = list(page.items).map(value => {
          const event = googleEvent(account, selected, value);
          const existing = this.vault.get<CalendarEvent>("events", event.id);
          return value.status === "cancelled" && existing ? cancelledEvent(existing, event.revision) : event;
        });
        if (fullRefresh) for (const event of events) seen.add(event.id);
        next = text(page.nextPageToken) || undefined;
        if (!next && canReconcile) {
          for (const existing of this.vault.all<CalendarEvent>("events")) {
            if (existing.accountId === account.id && existing.sourceId === selected.id && !seen.has(existing.id)) {
              events.push(cancelledEvent(existing));
            }
          }
        }
        await onPage({ ...emptyPage(), events,
          checkpoint: { id: checkpointId, value: next ? { ...cursor, pageToken: next, ...(fullRefresh ? { seenIds: [...seen] } : {}) } : { syncToken: required(page.nextSyncToken) } } });
      } while (next);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 410) throw error;
      await onPage(emptyPage({ id: checkpointId, value: {} }));
      throw new Error("Google calendar cursor expired; retry sync for a complete refresh");
    }
  }
  async saveDraft(account: Account, message: Message, draft: Draft): Promise<{ providerId: string; providerRevision: string }> {
    const original = await this.mail.json(`users/me/messages/${encodeURIComponent(message.providerId)}?format=full`);
    const target = draft.nativeTarget?.provider === "gmail" ? draft.nativeTarget : undefined;
    if (target) {
      if (target.messageProviderId !== message.providerId || target.messageRevision !== text(original.historyId) || text(original.threadId) !== target.threadProviderId)
        throw new ConflictError();
      const thread = await this.readThreadData(target.threadProviderId);
      if (!target.threadRevision || !thread || gmailThreadRevision(thread) !== target.threadRevision ||
        required(thread.id) !== target.threadProviderId) throw new ConflictError();
    }
    if (text(original.historyId) !== draft.sourceRevision) throw new ConflictError();
    const payload = optionalObject(original.payload);
    if ([draft.subject, ...draft.recipients, header(payload, "Message-ID"), header(payload, "References")].some(value => /[\r\n]/.test(value))) {
      throw new Error("Invalid MIME header");
    }
    const messageId = header(payload, "Message-ID");
    const references = `${header(payload, "References")} ${messageId}`.trim();
    const raw = Buffer.from([`To: ${draft.recipients.join(", ")}`, `Subject: =?UTF-8?B?${Buffer.from(draft.subject).toString("base64")}?=`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${references}`] : []), "",
      Buffer.from(draft.body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""].join("\r\n")).toString("base64url");
    const body = { message: { raw, threadId: required(original.threadId) } };
    let providerId: string;
    if (draft.providerId) {
      const remote = await this.mail.json(`users/me/drafts/${encodeURIComponent(draft.providerId)}?format=full`);
      if (!draft.providerRevision || revision(remote) !== draft.providerRevision ||
        text(optionalObject(remote.message).threadId) !== text(original.threadId)) throw new ConflictError();
      // Gmail drafts do not expose a documented conditional-update precondition.
      // The full native draft snapshot is compared immediately before the update.
      const result = await this.mail.write(`users/me/drafts/${encodeURIComponent(draft.providerId)}`, "PUT", { id: draft.providerId, ...body });
      providerId = required(result.id);
    } else {
      providerId = required((await this.mail.write("users/me/drafts", "POST", body)).id);
    }
    try {
      const saved = await this.mail.json(`users/me/drafts/${encodeURIComponent(providerId)}?format=full`);
      return { providerId, providerRevision: revision(saved) };
    } catch { throw new UncertainWriteError(); }
  }
  async downloadAttachment(attachment: Attachment, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const reference = object(JSON.parse(attachment.providerId));
    const data = await this.mail.json(`users/me/messages/${encodeURIComponent(required(reference.messageId))}/attachments/${encodeURIComponent(required(reference.attachmentId))}`, { signal });
    const buffer = Buffer.from(required(data.data), "base64url");
    return new ReadableStream({ start(controller) { controller.enqueue(buffer); controller.close(); } });
  }
  async writeEvent(account: Account, selected: Source, change: EventChange, operationId: string): Promise<CalendarEvent> {
    validateChange(change);
    const path = `calendars/${encodeURIComponent(selected.providerId)}/events`;
    const body = eventBody("gmail", change);
    let result: Json;
    if (change.eventId) {
      const existing = this.vault.get<CalendarEvent>("events", change.eventId);
      if (!existing || existing.sourceId !== selected.id) throw new Error("Unknown event");
      const remote = await this.calendar.json(`${path}/${encodeURIComponent(existing.providerId)}`);
      if (remote.recurringEventId || Array.isArray(remote.recurrence)) throw new Error("Recurring event edits are not supported; use Google Calendar");
      if (!change.expectedRevision || revision(remote) !== change.expectedRevision || remote.status === "cancelled") throw new ConflictError();
      result = await this.calendar.write(`${path}/${encodeURIComponent(existing.providerId)}?sendUpdates=all`, "PATCH", body, change.expectedRevision);
    } else {
      // Google accepts base32hex IDs; a SHA-256 hex digest is a valid deterministic subset.
      result = await this.calendar.write(`${path}?sendUpdates=all`, "POST", { ...body, id: hash(`${account.id}:${operationId}`) });
    }
    return googleEvent(account, selected, result);
  }
}
