import type { Account, Attachment, CalendarEvent, Citation, Draft, EventChange, Message, Provider, Settings, Source } from "../../shared/contracts";
import type { BrowserCapture } from "../../shared/browser";
import { TokenStore, login, type Credential } from "../auth/oauth";
import { assertAccount, ConflictError, ensureSelected, hash, HttpClient, id, object, ProviderError, required, text, UncertainWriteError,
  type Fetch, type OnPage, type Page, type Vault } from "./core";
import { GmailConnector, GMAIL_BASE, GOOGLE_CALENDAR_BASE, type BrowserThreadResolution, type GmailMailInput } from "./gmail";
import { GmailRelayConnector, GMAIL_RELAY_PROVIDER_ID, type GmailRelaySecret, type GmailRelayPublicStatus } from "./gmail-relay";
import { MicrosoftConnector, GRAPH_BASE } from "./microsoft";
import { SlackConnector, SLACK_BASE } from "./slack";
export type { Vault, Page, OnPage, Fetch } from "./core";

interface ConnectorOptions {
  fetch?: Fetch;
  login?: typeof login;
}
interface SaveDraftOptions { browserMessageId?: string }
export class ConnectorHub {
  private readonly tokens: TokenStore;
  private readonly fetcher: Fetch;
  private readonly login: typeof login;
  private readonly relay: GmailRelayConnector;
  constructor(private readonly vault: Vault, private readonly openExternal: (url: string) => Promise<void>, options: ConnectorOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.login = options.login ?? login;
    this.tokens = new TokenStore(vault, this.fetcher);
    this.relay = new GmailRelayConnector(vault, this.fetcher);
  }
  private client(accountId: string, base: string, credential?: Credential): HttpClient {
    return new HttpClient(base, credential ? async () => credential.accessToken : () => this.tokens.access(accountId), this.fetcher,
      undefined, base === GRAPH_BASE ? { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="UTC"' } : {});
  }
  private connector(account: Account) {
    if (account.provider === "whatsapp") throw new Error("WhatsApp is browser-only. Use the paired WhatsApp Web companion; replies remain local.");
    if (account.provider === "gmail") return new GmailConnector(this.client(account.id, GMAIL_BASE), this.client(account.id, GOOGLE_CALENDAR_BASE), this.vault);
    if (account.provider === "microsoft") return new MicrosoftConnector(this.client(account.id, GRAPH_BASE), this.vault);
    return new SlackConnector(this.client(account.id, SLACK_BASE), this.vault);
  }
  async connect(provider: Provider, settings: Settings, token?: string): Promise<{ account: Account; sources: Source[] }> {
    if (provider === "whatsapp") throw new Error("Connect WhatsApp Web through the browser companion, not API credentials.");
    let credential: Credential;
    let identity: { id: string; name: string; email: string };
    if (provider === "slack") {
      if (!token?.trim().startsWith("xoxp-")) throw new Error("Import an authorized Slack xoxp user token from your internal app installation");
      credential = { accessToken: token.trim(), expiresAt: Number.MAX_SAFE_INTEGER, scopes: [] };
      const data = await new SlackConnector(this.client("", SLACK_BASE, credential), this.vault).identity();
      identity = { ...data, email: "" };
    } else {
      // token is a transient Google native desktop registration secret, if Google
      // requires it. It goes only to the official token endpoint and encrypted vault.
      credential = await this.login(provider, settings, this.openExternal, this.fetcher, provider === "gmail" ? token : undefined);
      if (provider === "gmail") {
        const data = await this.client("", GMAIL_BASE, credential).json("users/me/profile");
        identity = { id: required(data.emailAddress).toLowerCase(), email: required(data.emailAddress), name: required(data.emailAddress) };
      } else {
        const data = await this.client("", GRAPH_BASE, credential).json("me?$select=id,displayName,mail,userPrincipalName");
        identity = { id: required(data.id), email: text(data.mail) || text(data.userPrincipalName), name: text(data.displayName) || required(data.id) };
      }
    }
    const account: Account = { id: `${provider}:${identity.id}`, provider, name: identity.name, email: identity.email,
      status: "connected", aiEnabled: false, consent: false };
    const secretId = `provider:${account.id}`;
    const previous = this.vault.get<Credential>("secrets", secretId);
    this.vault.put("secrets", secretId, { ...credential, accountId: account.id });
    try { return { account, sources: await this.connector(account).discover(account) }; }
    catch (error) {
      if (previous) this.vault.put("secrets", secretId, { ...previous, accountId: account.id }); else this.vault.delete("secrets", secretId);
      throw error;
    }
  }
  async sync(account: Account, sources: Source[], onPage: OnPage, signal?: AbortSignal): Promise<void> {
    assertAccount(account);
    const adapter = this.connector(account);
    for (const selected of sources) {
      signal?.throwIfAborted();
      if (selected.accountId !== account.id) throw new Error("Cross-account source rejected");
      if (!selected.selected) continue;
      const sync = selected.providerId === GMAIL_RELAY_PROVIDER_ID && account.provider === "gmail"
        ? this.relay.sync(account, selected, async page => onPage(page), signal)
        : adapter.sync(account, selected, async page => {
        signal?.throwIfAborted();
        await onPage(page.checkpoint ? { ...page, checkpoint: { ...page.checkpoint,
          value: { ...object(page.checkpoint.value), accountId: account.id } } } : page);
      }, signal);
      await sync;
    }
  }
  relayStatuses(): GmailRelayPublicStatus[] { return this.relay.publicStatuses(); }
  async testGmailRelay(url: string, token: string, signal?: AbortSignal) {
    return this.relay.status({ url, token, mailbox: "placeholder@example.com", pollIntervalMinutes: 5 }, signal);
  }
  configureGmailRelay(secret: GmailRelaySecret, sourceId: string): void {
    this.vault.put("secrets", this.relay.secretId(sourceId), secret);
  }
  removeGmailRelay(sourceId: string): void {
    this.vault.delete("secrets", this.relay.secretId(sourceId));
    this.vault.delete("checkpoints", this.relay.stateId(sourceId));
  }
  async resolveBrowserThread(account: Account, message: Message): Promise<BrowserThreadResolution> {
    assertAccount(account);
    const adapter = this.connector(account);
    if (!(adapter instanceof GmailConnector)) throw new Error("Browser-linked native drafts are available only for Gmail accounts.");
    return adapter.resolveBrowserThread(account, message);
  }
  hasGmailReadConfiguration(account: Account): boolean {
    if (account.provider !== "gmail" || account.connection === "browser") return false;
    const credential = this.vault.get<Credential>("secrets", `provider:${account.id}`);
    return !!credential && (!credential.accountId || credential.accountId === account.id) &&
      !!(credential.accessToken?.trim() || credential.refreshToken?.trim()) &&
      Array.isArray(credential.scopes) && credential.scopes.some(scope =>
        ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"].includes(scope));
  }
  private gmailReadGuard(account: Account, selected: Source, email: string, beforeRead: () => void, signal?: AbortSignal,
    inboxOnly = true): () => void {
    return () => {
      signal?.throwIfAborted();
      beforeRead();
      const current = this.vault.get<Account>("accounts", account.id);
      if (!current || current.id !== account.id || current.provider !== "gmail" || current.connection === "browser" ||
        current.status !== "connected" || !current.consent || account.provider !== "gmail" ||
        account.connection === "browser" || account.status !== "connected" || !account.consent ||
        current.email.trim().toLowerCase() !== email.trim().toLowerCase() ||
        account.email.trim().toLowerCase() !== email.trim().toLowerCase() || !this.hasGmailReadConfiguration(current))
        throw new Error("Gmail API account authorization or read configuration is unavailable");
      const stored = ensureSelected(this.vault, current, selected.id);
      if (selected.accountId !== current.id || !selected.selected || selected.kind !== "mail" || !selected.providerId ||
        inboxOnly && selected.providerId !== "INBOX" ||
        stored.id !== selected.id || stored.kind !== "mail" || stored.providerId !== selected.providerId)
        throw new Error("Gmail selected mail source boundary rejected");
    };
  }
  private guardedGmail(account: Account, guard: () => void): GmailConnector {
    const fetcher: Fetch = async (input, init) => {
      guard();
      const result = await this.fetcher(input, init);
      try { guard(); } catch (error) { await result.body?.cancel(); throw error; }
      return result;
    };
    const token = async () => { guard(); const value = await this.tokens.access(account.id); guard(); return value; };
    return new GmailConnector(new HttpClient(GMAIL_BASE, token, fetcher), new HttpClient(GOOGLE_CALENDAR_BASE, token, fetcher), this.vault);
  }
  async readGmailMail(account: Account, selected: Source, input: GmailMailInput, beforeRead: () => void, signal?: AbortSignal): Promise<BrowserCapture> {
    const controller = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const validate = this.gmailReadGuard(account, selected, input.accountEmail, () => {
      beforeRead();
      const owner = this.vault.get<Account>("accounts", input.accountId);
      if (!owner || owner.id !== input.accountId || owner.provider !== "gmail" || !owner.consent ||
        owner.status !== "connected" || owner.email.trim().toLowerCase() !== input.accountEmail.trim().toLowerCase() ||
        (input.accountId === account.id ? owner.connection === "browser" : owner.connection !== "browser"))
        throw new Error("Gmail mailbox owner authorization rejected");
    }, readSignal, !!input.inboxRefresh);
    const guard = () => { try { validate(); } catch (error) { controller.abort(error); throw error; } };
    guard();
    return this.guardedGmail(account, guard).readMail(account, selected, input, guard, readSignal);
  }
  async readGmailThreadPage(account: Account, selected: Source, providerMessageId: string, beforeRead: () => void,
    signal?: AbortSignal): Promise<Page> {
    const controller = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const validate = this.gmailReadGuard(account, selected, account.email, beforeRead, readSignal, false);
    const guard = () => { try { validate(); } catch (error) { controller.abort(error); throw error; } };
    guard();
    return this.guardedGmail(account, guard).readThreadPage(account, selected, providerMessageId, guard, readSignal);
  }
  async downloadLinkedGmailAttachment(browserAccount: Account, attachment: Attachment, apiAccountId: string, apiSourceId: string,
    signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const apiAccount = this.vault.get<Account>("accounts", apiAccountId);
    const apiSource = this.vault.get<Source>("sources", apiSourceId);
    if (!apiAccount || !apiSource) throw new Error("Linked Gmail attachment account or Inbox source is unavailable");
    const checkBrowser = () => {
      const current = this.vault.get<Account>("accounts", browserAccount.id);
      const stored = this.vault.get<Attachment>("attachments", attachment.id);
      const message = this.vault.get<Message>("messages", attachment.messageId);
      if (browserAccount.connection !== "browser" || browserAccount.provider !== "gmail" ||
        browserAccount.status !== "connected" || !browserAccount.consent ||
        current?.id !== browserAccount.id || current.connection !== "browser" || current.provider !== "gmail" || current.status !== "connected" || !current.consent ||
        current.email.trim().toLowerCase() !== browserAccount.email.trim().toLowerCase() ||
        attachment.accountId !== browserAccount.id || !stored || stored.accountId !== browserAccount.id ||
        stored.providerId !== attachment.providerId || stored.messageId !== attachment.messageId || stored.status === "blocked" ||
        stored.name !== attachment.name || stored.mimeType !== attachment.mimeType || stored.size !== attachment.size ||
        attachment.gmailApi?.accountId !== apiAccountId || attachment.gmailApi.sourceId !== apiSourceId ||
        stored.gmailApi?.accountId !== apiAccountId || stored.gmailApi.sourceId !== apiSourceId ||
        !message || message.deleted || !message.browser || message.accountId !== browserAccount.id ||
        message.gmailApi?.accountId !== apiAccountId || message.gmailApi.sourceId !== apiSourceId)
        throw new Error("Linked Gmail attachment provenance or browser authorization rejected");
      const selected = ensureSelected(this.vault, current, message.sourceId);
      if (selected.kind !== "mail") throw new Error("Linked Gmail attachment source boundary rejected");
      const reference = object(JSON.parse(stored.providerId));
      if (reference.messageId !== message.providerId || typeof reference.attachmentId !== "string" || !reference.attachmentId)
        throw new Error("Linked Gmail attachment message boundary rejected");
    };
    const controller = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const validate = this.gmailReadGuard(apiAccount, apiSource, browserAccount.email, checkBrowser, readSignal);
    const guard = () => { try { validate(); } catch (error) { controller.abort(error); throw error; } };
    guard();
    const connector = this.guardedGmail(apiAccount, guard);
    await connector.verifyMailbox(browserAccount.email, guard, readSignal);
    const stream = await connector.downloadAttachment({ ...attachment, accountId: apiAccount.id }, readSignal);
    try { guard(); } catch (error) { await stream.cancel(); throw error; }
    return stream;
  }
  async saveDraft(account: Account, message: Message, draft: Draft, options: SaveDraftOptions = {}): Promise<{ providerId: string; providerRevision: string }> {
    assertAccount(account, message, draft);
    if (options.browserMessageId) {
      const browserMessage = this.vault.get<Message>("messages", options.browserMessageId);
      const browserAccount = browserMessage && this.vault.get<Account>("accounts", browserMessage.accountId);
      const approved = this.vault.get<Draft>("drafts", draft.id);
      const target = approved?.nativeTarget;
      if (!browserMessage?.browser || browserMessage.deleted || browserAccount?.connection !== "browser" ||
        browserAccount.status !== "connected" || !browserAccount.consent || !account.consent || account.provider !== "gmail" ||
        browserAccount.email.trim().toLowerCase() !== account.email.trim().toLowerCase() ||
        approved?.accountId !== browserAccount.id || approved.messageId !== browserMessage.id ||
        approved.sourceRevision !== browserMessage.revision || target?.accountId !== account.id ||
        target.messageProviderId !== message.providerId || target.messageRevision !== message.revision ||
        approved.body !== draft.body || approved.subject !== draft.subject ||
        JSON.stringify(approved.recipients) !== JSON.stringify(draft.recipients))
        throw new Error("Browser draft authorization or reviewed content changed.");
      ensureSelected(this.vault, browserAccount, browserMessage.sourceId);
    } else ensureSelected(this.vault, account, message.sourceId);
    if (draft.messageId !== message.id || draft.sourceRevision !== message.revision || message.deleted) throw new Error("Draft source changed; review the draft");
    if (account.provider === "slack") throw new Error("Slack replies remain local; copy and open the original thread");
    if (draft.status === "uncertain") throw new UncertainWriteError();
    const adapter = this.connector(account);
    if (adapter instanceof SlackConnector) throw new Error("Slack native drafts are not supported");
    return this.writeOnce(account.id, `draft:${draft.id}`, hash(JSON.stringify(draft)), () => adapter.saveDraft(account, message, draft));
  }
  async downloadAttachment(account: Account, attachment: Attachment, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    assertAccount(account, attachment);
    const message = this.vault.get<Message>("messages", attachment.messageId);
    if (!message || message.accountId !== account.id || message.deleted) throw new Error("Attachment source is unavailable");
    ensureSelected(this.vault, account, message.sourceId);
    const stored = this.vault.get<Attachment>("attachments", attachment.id);
    if (!stored || stored.providerId !== attachment.providerId || stored.messageId !== message.id) throw new Error("Attachment provenance rejected");
    if (attachment.status === "blocked") throw new Error("Attachment requires a separately authorized connector");
    if (account.provider === "gmail") {
      try {
        const reference = JSON.parse(attachment.providerId) as { relayFileId?: string };
        if (reference.relayFileId) return this.relay.downloadAttachment(message.sourceId, attachment, signal);
      } catch {
        throw new Error("Attachment provenance rejected");
      }
    }
    if (account.provider !== "slack") {
      const reference: unknown = JSON.parse(attachment.providerId);
      if (!reference || typeof reference !== "object" || !("messageId" in reference) || reference.messageId !== message.providerId) {
        throw new Error("Attachment message boundary rejected");
      }
    }
    return this.connector(account).downloadAttachment(attachment, signal);
  }
  async writeEvent(account: Account, selected: Source, change: EventChange, operationId: string): Promise<CalendarEvent> {
    assertAccount(account, selected, change);
    const stored = ensureSelected(this.vault, account, selected.id);
    if (stored.kind !== "calendar" || stored.providerId !== selected.providerId || change.sourceId !== selected.id) throw new Error("Calendar source boundary rejected");
    if (!operationId.trim()) throw new Error("Calendar writes require an operation ID");
    const adapter = this.connector(account);
    if (adapter instanceof SlackConnector) throw new Error("Slack has no calendar adapter");
    return this.writeOnce(account.id, `event:${operationId}`, hash(JSON.stringify(change)), () => adapter.writeEvent(account, selected, change, operationId), true);
  }
  private async writeOnce<T>(accountId: string, operation: string, fingerprint: string, write: () => Promise<T>, immutable = false): Promise<T> {
    const marker = id(accountId, "write", hash(operation));
    const previous = this.vault.get<{ state: string; fingerprint: string; result?: T }>("secrets", marker);
    if (previous?.state === "done" && previous.result !== undefined) {
      if (previous.fingerprint === fingerprint) return previous.result;
      if (immutable) throw new Error("Operation ID was already used for a different calendar change");
    } else if (previous) throw new UncertainWriteError();
    this.vault.put("secrets", marker, { accountId, state: "pending", fingerprint });
    try {
      const result = await write();
      this.vault.put("secrets", marker, { accountId, state: "done", fingerprint, result });
      return result;
    } catch (error) {
      // Read-side validation errors cannot have mutated the provider. Other failures
      // conservatively retain a durable marker, including a crash after a write.
      if (error instanceof ConflictError || error instanceof ProviderError && error.status < 500 ||
        error instanceof Error && /source|recurr|Unknown event|Calendar title|time zone|date-time|All-day|Event end|attendee|MIME/.test(error.message)) {
        this.vault.delete("secrets", marker);
      }
      throw error;
    }
  }
  async disconnect(accountId: string): Promise<void> {
    this.vault.delete("secrets", `provider:${accountId}`);
  }
}
