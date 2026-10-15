import type { Account, Attachment, Collection, Message, MessageThread, Source } from "../../shared/contracts";
import type { BrowserCapture } from "../../shared/browser";
import { mailOriginAllowed } from "../../shared/mail-transport";

export interface MailVault {
  get<T>(collection: Collection, id: string): T | undefined;
  all<T>(collection: Collection): T[];
  put<T>(collection: Collection, id: string, value: T): void;
}
interface ReadBridge {
  cacheIdentity?(accountId: string): string;
  readMailThread(input: { accountId: string; accountEmail: string; threadId: string; messageProviderId?: string },
    beforeRead: () => void, signal?: AbortSignal): Promise<BrowserCapture>;
}
interface CachedThread {
  accountId: string;
  sourceId: string;
  threadId: string;
  messageIds: string[];
  revisions: Record<string, string>;
  loadedAt: string;
  transportIdentity?: string;
}

export class BrowserMailReader {
  private pending = new Map<string, Promise<MessageThread>>();
  private foregroundReads = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private serialCount = 0;
  get backgroundAvailable(): boolean { return this.foregroundReads === 0 && this.pending.size === 0 && this.serialCount === 0; }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const idle = this.serialCount === 0;
    this.serialCount++;
    const result = idle ? work() : this.serial.then(work, work);
    this.serial = result.catch(() => {});
    try { return await result; }
    finally { this.serialCount--; }
  }

  hasCachedThread(message: Message, members?: Message[]): boolean {
    const latest = this.vault.get<Message>("messages", message.id);
    if (!latest || !this.localMessageAllowed(latest) || !this.localMessageAllowed(message)) return false;
    const record = this.vault.get<CachedThread>("checkpoints", `browser-mail:${message.threadId}`);
    if (!record || record.accountId !== message.accountId || record.sourceId !== message.sourceId
      || record.transportIdentity !== this.bridge.cacheIdentity?.(message.accountId)
      || record.threadId !== message.threadId || !Array.isArray(record.messageIds) || !record.messageIds.length
      || !record.revisions || !record.loadedAt || !Number.isFinite(Date.parse(record.loadedAt))
      || new Set(record.messageIds).size !== record.messageIds.length) return false;
    const current = members ?? this.vault.all<Message>("messages").filter(item =>
      item.accountId === message.accountId && item.sourceId === message.sourceId && item.threadId === message.threadId && !item.deleted);
    return current.every(item => this.localMessageAllowed(item) && record.revisions[item.id] === item.revision)
      && record.messageIds.every(id => {
        const item = this.vault.get<Message>("messages", id);
        return !!item && this.localMessageAllowed(item) && item.accountId === message.accountId && item.sourceId === message.sourceId
          && item.threadId === message.threadId && item.browser?.completeness === "full"
          && record.revisions[id] === item.revision;
      });
  }

  constructor(private vault: MailVault, private bridge: ReadBridge,
    private capture: (input: BrowserCapture, beforeCapture?: () => void) => Promise<unknown>,
    private maintenance: () => boolean, private paused: () => boolean, private permissionRevision: () => number) {}

  private localMessageAllowed(message: Message): boolean {
    const account = this.vault.get<Account>("accounts", message.accountId);
    const source = this.vault.get<Source>("sources", message.sourceId);
    return !message.deleted && !!account?.consent && account.status === "connected"
      && !!source?.selected && source.accountId === account.id && source.kind === "mail"
      && mailOriginAllowed(this.vault, message);
  }

  async load(messageId: string, refresh = false, options: { background?: boolean; beforeRead?: () => void; signal?: AbortSignal } = {}): Promise<MessageThread> {
    if (!options.background) this.foregroundReads++;
    try { return await this.read(messageId, refresh, options.beforeRead, options.signal); }
    finally { if (!options.background) this.foregroundReads--; }
  }

  private async read(messageId: string, refresh: boolean, beforeRead?: () => void, signal?: AbortSignal): Promise<MessageThread> {
    const message = this.vault.get<Message>("messages", messageId);
    if (!message || !message.browser) throw new Error("This browser email is not in the local archive.");
    const epoch = this.permissionRevision();
    const transportIdentity = this.bridge.cacheIdentity?.(message.accountId);
    const validate = () => {
      signal?.throwIfAborted();
      const current = this.vault.get<Message>("messages", messageId);
      const account = this.vault.get<Account>("accounts", message.accountId);
      const source = this.vault.get<Source>("sources", message.sourceId);
      if (this.maintenance() || epoch !== this.permissionRevision() || !current || current.deleted
        || transportIdentity !== this.bridge.cacheIdentity?.(message.accountId)
        || current.accountId !== message.accountId || current.sourceId !== message.sourceId || current.threadId !== message.threadId
        || current.providerId !== message.providerId
        || !mailOriginAllowed(this.vault, message) || !mailOriginAllowed(this.vault, current)
        || !account?.consent || account.status !== "connected" || account.provider !== "gmail" || account.connection !== "browser"
        || !source?.selected || source.accountId !== account.id || source.kind !== "mail")
        throw new Error("Full email access was revoked or changed. Select a connected Gmail inbox with local access enabled.");
      return account;
    };
    const account = validate();
    const prefix = `${account.id}:thread:`;
    if (!message.threadId.startsWith(prefix)) throw new Error("The captured Gmail thread identity is invalid. Refresh this inbox.");
    let threadId: string;
    try { threadId = decodeURIComponent(message.threadId.slice(prefix.length)); }
    catch { throw new Error("The captured Gmail thread identity is invalid. Refresh this inbox."); }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(threadId)) throw new Error("The captured Gmail thread identity is invalid. Refresh this inbox.");
    const key = `browser-mail:${message.threadId}`;
    const cached = this.vault.get<CachedThread>("checkpoints", key);
    const currentThread = () => this.vault.all<Message>("messages").filter(item =>
      item.accountId === message.accountId && item.sourceId === message.sourceId && item.threadId === message.threadId && !item.deleted);
    const response = (record: CachedThread, cached: boolean): MessageThread => {
      validate();
      const messages = record.messageIds.map(id => this.vault.get<Message>("messages", id)).filter((item): item is Message =>
        !!item && this.localMessageAllowed(item) && item.accountId === account.id && item.sourceId === message.sourceId
        && item.threadId === message.threadId && item.browser?.completeness === "full"
        && record.revisions[item.id] === item.revision);
      if (!messages.length || messages.length !== record.messageIds.length) throw new Error("Full email cache is incomplete. Reload this conversation.");
      const byId = new Map(messages.map(item => [item.id, item]));
      return { accountId: account.id, sourceId: message.sourceId, threadId: message.threadId, messages,
        attachments: this.vault.all<Attachment>("attachments").filter(item => {
          const owner = byId.get(item.messageId);
          return item.accountId === account.id && !!owner
            && mailOriginAllowed(this.vault, { ...owner, gmailApi: item.gmailApi });
        }),
        loadedAt: record.loadedAt, cached };
    };
    if (!refresh && cached?.accountId === account.id && cached.sourceId === message.sourceId && cached.threadId === message.threadId
      && cached.transportIdentity === transportIdentity
      && currentThread().every(item => cached.revisions[item.id] === item.revision)) {
      return response(cached, true);
    }
    const existing = this.pending.get(key);
    if (existing) {
      const result = await existing;
      validate();
      return response({ accountId: result.accountId, sourceId: result.sourceId, threadId: result.threadId,
        messageIds: result.messages.map(item => item.id),
        revisions: Object.fromEntries(result.messages.map(item => [item.id, item.revision])),
        loadedAt: result.loadedAt, transportIdentity }, result.cached);
    }
    if (this.paused()) throw new Error("Browser refresh is paused. Resume it to load this full email; cached content remains available.");
    if (this.pending.size >= 3) throw new Error("Three emails are already loading. Wait for one to finish, then retry.");
    const guard = () => {
      beforeRead?.();
      validate();
      if (this.paused()) throw new Error("Browser refresh was paused before the full email finished loading.");
    };
    const work = this.exclusive(async () => {
      guard();
      const previewRevisions = Object.fromEntries(currentThread().filter(item => item.browser?.completeness === "preview")
        .map(item => [item.id, item.revision]));
      const request = { accountId: account.id, accountEmail: account.email, threadId,
        ...(message.providerId.startsWith("thread:") ? {} : { messageProviderId: message.providerId }) };
      const input = await (signal ? this.bridge.readMailThread(request, guard, signal) : this.bridge.readMailThread(request, guard));
      guard();
      if (input.kind !== "mail" || input.accountEmail.trim().toLowerCase() !== account.email.trim().toLowerCase()
        || input.meetings.length || !input.messages.length || input.messages.some(item =>
          item.threadId !== threadId || item.completeness !== "full") || new Set(input.messages.map(item => item.id)).size !== input.messages.length)
        throw new Error("The browser returned a different or incomplete conversation. No full email was accepted.");
      await this.capture(input, guard);
      guard();
      const record: CachedThread = { accountId: account.id, sourceId: message.sourceId, threadId: message.threadId,
        transportIdentity,
        messageIds: input.messages.map(item => `${account.id}:message:${encodeURIComponent(item.id)}`),
        revisions: { ...Object.fromEntries(currentThread().filter(item => item.browser?.completeness !== "preview")
          .map(item => [item.id, item.revision])), ...previewRevisions }, loadedAt: new Date().toISOString() };
      const result = response(record, false);
      this.vault.put("checkpoints", key, record);
      return result;
    });
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
}
