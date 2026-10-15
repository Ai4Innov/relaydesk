import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Account, ActionItem, Approval, Attachment, CalendarEvent, Citation, Command, CommandResult, Draft, Job, Message, Settings, Snapshot, Source } from "../shared/contracts";
import { defaultSettings } from "../shared/defaults";
import { Vault } from "./storage/vault";
import { Retrieval } from "./retrieval";
import { ConnectorHub } from "./connectors";
import { GMAIL_RELAY_PROVIDER_ID } from "./connectors/gmail-relay";
import { AttachmentProcessor } from "./attachments";
import { browserAttachmentGuard, importBrowserAttachment, processRetainedBrowserAttachment } from "./attachments/browser-import";
import { attachmentViewGuard, saveAttachment, viewAttachment } from "./attachments/viewing";
import { CopilotAdapter } from "./copilot";
import { proposeChange, validateApproval } from "./approvals";
import { BrowserArchive, browserAccountId } from "./browser/archive";
import { BrowserBridge } from "./browser/bridge";
import { BrowserMailReader } from "./browser/mail-reader";
import { BrowserMailArchiveQueue } from "./browser/mail-archive-queue";
import { MailFreshness } from "./browser/mail-freshness";
import { GmailMailTransport } from "./browser/mail-transport";
import { PlaywrightMailBrowser, PlaywrightMailError } from "./browser/playwright-mail";
import { mailOriginAllowed } from "../shared/mail-transport";
import type { MailFreshnessRequest, MailFreshnessResult } from "../shared/mail-freshness";
import { BrowserAttachmentDownloads } from "./browser/attachment-download";
import type { BrowserCalendarItem, BrowserCapture } from "../shared/browser";
import { parseBrowserAccountLink } from "../shared/browser-account-link";
import { ProductivityService } from "./productivity";
import { ChatService } from "./chat";
import { safeError } from "./errors";
import { normalizeEmail, now, type CommandContext } from "./commands/context";
import { accountCommand } from "./commands/accounts";
import { gmailRelayCommand } from "./commands/gmail-relay";
import { moveBrowserCalendarEvent } from "./commands/browser-calendar";

interface Host {
  changed(): void;
  openExternal(url: string): Promise<void>;
  copy(text: string): void;
  loginCopilot(): Promise<void>;
  backupPath(): Promise<string | undefined>;
  restorePath(): Promise<string | undefined>;
  importAttachmentPath?(): Promise<string | undefined>;
  downloadsDirectory?: string;
  saveAttachmentPath?(name: string): Promise<string | undefined>;
  settingsChanged(settings: Settings): void;
  notify(title: string, body: string): void;
  browserExtensionId?: string;
  browserExtensionDirectory?: string;
  playwrightProfileDirectory?: string;
  openBrowserExtension?(): Promise<void>;
  documentsDirectory?: string;
  openPath?(path: string, reveal: boolean): Promise<void>;
  chooseFolder?(title: string, defaultPath: string): Promise<string | undefined>;
}
interface BrowserDraftContext {
  account: Account;
  message: Message;
  target: NonNullable<Draft["nativeTarget"]>;
  citations: Citation[];
}
export { safeError };
export class RelayService {
  readonly retrieval: Retrieval;
  readonly connectors: ConnectorHub;
  readonly copilot: CopilotAdapter;
  readonly attachments: AttachmentProcessor;
  readonly productivity: ProductivityService;
  readonly chat: ChatService;
  private controllers = new Map<string, AbortController>();
  private activeJobs = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private lastScheduledRefresh = Date.now();
  private aiBusy = false;
  private attachmentBusy = false;
  private attachmentController?: { accountId: string; linkedAccountId?: string; controller: AbortController };
  private stopped = false;
  private restoring = false;
  private browser?: BrowserBridge;
  private mailReader?: BrowserMailReader;
  private mailTransport?: GmailMailTransport;
  private playwrightMail?: PlaywrightMailBrowser;
  private mailArchive: BrowserMailArchiveQueue;
  private browserDownloads: BrowserAttachmentDownloads;
  private browserCaptures = 0;
  private browserCaptureTail: Promise<void> = Promise.resolve();
  private browserAiBusy = false;
  private documentAccessRevision = 0;
  private documentSaving = false;
  private freshness!: MailFreshness;
  private freshnessActive = false;
  private lastRelayPoll = new Map<string, number>();

  constructor(readonly vault: Vault, directory: string, private host: Host) {
    this.retrieval = new Retrieval(vault, join(directory, "models"));
    this.connectors = new ConnectorHub(vault, host.openExternal);
    this.copilot = new CopilotAdapter(join(directory, "copilot-workspace"), host.changed);
    this.attachments = new AttachmentProcessor(
      vault, this.retrieval,
      (attachment, signal) => {
        const account = this.account(attachment.accountId);
        if (attachment.browser || account.connection === "browser")
          throw new Error("Browser attachment bytes require an authorized native browser download or an imported copy, never API credentials.");
        return this.connectors.downloadAttachment(account, attachment, signal);
      },
      { modelDirectory: join(directory, "models"), thresholdMb: () => this.settings().attachmentThresholdMb }
    );
    this.productivity = new ProductivityService(vault, {
      changed: host.changed,
      canReview: () => {
        if (this.stopped || this.restoring) throw new Error("Archive maintenance or shutdown is in progress.");
        if (this.settings().syncPaused) throw new Error("Automation is paused. Resume it before starting another archive review batch.");
      },
      generate: async (prompt, citations) => {
        const model = this.settings().model;
        if (!model) throw new Error("Connect Copilot and choose a model in Settings.");
        const revisions = citations.map(citation => {
          const message = this.message(citation.messageId);
          this.requireMessageAi(message);
          if (!this.citationAllowedForAi(citation)) throw new Error("Report attachment evidence is not permitted for AI.");
          return { id: message.id, revision: message.revision };
        });
        return this.runAi(async () => {
          const result = await this.copilot.generate(prompt, citations, model);
          for (const revision of revisions) {
            const message = this.message(revision.id);
            this.requireMessageAi(message);
            if (message.revision !== revision.revision) throw new Error("Report evidence changed. Refresh and generate the report again.");
          }
          if (!citations.every(citation => this.citationAllowedForAi(citation)))
            throw new Error("Report evidence permissions changed during generation.");
          return result;
        });
      },
      schedule: async (change, beforeWrite) => {
        beforeWrite?.();
        const account = this.account(change.accountId);
        const source = this.vault.get<Source>("sources", change.sourceId);
        if (!source || source.accountId !== account.id || source.kind !== "calendar" || account.demo || account.connection === "browser")
          throw new Error("Choose an authorized API calendar for task scheduling.");
        if (change.attendees.length) throw new Error("Task scheduling only creates private events without attendees.");
        if (!source.selected) await this.command({ type: "source.select", sourceId: source.id, selected: true });
        const proposed = await this.command({ type: "calendar.propose", change });
        const approval = proposed.approvalId ? this.vault.get<Approval>("approvals", proposed.approvalId) : undefined;
        if (!approval) throw new Error("The calendar proposal could not be prepared.");
        const result = await this.command({ type: "calendar.approve", approvalId: approval.id, hash: approval.hash }, beforeWrite);
        if (!result.eventId) throw new Error("The calendar did not confirm the scheduled event.");
        return { eventId: result.eventId };
      }
    });
    this.chat = new ChatService(vault, {
      changed: host.changed, settings: () => this.settings(), workspace: () => this.snapshot(),
      search: (query, accountId) => this.retrieval.search(query, accountId),
      refreshMail: request => this.refreshMail(request),
      generate: request => this.runAi(() => this.copilot.chat(request)),
      workspaceDirectory: () => this.assistantWorkspace(),
      openPath: async (path, reveal) => {
        if (!this.host.openPath) throw new Error("Opening files requires the desktop application.");
        await this.host.openPath(path, reveal);
      },
      attention: (title, body) => { if (this.settings().notifications) this.host.notify(title, body); },
      execute: (command, beforeWrite) => command.type === "draft.generate"
        ? this.generateDraft(command.messageId, command.instruction, command.model, undefined, true)
        : this.command(command, beforeWrite)
    });
    if (host.browserExtensionId) {
      const archive = new BrowserArchive(vault, message => this.retrieval.indexMessage(message), host.changed,
        () => this.stopped || this.restoring || this.settings().syncPaused || !this.browser?.status().paired);
      this.browser = new BrowserBridge(vault, {
        extensionId: host.browserExtensionId, changed: host.changed,
        refreshSettings: () => ({ intervalSeconds: this.settings().refreshIntervalSeconds, paused: this.settings().syncPaused,
          backgroundCapture: this.settings().browserBackgroundCapture }),
        onDiscover: async input => {
          if (this.stopped || this.restoring) throw new Error("Archive maintenance is in progress.");
          return archive.discover(input);
        },
        onCapture: async input => {
          if (this.stopped || this.restoring) throw new Error("Archive maintenance is in progress.");
          this.browserCaptures++;
          const accountId = browserAccountId(input.accountEmail);
          const previous = this.browserCaptureTail;
          let release!: () => void;
          this.browserCaptureTail = new Promise<void>(resolve => { release = resolve; });
          try {
            await previous;
            const optedIn = this.settings().backgroundAi && this.vault.get<Account>("accounts", accountId)?.aiEnabled;
            const browserCandidates = new Set(optedIn ? input.messages.map(item => `${accountId}:message:${encodeURIComponent(item.id)}`)
              .filter(id => !this.vault.get<Message>("messages", id)) : []);
            const messages = await archive.capture(input);
            for (const message of messages)
              if (!message.historical || (!message.receivedAt && message.unread)) this.localTriage(message);
            const account = this.vault.get<Account>("accounts", accountId);
            const freshUnread = messages.filter(message => message.browser && message.unread && browserCandidates.has(message.id)
              && !this.vault.get("checkpoints", `ai:${message.id}:${message.revision}`));
            if (account?.aiEnabled && this.settings().backgroundAi && !this.aiBusy && !this.freshnessActive && !this.browserAiBusy && freshUnread.length)
              void this.runJob("ai", "Browser response suggestions", () => this.browserBackgroundAi(account.id, freshUnread), account.id)
                .catch(() => { /* runJob persists the actionable failure. */ });
          } finally { this.browserCaptures--; release(); }
        }
      });
    }
    if (host.browserExtensionDirectory && host.playwrightProfileDirectory)
      this.playwrightMail = new PlaywrightMailBrowser({
        profileDirectory: host.playwrightProfileDirectory, extensionDirectory: host.browserExtensionDirectory,
        changed: host.changed
      });
    if (this.browser || this.playwrightMail) {
      this.mailTransport = new GmailMailTransport(vault, this.connectors, this.playwrightMail ? {
        readMailThread: async (input, guard, signal) => {
          if (!this.settings().playwrightMailEnabled)
            throw new Error(this.playwrightMail!.status().error || "Browser fallback is paused. Configure Gmail API in Settings; managed-browser sign-in is available only where Google permits it.");
          try { return await this.playwrightMail!.readMailThread(input, guard, signal); }
          catch (error) {
            this.pauseRejectedBrowserSignIn(error);
            throw error;
          }
        }
      } : undefined, this.browser, () => this.settings().browserMailTransport);
      this.mailReader = new BrowserMailReader(vault, this.mailTransport, async (input, beforeCapture) => {
        const revision = this.documentAccessRevision;
        const archive = new BrowserArchive(vault, message => this.indexTransportMail(input, message), host.changed,
          () => {
            if (this.stopped || this.restoring || revision !== this.documentAccessRevision
              || this.settings().syncPaused) return true;
            beforeCapture?.();
            return false;
          });
        this.browserCaptures++;
        const previous = this.browserCaptureTail;
        let release!: () => void;
        this.browserCaptureTail = new Promise<void>(resolve => { release = resolve; });
        try { await previous; return await this.captureTransportMail(archive, input, beforeCapture); }
        finally { this.browserCaptures--; release(); }
      }, () => this.stopped || this.restoring, () => this.settings().syncPaused, () => this.documentAccessRevision);
    }
    if (!vault.get<Settings>("settings", "preferences")) vault.put("settings", "preferences", defaultSettings);
    this.mailArchive = new BrowserMailArchiveQueue(vault, this.mailReader, {
      enabled: () => this.settings().browserFullMailDownload, paused: () => this.settings().syncPaused,
      maintenance: () => this.stopped || this.restoring || this.freshnessActive,
      paired: () => this.settings().browserMailTransport === "companion"
        ? !!this.browser?.status().paired : !!this.playwrightMail || !!this.browser?.status().paired,
      changed: host.changed, error: safeError
    });
    this.browserDownloads = new BrowserAttachmentDownloads(vault, this.browser, this.mailReader, this.attachments, {
      downloadsDirectory: host.downloadsDirectory, enabled: () => this.settings().browserAttachmentDownload,
      unavailable: () => this.stopped || this.restoring || this.freshnessActive || this.attachmentBusy || this.settings().syncPaused || !this.browser?.status().paired,
      revision: () => this.documentAccessRevision, thresholdMb: () => this.settings().attachmentThresholdMb,
      changed: host.changed
    });
    this.freshness = new MailFreshness(vault, {
      reader: this.mailReader, revision: () => this.documentAccessRevision,
      transportIdentity: accountId => this.mailTransport?.cacheIdentity(accountId) ?? "",
      unavailable: account => {
        if (this.stopped || this.restoring) return "Archive maintenance or shutdown is in progress.";
        if (this.settings().syncPaused) return "Synchronization is paused. Resume it to refresh mail.";
        if (account?.connection === "browser") {
          const route = this.mailTransport?.status(account);
          if (route?.transport === "unavailable") return route.message;
          if (route?.transport === "companion" && !this.browser?.status().paired)
            return "Pair the companion in your normally signed-in Chrome or Edge browser to refresh this inbox.";
          if (route?.apiAccountId && !vault.get<Account>("accounts", route.apiAccountId)?.aiEnabled)
            return "Enable Copilot for this mailbox's Gmail API account before requesting AI summaries of its API-derived emails.";
          if (route?.transport !== "gmail-api" && !this.playwrightMail && !this.browser?.status().paired)
            return "Pair the browser companion to refresh this inbox.";
        }
        return undefined;
      },
      manual: () => this.settings().refreshIntervalSeconds === 0,
      busy: active => { this.freshnessActive = active; },
      inbox: async (account, guard, signal) => {
        if (!this.mailTransport || !this.mailReader) throw new Error("Configure Gmail API access or the managed browser to refresh this inbox.");
        return this.mailReader.exclusive(() => {
          guard();
          return this.mailTransport!.readMailThread({ accountId: account.id, accountEmail: account.email,
            threadId: "__relay_inbox__", inboxRefresh: true }, guard, signal);
        });
      },
      capture: async (input, guard) => {
        const archive = new BrowserArchive(vault, message => this.indexTransportMail(input, message), host.changed,
          () => { guard(); return false; });
        const previous = this.browserCaptureTail;
        let release!: () => void;
        this.browserCaptureTail = new Promise<void>(resolve => { release = resolve; });
        this.browserCaptures++;
        try { await previous; guard(); return await this.captureTransportMail(archive, input, guard); }
        finally { this.browserCaptures--; release(); }
      },
      sync: async (account, source, signal, guard) => {
        // An existing provider sync must settle before issuing a fresh, mail-only scoped sync.
        while (this.controllers.has(account.id)) {
          guard();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        guard();
        const before = new Map(vault.all<Message>("messages").filter(message => message.accountId === account.id
          && message.sourceId === source.id).map(message => [message.id, message.revision]));
        await this.syncAccount(account.id, { sources: [source], signal, guard });
        guard();
        return vault.all<Message>("messages").filter(message => message.accountId === account.id
          && message.sourceId === source.id && !message.deleted && before.get(message.id) !== message.revision).length;
      }
    });
    for (const job of vault.all<Job>("jobs"))
      if (job.status === "running" || job.status === "pending") vault.put("jobs", job.id, { ...job, status: "paused", detail: "Interrupted by application shutdown. Retry to reconcile and resume.", updatedAt: now() });
    for (const approval of vault.all<Approval>("approvals"))
      if (approval.status === "executing") vault.put("approvals", approval.id, { ...approval, status: "uncertain", error: "Interrupted while saving. Inspect your provider calendar before creating a new proposal." });
  }
  private relayStatuses() {
    const connectors = this.connectors as unknown as { relayStatuses?: () => NonNullable<Snapshot["gmailRelays"]> };
    return connectors.relayStatuses?.() ?? [];
  }
  private pauseRejectedBrowserSignIn(error: unknown): void {
    if (!(error instanceof PlaywrightMailError) || error.code !== "sign-in-blocked") return;
    this.vault.put("settings", "preferences", { ...this.settings(), playwrightMailEnabled: false });
    this.host.changed();
  }
  private async indexTransportMail(input: BrowserCapture, message: Message): Promise<void> {
    const origin = this.mailTransport?.origin(input);
    if (origin) message.gmailApi = origin;
    this.vault.put("messages", message.id, message);
    const metadata = input.messages.find(item => item.id === message.providerId)?.attachments;
    if (metadata) for (const attachment of this.vault.all<Attachment>("attachments")) {
      if (attachment.messageId !== message.id || !metadata.some(item => item.id === attachment.providerId)) continue;
      const updated = { ...attachment };
      if (origin) updated.gmailApi = origin;
      this.vault.put("attachments", attachment.id, updated);
    }
    await this.retrieval.indexMessage(message);
  }
  private async captureTransportMail(archive: BrowserArchive, input: BrowserCapture, guard?: () => void): Promise<Message[]> {
    guard?.();
    const messages = await archive.capture(input);
    guard?.();
    return messages;
  }
  async initialize(): Promise<void> {
    const settings = this.settings();
    await this.browserDownloads.recoverStaging();
    if (this.browser?.status().paired) {
      try { await this.browser.start(); }
      catch (error) {
        const id = randomUUID();
        this.vault.put("jobs", id, { id, kind: "sync", label: "Start browser companion", status: "failed", progress: 0,
          detail: safeError(error), createdAt: now(), updatedAt: now() } satisfies Job);
      }
    }
    try { await this.retrieval.configure(settings.semanticEnabled, settings.embeddingModel); }
    catch (error) {
      const id = randomUUID();
      this.vault.put("jobs", id, {
        id, kind: "index", status: "failed", label: "Load local semantic model", progress: 0,
        detail: `${safeError(error)} Keyword search remains available. Review model setup in Settings.`,
        createdAt: now(), updatedAt: now()
      } satisfies Job);
    }
    this.host.settingsChanged(settings);
    this.timer = setInterval(() => {
      if (!this.stopped && !this.restoring) this.wakeReminders();
      if (!this.stopped && !this.restoring) {
        this.browserDownloads.tick();
        this.mailArchive.tick();
      }
      if (this.settings().syncPaused || this.stopped || this.restoring) return;
      void this.processPendingAttachments().catch(() => { /* Individual attachment failures are recorded by runJob. */ });
      const interval = this.settings().refreshIntervalSeconds;
      if (!interval || Date.now() - this.lastScheduledRefresh < interval * 1000) return;
      this.lastScheduledRefresh = Date.now();
      for (const account of this.vault.all<Account>("accounts")) {
        if (account.status === "connected" && account.connection !== "browser" && !account.demo && account.consent && !this.controllers.has(account.id)
          && this.vault.all<Source>("sources").some(source => source.accountId === account.id && source.selected && source.providerId !== GMAIL_RELAY_PROVIDER_ID))
          void this.syncAccount(account.id, { excludeRelay: true }).catch(() => { /* runJob persists the actionable failure. */ });
        if (account.connection === "browser" && account.provider === "gmail" && !account.demo
          && account.consent && account.status === "connected" && !this.controllers.has(account.id)
          && this.vault.all<Source>("sources").some(source => source.accountId === account.id && source.kind === "mail" && source.selected)
          && (this.mailTransport?.status(account).transport === "gmail-api"
            || (this.mailTransport?.status(account).transport === "companion"
              && this.browser?.status().paired && this.settings().browserBackgroundCapture)
            || (this.settings().playwrightMailEnabled && this.mailTransport?.status(account).transport === "playwright")))
          void this.refreshBrowserInbox(account.id).catch(() => { /* runJob retains the refresh failure. */ });
      }
      for (const relay of this.relayStatuses()) {
        const account = this.vault.get<Account>("accounts", relay.accountId);
        const source = this.vault.get<Source>("sources", relay.sourceId);
        if (!account || !source?.selected || !account.consent || account.status !== "connected" || relay.stopped || relay.pollIntervalMinutes <= 0 || this.controllers.has(account.id)) continue;
        const last = this.lastRelayPoll.get(source.id) ?? (Date.parse(relay.lastSyncAt ?? "") || 0);
        if (Date.now() - last < relay.pollIntervalMinutes * 60_000) continue;
        this.lastRelayPoll.set(source.id, Date.now());
        void this.syncAccount(account.id, { sources: [source] }).catch(() => { /* runJob persists the actionable failure. */ });
      }
    }, 1000);
  }
  assistantWorkspace(): string {
    const configured = this.settings().assistantWorkspaceDir;
    return configured || join(this.host.documentsDirectory ?? process.env.USERPROFILE ?? "C:\\", this.host.documentsDirectory ? "Relay Desk" : "Documents\\Relay Desk");
  }
  settings(): Settings {
    const settings = { ...defaultSettings, ...this.vault.get<Settings>("settings", "preferences") };
    if (settings.aiUsageDate !== now().slice(0, 10)) {
      settings.aiUsageDate = now().slice(0, 10);
      settings.aiRunsToday = 0;
      this.vault.put("settings", "preferences", settings);
    }
    return settings;
  }
  snapshot(): Snapshot {
    const accounts = this.vault.all<Account>("accounts");
    const messages = this.vault.listMessages(500).filter(message => mailOriginAllowed(this.vault, message));
    const attachments = this.vault.all<Attachment>("attachments").filter(attachment => {
      const parent = this.vault.get<Message>("messages", attachment.messageId);
      return parent ? mailOriginAllowed(this.vault, parent)
        && mailOriginAllowed(this.vault, { ...parent, gmailApi: attachment.gmailApi }) : !attachment.gmailApi;
    }).map(attachment => {
      const parent = this.vault.get<Message>("messages", attachment.messageId);
      const parentAvailable = !!parent && !parent.deleted && parent.accountId === attachment.accountId;
      return { ...attachment, parentAvailable, sourceId: parentAvailable ? parent?.sourceId : undefined };
    });
    const stats = this.retrieval.stats();
    const settings = this.settings();
    this.wakeReminders();
    const visibleMessage = (messageId: string) => {
      const message = this.vault.get<Message>("messages", messageId);
      return !!message && mailOriginAllowed(this.vault, message);
    };
    const actions = this.vault.all<ActionItem>("actions").filter(action => visibleMessage(action.messageId));
    const source: Snapshot = {
      accounts, sources: this.vault.all<Source>("sources"),
      messages,
      drafts: this.vault.all<Draft>("drafts").filter(draft => visibleMessage(draft.messageId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      attachments, events: this.vault.all<CalendarEvent>("events").sort((a, b) => a.start.localeCompare(b.start)),
      actions, jobs: this.vault.all<Job>("jobs").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100),
      approvals: this.vault.all<Approval>("approvals"), settings, models: this.copilot.models, copilot: this.copilot.status,
      archive: { messages: this.vault.count("messages"), attachments: attachments.length, indexed: stats.indexed, searchMode: stats.mode, bytes: this.vault.bytes() },
      demo: accounts.some(account => account.demo), browser: this.browser?.status(),
      gmailRelays: this.relayStatuses(),
      assistantWorkspace: this.assistantWorkspace(),
      mailTransports: accounts.filter(account => account.provider === "gmail").map(account =>
        this.mailTransport?.status(account) ?? { accountId: account.id, transport: "unavailable" as const,
          message: "Gmail transport is unavailable in this installation." }),
      playwrightMail: this.playwrightMail?.status(),
      fullMailArchive: this.mailArchive.status(),
      browserItems: this.vault.all<BrowserCalendarItem>("browserItems").filter(item =>
        accounts.some(account => account.id === item.accountId && account.consent && account.status === "connected") &&
        this.vault.get<Source>("sources", item.sourceId)?.selected)
    };
    return { ...source, ...this.productivity.snapshot(source), chat: this.chat.snapshot() };
  }
  private wakeReminders(): void {
    let awakened = false;
    for (const action of this.vault.all<ActionItem>("actions")) {
      if (action.status === "snoozed" && action.snoozedUntil && Date.parse(action.snoozedUntil) <= Date.now()) {
        const next: ActionItem = { ...action, status: "open", snoozedUntil: undefined };
        this.vault.put("actions", action.id, next);
        this.productivity.syncActionStatus(next, true);
        awakened = true;
      }
    }
    if (awakened) {
      this.host.changed();
      if (this.settings().notifications) this.host.notify("Relay Desk", "A snoozed action is ready for review.");
    }
  }
  private account(id: string): Account {
    const account = this.vault.get<Account>("accounts", id);
    if (!account || account.status !== "connected" || !account.consent) throw new Error("Reconnect this account and confirm its data-access consent.");
    return account;
  }
  private selectedSource(id: string, accountId: string): Source {
    const source = this.vault.get<Source>("sources", id);
    if (!source || source.accountId !== accountId || !source.selected) throw new Error("This source is not selected. Enable it in account settings.");
    return source;
  }
  private message(id: string): Message {
    const message = this.vault.get<Message>("messages", id);
    if (!message) throw new Error("This message is no longer in the local archive.");
    if (message.deleted) throw new Error("This message is no longer available in its source and cannot be used for AI or provider actions.");
    this.account(message.accountId);
    this.selectedSource(message.sourceId, message.accountId);
    if (!mailOriginAllowed(this.vault, message))
      throw new Error("This email's Gmail API source is no longer authorized.");
    return message;
  }
  private linkedGmailAccount(email: string): Account | undefined {
    const normalized = normalizeEmail(email);
    return this.vault.all<Account>("accounts").find(account =>
      account.provider === "gmail" && account.connection !== "browser" && !account.demo && account.status === "connected"
      && account.consent && normalizeEmail(account.email) === normalized);
  }
  private async browserDraftContext(message: Message): Promise<BrowserDraftContext | undefined> {
    this.message(message.id);
    const browserAccount = this.account(message.accountId);
    if (!message.browser || browserAccount?.connection !== "browser" || browserAccount.provider !== "gmail") return undefined;
    const account = this.linkedGmailAccount(browserAccount.email);
    if (!account) return undefined;
    const resolved = await this.connectors.resolveBrowserThread(account, message);
    this.account(account.id);
    if (this.message(message.id).revision !== message.revision) throw new Error("The browser source changed while loading Gmail context. Capture it again and retry.");
    return {
      account, message: resolved.message,
      target: {
        accountId: account.id, provider: "gmail", messageProviderId: resolved.message.providerId,
        threadProviderId: resolved.threadProviderId, messageRevision: resolved.message.revision,
        threadRevision: resolved.threadRevision, resolvedAt: now()
      },
      citations: resolved.citations
    };
  }
  private nativeDraftMessage(account: Account, source: Message, target: NonNullable<Draft["nativeTarget"]>): Message {
    return {
      id: `${account.id}:message:${encodeURIComponent(target.messageProviderId)}`,
      accountId: account.id,
      sourceId: `${account.id}:mail:__browser-thread__`,
      providerId: target.messageProviderId,
      threadId: `${account.id}:thread:${encodeURIComponent(target.threadProviderId)}`,
      subject: source.subject,
      sender: source.sender,
      recipients: [...source.recipients],
      body: source.body,
      receivedAt: source.receivedAt,
      url: source.url,
      unread: source.unread,
      revision: target.messageRevision,
      historical: source.historical,
      browser: source.browser
    };
  }
  private requireAi(accountId: string): Account {
    const account = this.account(accountId);
    if (!account.aiEnabled) throw new Error("Enable AI for this account after reviewing the Copilot data-sharing notice.");
    return account;
  }
  private requireMessageAi(message: Message): void {
    this.requireAi(message.accountId);
    if (!mailOriginAllowed(this.vault, message, true))
      throw new Error("Enable AI on this email's authorized Gmail API source before sharing its content with Copilot.");
  }
  private citationAllowedForAi(citation: Citation): boolean {
    const message = this.vault.get<Message>("messages", citation.messageId);
    const account = message && this.vault.get<Account>("accounts", message.accountId);
    const source = message && this.vault.get<Source>("sources", message.sourceId);
    if (!message || message.deleted || !account?.aiEnabled || !account.consent || account.status !== "connected"
      || !source?.selected || source.accountId !== message.accountId || !mailOriginAllowed(this.vault, message, true)) return false;
    if (!citation.attachmentId) return true;
    const attachment = this.vault.get<Attachment>("attachments", citation.attachmentId);
    return !!attachment && attachment.messageId === message.id && attachment.accountId === message.accountId
      && mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi }, true);
  }
  async refreshMail(request: MailFreshnessRequest): Promise<MailFreshnessResult> {
    const result = await this.freshness.refresh(request);
    return { ...result, sources: result.sources.map(source => ({ ...source,
      ...(source.reason ? { reason: safeError(new Error(source.reason)) } : {}) })) };
  }
  private cancelAccount(accountId: string): void {
    this.documentAccessRevision++;
    this.browserDownloads.permissionsChanged();
    this.controllers.get(accountId)?.abort();
    if (this.attachmentController?.accountId === accountId || this.attachmentController?.linkedAccountId === accountId)
      this.attachmentController.controller.abort();
  }
  private async processPendingAttachments(): Promise<void> {
    if (this.attachmentBusy || this.browserDownloads.running || this.settings().syncPaused || this.stopped) return;
    const eligible = this.vault.all<Attachment>("attachments").filter(attachment => {
      const account = this.vault.get<Account>("accounts", attachment.accountId);
      const message = this.vault.get<Message>("messages", attachment.messageId);
      return ((!attachment.browser && account?.connection !== "browser") || !!attachment.gmailApi)
        && (!attachment.browser || this.settings().browserAttachmentDownload)
        && attachment.status === "pending" && account?.status === "connected" && account.consent && !account.demo
        && message && mailOriginAllowed(this.vault, message)
        && mailOriginAllowed(this.vault, { ...message, gmailApi: attachment.gmailApi })
        && this.vault.get<Source>("sources", message.sourceId)?.selected;
    }).slice(0, 3);
    for (const attachment of eligible) {
      if (this.stopped || this.browserDownloads.running || this.settings().syncPaused) break;
      await this.command({ type: "attachment.process", attachmentId: attachment.id, approved: false });
    }
  }
  private async runJob<T>(kind: Job["kind"], label: string, task: (job: Job) => Promise<T>, accountId?: string, args?: Command): Promise<T> {
    const job: Job = { id: randomUUID(), kind, accountId, label, status: "running", progress: 0, createdAt: now(), updatedAt: now() };
    this.vault.put("jobs", job.id, job);
    if (args) this.vault.put("checkpoints", `job:${job.id}`, args);
    this.activeJobs.add(job.id);
    this.host.changed();
    try {
      const result = await task(job);
      this.vault.put("jobs", job.id, { ...job, progress: 100, status: "done", updatedAt: now() });
      return result;
    } catch (error) {
      this.vault.put("jobs", job.id, { ...job, status: "failed", detail: safeError(error), updatedAt: now() });
      throw error;
    } finally { this.activeJobs.delete(job.id); this.host.changed(); }
  }
  private async syncAccount(accountId: string, freshness?: { sources?: Source[]; signal?: AbortSignal; guard?(): void; excludeRelay?: boolean }): Promise<void> {
    if (this.controllers.has(accountId)) throw new Error("This account is already syncing.");
    if (this.settings().syncPaused) throw new Error("Synchronization is paused in Settings.");
    const account = this.account(accountId);
    if (account.connection === "browser") throw new Error("Browser sources capture loaded pages. Open Gmail or Calendar and use the companion's Capture button; API sync is not used.");
    if (account.demo) throw new Error("Sample accounts do not connect to real providers.");
    freshness?.guard?.();
    const sources = (freshness?.sources ?? this.vault.all<Source>("sources").filter(s => s.accountId === accountId && s.selected))
      .filter(source => !freshness?.excludeRelay || source.providerId !== GMAIL_RELAY_PROVIDER_ID);
    if (!sources.length) throw new Error("Select at least one source before syncing.");
    const controller = new AbortController();
    const cancel = () => controller.abort(freshness?.signal?.reason);
    freshness?.signal?.addEventListener("abort", cancel, { once: true });
    this.controllers.set(accountId, controller);
    try {
      await this.runJob("sync", `Sync ${account.name}`, async job => {
        let imported = 0;
        await this.connectors.sync(account, sources, async page => {
          controller.signal.throwIfAborted();
          freshness?.guard?.();
          this.account(accountId);
          const scopedSources = freshness?.sources;
          if (scopedSources && (page.events.length || page.messages.some(message => message.accountId !== accountId
            || !scopedSources.some(source => source.id === message.sourceId))
            || page.attachments.some(attachment => attachment.accountId !== accountId)))
            throw new Error("The provider returned data outside the requested mail source scope.");
          for (const message of page.messages) this.selectedSource(message.sourceId, accountId);
          this.vault.transaction(() => {
            for (const message of page.messages) {
              const old = this.vault.get<Message>("messages", message.id);
              this.vault.put("messages", message.id, message);
              if (old && old.revision !== message.revision)
                for (const draft of this.vault.all<Draft>("drafts").filter(d => d.messageId === message.id))
                  this.vault.put("drafts", draft.id, { ...draft, status: "stale" });
              if (!message.historical && !message.deleted) this.localTriage(message);
            }
            for (const attachment of page.attachments)
              if (!this.vault.get("attachments", attachment.id)) this.vault.put("attachments", attachment.id, attachment);
            for (const event of page.events) this.vault.put("events", event.id, event);
          });
          for (const message of page.messages) {
            controller.signal.throwIfAborted();
            freshness?.guard?.();
            await this.retrieval.indexMessage(message);
          }
          freshness?.guard?.();
          // Advance only after indexing, so interruption replays an idempotent page.
          if (page.checkpoint) this.vault.put("checkpoints", page.checkpoint.id, page.checkpoint.value);
          imported += page.messages.length;
          job.detail = `${imported} messages processed. Historical coverage depends on provider access.`;
          this.vault.put("jobs", job.id, { ...job, updatedAt: now() });
          this.host.changed();
        }, controller.signal);
        const current = this.account(accountId);
        freshness?.guard?.();
        this.vault.put("accounts", accountId, { ...current, lastSync: now(), error: undefined });
      }, accountId, { type: "sync", accountId });
      if (!freshness?.signal && !freshness?.sources) await this.backgroundAi(accountId);
    } catch (error) {
      const current = this.vault.get<Account>("accounts", accountId);
      if (current) this.vault.put("accounts", accountId, { ...current, error: safeError(error) });
      throw error;
    } finally {
      freshness?.signal?.removeEventListener("abort", cancel);
      this.controllers.delete(accountId); this.host.changed();
    }
  }
  private async refreshBrowserInbox(accountId: string): Promise<void> {
    if (!this.mailTransport || !this.mailReader) throw new Error("Gmail mail transport is unavailable.");
    if (this.controllers.has(accountId)) throw new Error("This inbox is already refreshing.");
    const account = this.account(accountId), revision = this.documentAccessRevision;
    const controller = new AbortController();
    const guard = () => {
      controller.signal.throwIfAborted();
      this.account(accountId);
      this.selectedSource(`${accountId}:mail`, accountId);
      if (this.stopped || this.restoring || this.settings().syncPaused || revision !== this.documentAccessRevision)
        throw new Error("Inbox refresh was paused or account permissions changed.");
    };
    guard();
    this.controllers.set(accountId, controller);
    try {
      await this.runJob("sync", `Refresh Gmail inbox: ${account.name}`, () => this.mailReader!.exclusive(async () => {
        const capture = await this.mailTransport!.readMailThread({
          accountId, accountEmail: account.email, threadId: "__relay_inbox__", inboxRefresh: true
        }, guard, controller.signal);
        guard();
        const archive = new BrowserArchive(this.vault, message => this.indexTransportMail(capture, message),
          this.host.changed, () => this.stopped || this.restoring || this.settings().syncPaused || revision !== this.documentAccessRevision);
        await this.captureTransportMail(archive, capture, guard);
      }), accountId);
      this.mailArchive.tick();
    } finally { this.controllers.delete(accountId); }
  }
  private localTriage(message: Message): void {
    const id = `action:${message.id}`;
    const existing = this.vault.get<ActionItem>("actions", id);
    if (existing) return;
    const question = /\?|please|could you|can you|need your|action required/i.test(message.body);
    if (!question) return;
    const urgent = /\burgent\b|\basap\b|\bblocked\b|\btoday\b/i.test(message.body);
    const action: ActionItem = {
      id, messageId: message.id, accountId: message.accountId, title: message.subject,
      reason: (urgent ? "Local rule detected urgency wording. Review the cited message; no deadline is assumed." : "Local rule detected a question or request. Review whether it needs your response.")
        + (message.browser && !message.receivedAt ? " The browser did not provide an exact date; confirm this request is still current." : ""),
      priority: urgent ? "urgent" : "normal", status: "open", confidence: 0.5,
      citations: [this.citation(message)]
    };
    this.vault.put("actions", id, action);
    if (urgent && this.settings().notifications) this.host.notify("Relay Desk", "A new item may need your attention. Open your workspace to review it.");
  }
  private citation(message: Message): Citation {
    return { id: message.id, messageId: message.id, title: message.subject, excerpt: message.body.slice(0, 6000) };
  }
  private async backgroundAi(accountId: string): Promise<void> {
    const settings = this.settings();
    const account = this.account(accountId);
    if (!settings.backgroundAi || !account.aiEnabled || !settings.model || this.aiBusy || this.freshnessActive || settings.aiRunsToday >= settings.dailyAiLimit) return;
    const messages = this.vault.all<Message>("messages")
      .filter(m => m.accountId === accountId && !m.historical && !m.deleted && (!m.browser || m.browser.completeness === "full")
        && !this.vault.get("checkpoints", `ai:${m.id}:${m.revision}`))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 3);
    for (const message of messages) {
      if (this.stopped || this.aiBusy || this.freshnessActive || this.settings().aiRunsToday >= this.settings().dailyAiLimit) break;
      await this.generateDraft(message.id);
      this.vault.put("checkpoints", `ai:${message.id}:${message.revision}`, { done: true });
    }
  }
  private async browserBackgroundAi(accountId: string, messages: Message[]): Promise<void> {
    const settings = this.settings();
    const account = this.account(accountId);
    if (account.connection !== "browser" || !settings.backgroundAi || !account.aiEnabled || !settings.model || this.aiBusy || this.freshnessActive || this.browserAiBusy || settings.aiRunsToday >= settings.dailyAiLimit) return;
    const candidates = messages.filter(message => message.accountId === accountId && message.browser && message.unread && !message.deleted
      && !this.vault.get("checkpoints", `ai:${message.id}:${message.revision}`)).slice(0, 3);
    this.browserAiBusy = true;
    try {
      for (const message of candidates) {
        if (this.stopped || this.freshnessActive || this.settings().syncPaused || !this.settings().backgroundAi ||
          this.settings().aiRunsToday >= this.settings().dailyAiLimit) break;
        this.requireAi(accountId);
        const linked = await this.browserDraftContext(message);
        if (!linked) throw new Error("Automatic browser replies require the same Gmail address under Optional API connections to verify recent full message context.");
        const receivedAt = Date.parse(linked.message.receivedAt);
        if (!Number.isFinite(receivedAt) || receivedAt < Date.now() - 86400000 || receivedAt > Date.now()) continue;
        if (this.stopped || this.freshnessActive || this.settings().syncPaused || !this.settings().backgroundAi || this.aiBusy) break;
        await this.generateDraft(message.id, "", undefined, linked);
        this.vault.put("checkpoints", `ai:${message.id}:${message.revision}`, { done: true, hydratedAt: now(), verifiedReceivedAt: linked.message.receivedAt });
      }
    } finally { this.browserAiBusy = false; }
  }
  private async runAi<T>(task: () => Promise<T>): Promise<T> {
    if (this.aiBusy) throw new Error("Another AI request is running. Please wait.");
    const settings = this.settings();
    if (settings.aiRunsToday >= settings.dailyAiLimit) throw new Error("Your local daily AI-run budget is exhausted. Sync, search and editing still work.");
    this.aiBusy = true;
    this.vault.put("settings", "preferences", { ...settings, aiRunsToday: settings.aiRunsToday + 1 });
    this.host.changed();
    try { return await task(); } finally { this.aiBusy = false; this.host.changed(); }
  }
  private async generateDraft(messageId: string, instruction = "", override?: string, verifiedContext?: BrowserDraftContext, localOnly = false): Promise<CommandResult> {
    const message = this.message(messageId);
    this.requireMessageAi(message);
    const model = override || this.settings().model;
    if (!model) throw new Error("Connect Copilot and choose a model in Settings.");
    return this.runJob("ai", `Draft: ${message.subject}`, async () => this.runAi(async () => {
      const related = (await this.retrieval.search(message.subject, message.accountId)).filter(citation => this.citationAllowedForAi(citation));
      const localCitations = [this.citation(message), ...related.filter(c => c.messageId !== message.id)];
      let citations = localCitations;
      let nativeTarget: Draft["nativeTarget"];
      let replyMessage = message;
      let resultMessage = "Draft generated locally. Review and edit it before saving to your mailbox.";
      if (message.browser && !localOnly) {
          const linked = verifiedContext ?? await this.browserDraftContext(message);
          if (linked) {
            nativeTarget = linked.target;
            replyMessage = linked.message;
            citations = [...linked.citations, ...localCitations.filter(citation => !linked.citations.some(item => item.id === citation.id))];
            resultMessage = "Draft generated locally from the verified Gmail thread. Review and edit it before saving to Gmail as a draft.";
          } else if (this.vault.get<Account>("accounts", message.accountId)?.connection === "browser") {
            resultMessage = "Draft generated locally. To save this browser-captured Gmail reply natively, connect the same Gmail address under Optional API connections.";
          }
      }
      citations = citations.slice(0, 12);
      const chatRevisions = localOnly ? citations.map(citation => {
        const source = this.message(citation.messageId);
        this.requireAi(source.accountId);
        return { id: source.id, revision: source.revision };
      }) : [];
      const task = `Prepare an email/chat reply to the first evidence item. Also classify its priority, reason, and whether it needs a reply. `
        + `${nativeTarget ? "Verified same-mailbox Gmail API thread context is included; use it as the authoritative chronology and reply target while keeping the explicitly selected browser message as the user's scope. " : ""}`
        + `User guidance: ${instruction}`;
      this.requireMessageAi(this.message(messageId));
      if (this.message(messageId).revision !== message.revision) throw new Error("The source changed while preparing context. Review it and generate again.");
      if (nativeTarget) this.account(nativeTarget.accountId);
      const result = await this.copilot.generate(task, citations, model);
      if (!localCitations.every(citation => this.citationAllowedForAi(citation)))
        throw new Error("Draft evidence permissions changed during generation.");
      for (const source of chatRevisions) {
        const current = this.message(source.id);
        this.requireAi(current.accountId);
        if (current.revision !== source.revision) throw new Error("Draft evidence changed. Generate a new draft.");
      }
      this.requireMessageAi(this.message(messageId));
      if (this.message(messageId).revision !== message.revision) throw new Error("The source message changed while generating. Review the new message and regenerate.");
      const used = citations.filter(c => result.citationIds.includes(c.id));
      const sender = replyMessage.sender.match(/<([^>]+)>/)?.[1] ?? replyMessage.sender;
      const draft: Draft = {
        id: randomUUID(), accountId: message.accountId, messageId, body: result.answer,
        subject: /^re:/i.test(replyMessage.subject) ? replyMessage.subject : `Re: ${replyMessage.subject}`,
        recipients: sender.includes("@") ? [sender] : [], model, updatedAt: now(),
        sourceRevision: message.revision, nativeTarget, status: "local", citations: localOnly ? citations : used
      };
      this.vault.put("drafts", draft.id, draft);
      const actionId = `action:${message.id}`;
      const existing = this.vault.get<ActionItem>("actions", actionId);
      if (result.needsReply !== false) this.vault.put("actions", actionId, {
        id: actionId, messageId, accountId: message.accountId, title: message.subject, reason: result.reason || "Review this suggested response.",
        priority: result.priority || "normal", status: existing?.status ?? "open", confidence: 0.7,
        citations: localOnly ? citations : used.length ? used : [this.citation(message)]
      } satisfies ActionItem);
      return { draftId: draft.id, message: resultMessage };
    }), message.accountId);
  }
  private commandContext(): CommandContext {
    return {
      vault: this.vault, connectors: this.connectors, retrieval: this.retrieval, productivity: this.productivity, chat: this.chat,
      changed: () => this.host.changed(),
      settings: () => this.settings(),
      account: id => this.account(id),
      selectedSource: (id, accountId) => this.selectedSource(id, accountId),
      requireAi: accountId => this.requireAi(accountId),
      browser: () => this.browser,
      automationUnavailable: () => this.stopped || this.restoring || this.settings().syncPaused,
      trackJob: (jobId, active) => { if (active) this.activeJobs.add(jobId); else this.activeJobs.delete(jobId); },
      cancelAccount: accountId => this.cancelAccount(accountId),
      relayStatuses: () => this.relayStatuses(),
      runJob: (kind, label, task, accountId) => this.runJob(kind, label, task, accountId),
      startRelaySync: (accountId, source) => {
        if (this.controllers.has(accountId)) return "running";
        this.lastRelayPoll.set(source.id, Date.now());
        // Imports can take minutes; progress and failures are reported through the sync job and relay row.
        void this.syncAccount(accountId, { sources: [source] }).catch(() => { /* runJob persists the actionable failure. */ });
        return "started";
      }
    };
  }

  async command(command: Command, beforeWrite?: () => void): Promise<CommandResult> {
    if (this.restoring) throw new Error("Archive restore is in progress. Wait before starting another operation.");
    if (this.stopped) throw new Error("Application shutdown is in progress.");
    switch (command.type) {
      case "chat.new":
      case "chat.send":
      case "chat.confirm":
      case "chat.cancel":
      case "chat.delete":
      case "chat.permission":
      case "chat.openFile":
        return this.chat.command(command);
      case "task.create":
      case "task.edit":
      case "task.status":
      case "review.start":
      case "review.pause":
      case "review.cancel":
        return this.productivity.command(command, this.snapshot());
      case "task.schedule":
      case "report.generate":
        return this.runJob(command.type === "report.generate" ? "ai" : "sync",
          command.type === "report.generate" ? "Generate focus report" : "Schedule task on calendar",
          () => this.productivity.command(command, this.snapshot(), beforeWrite));
      case "demo.load":
      case "demo.clear":
        return accountCommand(this.commandContext(), command);
      case "browser.pair": {
        if (!command.consent) throw new Error("Confirm permission to capture your signed-in Google pages locally.");
        if (!this.browser) throw new Error("The browser companion is unavailable in this build.");
        const pairing = await this.browser.pair();
        for (const account of this.vault.all<Account>("accounts").filter(account => account.connection === "browser" && account.status === "disconnected")) {
          this.vault.put("accounts", account.id, { ...account, status: "connected", consent: true, aiEnabled: false });
          for (const source of this.vault.all<Source>("sources").filter(source => source.accountId === account.id))
            this.vault.put("sources", source.id, { ...source, selected: false });
        }
        for (const marker of this.vault.all<{ id?: string }>("checkpoints"))
          if (marker.id?.startsWith("browser-forgotten:")) this.vault.delete("checkpoints", marker.id);
        return { browserPairing: pairing, message: "Enter this short-lived code in the Relay Desk browser companion." };
      }
      case "browser.extension": {
        if (!this.host.openBrowserExtension) throw new Error("The browser companion is unavailable in this build.");
        await this.host.openBrowserExtension(); return { message: "In Chrome or Edge Extensions, enable Developer mode and Load unpacked using this folder. Pair once; no Google OAuth registration is needed." };
      }
      case "browser.revoke": {
        this.documentAccessRevision++;
        this.browserDownloads.permissionsChanged();
        await this.browser?.revoke();
        for (const account of this.vault.all<Account>("accounts").filter(account => account.connection === "browser"))
          this.vault.put("accounts", account.id, { ...account, status: "disconnected", aiEnabled: false });
        this.chat.permissionsChanged();
        this.host.changed(); return { message: "Browser pairing revoked. Local data is retained but excluded." };
      }
      case "browser.open": {
        if (command.kind === "whatsapp") {
          if (command.accountId) {
            const account = this.vault.get<Account>("accounts", command.accountId);
            if (!account || account.provider !== "whatsapp" || account.connection !== "browser")
              throw new Error("Choose a WhatsApp browser account.");
          }
          await this.host.openExternal("https://web.whatsapp.com/");
          return { message: "WhatsApp Web opened in your default browser. Use the paired browser profile, link your phone if needed, and verify your own Profile phone before capture. Opening does not enable ingestion or AI." };
        }
        const account = command.accountId ? this.account(command.accountId) : undefined;
        if (account && account.provider !== "gmail") throw new Error("Browser mode currently supports Google accounts only.");
        const authuser = account ? `?authuser=${encodeURIComponent(account.email)}` : "";
        const url = command.kind === "add-account" ? "https://accounts.google.com/AddSession"
          : command.kind === "calendar" ? `https://calendar.google.com/calendar/${authuser}#agenda`
          : `https://mail.google.com/mail/${authuser}`;
        await this.host.openExternal(url); return {};
      }
      case "browser.open-link": {
        const result = parseBrowserAccountLink(command.url);
        if (!result.link) throw new Error(result.error);
        await this.host.openExternal(result.link.url);
        return { message: "Provider page opened in your default browser, not an account connection. The paired companion must verify the signed-in Google header before the account appears. Select sources and AI consent separately." };
      }
      case "browser.meeting": {
        const item = this.vault.get<BrowserCalendarItem>("browserItems", command.itemId);
        if (!item) throw new Error("This browser meeting is unavailable.");
        this.account(item.accountId); this.selectedSource(item.sourceId, item.accountId);
        const url = new URL(item.meetingUrl || item.url);
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["meet.google.com", "calendar.google.com"].includes(url.hostname)) throw new Error("Unsupported meeting link.");
        await this.host.openExternal(url.href); return {};
      }
      case "browser.calendar.move":
        return moveBrowserCalendarEvent(this.commandContext(), command, beforeWrite);
      case "account.connect":
      case "account.disconnect":
      case "account.consent":
      case "account.ai":
      case "source.select":
        return accountCommand(this.commandContext(), command);
      case "gmailRelay.test":
      case "gmailRelay.connect":
      case "gmailRelay.replaceToken":
      case "gmailRelay.remove":
      case "gmailRelay.sync":
        return gmailRelayCommand(this.commandContext(), command);
      case "sync": {
        const ids = command.accountId ? [command.accountId] : this.vault.all<Account>("accounts").filter(a => !a.demo && a.connection !== "browser" && a.status === "connected").map(a => a.id);
        if (!ids.length) throw new Error("Connect a real account and select its sources first.");
        for (const id of ids) await this.syncAccount(id, { excludeRelay: true });
        return { message: "Selected accounts synchronized." };
      }
      case "refresh.request": {
        if (this.settings().syncPaused) return { message: "Workspace refreshed. Channel capture and sync remain paused." };
        this.browser?.requestRefresh();
        const accounts = this.vault.all<Account>("accounts").filter(account => !account.demo && account.connection !== "browser" &&
          account.status === "connected" && account.consent &&
          this.vault.all<Source>("sources").some(source => source.accountId === account.id && source.selected));
        const browserAccounts = this.vault.all<Account>("accounts").filter(account => !account.demo
          && account.connection === "browser" && account.provider === "gmail" && account.status === "connected" && account.consent
          && this.vault.all<Source>("sources").some(source => source.accountId === account.id && source.kind === "mail" && source.selected));
        const results = await Promise.allSettled([
          ...accounts.map(account => this.syncAccount(account.id, { excludeRelay: true })),
          ...this.relayStatuses().map(relay => {
            const source = this.vault.get<Source>("sources", relay.sourceId);
            return source?.selected ? this.syncAccount(relay.accountId, { sources: [source] }) : Promise.resolve();
          }),
          ...browserAccounts.map(account => this.refreshBrowserInbox(account.id))
        ]);
        this.host.changed();
        if (results.some(result => result.status === "rejected"))
          throw new Error("Some account refreshes failed. See Activity for details; open browser tabs were also asked to refresh.");
        return { message: "Selected API sources synchronized and Gmail inbox reads completed through their configured transport. Full conversation downloads continue in the archive queue. Companion Calendar and other channels refresh separately." };
      }
      case "assistant.workspace.open": {
        const directory = this.assistantWorkspace();
        await mkdir(directory, { recursive: true });
        if (!this.host.openPath) throw new Error("Opening folders requires the desktop application.");
        await this.host.openPath(directory, false);
        return { message: `Opened ${directory}.` };
      }
      case "assistant.workspace.choose": {
        if (!this.host.chooseFolder) throw new Error("Choosing folders requires the desktop application.");
        const chosen = await this.host.chooseFolder("Choose the Copilot workspace folder", this.assistantWorkspace());
        if (!chosen) return { message: "Workspace folder unchanged." };
        if (!/^[A-Za-z]:\\/.test(chosen) || /^[A-Za-z]:\\?$/.test(chosen)) throw new Error("Choose a folder, not a drive root.");
        this.vault.put("settings", "preferences", { ...this.settings(), assistantWorkspaceDir: chosen });
        this.host.changed();
        return { message: `Copilot workspace set to ${chosen}.` };
      }
      case "settings.update": {
        const previous = this.settings(), next = { ...previous, ...command.patch };
        if (next.model && !this.copilot.models.some(m => m.id === next.model) && next.model !== previous.model)
          throw new Error("Choose a currently available Copilot model.");
        if (next.browserMailTransport !== previous.browserMailTransport) {
          this.documentAccessRevision++;
          this.mailArchive.permissionsChanged();
          this.browserDownloads.permissionsChanged();
          for (const controller of this.controllers.values()) controller.abort();
          if (next.browserMailTransport === "companion") next.playwrightMailEnabled = false;
        }
        if (next.syncPaused) {
          for (const controller of this.controllers.values()) controller.abort();
          this.attachmentController?.controller.abort();
        }
        if (next.semanticEnabled !== previous.semanticEnabled || next.embeddingModel !== previous.embeddingModel)
          await this.retrieval.configure(next.semanticEnabled, next.embeddingModel);
        this.vault.put("settings", "preferences", next);
        if ((!next.browserFullMailDownload && previous.browserFullMailDownload) || (next.syncPaused && !previous.syncPaused))
          this.mailArchive.permissionsChanged();
        if ((!next.browserAttachmentDownload && previous.browserAttachmentDownload) || (next.syncPaused && !previous.syncPaused))
          this.browserDownloads.permissionsChanged();
        this.host.settingsChanged(next);
        this.host.changed();
        return { message: "Settings saved." };
      }
      case "copilot.connect": await this.copilot.connect(); return { message: "Copilot connected. Choose an available model." };
      case "copilot.login": await this.host.loginCopilot(); return { message: "Use /login in the Copilot window, then click Connect here." };
      case "draft.generate": return this.generateDraft(command.messageId, command.instruction, command.model);
      case "draft.handoff": {
        const draft = this.vault.get<Draft>("drafts", command.draftId);
        if (!draft) throw new Error("Draft not found.");
        const account = this.account(draft.accountId);
        if (account.provider !== "gmail") throw new Error("One-click mailbox draft handoff currently supports Gmail.");
        await this.command({ ...command, type: "draft.edit" });
        const edited = this.vault.get<Draft>("drafts", draft.id);
        if (!edited || edited.body !== command.body || edited.subject !== command.subject ||
            JSON.stringify(edited.recipients) !== JSON.stringify(command.recipients) || edited.sourceRevision !== draft.sourceRevision)
          throw new Error("The reviewed draft changed before saving. Review it again.");
        await this.command({ type: "draft.save", draftId: draft.id }, beforeWrite);
        await this.host.openExternal(`https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#drafts`);
        return { message: "Your reviewed reply is saved in Gmail Drafts and Gmail is open. Nothing was sent." };
      }
      case "draft.edit": {
        const draft = this.vault.get<Draft>("drafts", command.draftId);
        if (!draft) throw new Error("Draft not found.");
        this.message(draft.messageId);
        if (draft.status === "uncertain") throw new Error("This draft has an uncertain provider save. Inspect your mailbox before editing a new draft.");
        this.vault.put("drafts", draft.id, { ...draft, body: command.body, subject: command.subject, recipients: command.recipients, updatedAt: now(), status: draft.status === "stale" ? "stale" : "local" });
        this.host.changed();
        return { message: "Edits saved locally." };
      }
      case "draft.save": {
        const draft = this.vault.get<Draft>("drafts", command.draftId);
        if (!draft) throw new Error("Draft not found.");
        const message = this.message(draft.messageId), account = this.account(draft.accountId);
        if (account.demo) throw new Error("Sample drafts cannot be saved to a real mailbox.");
        if (account.provider === "slack") throw new Error("Slack responses are copy/paste only.");
        if (draft.sourceRevision !== message.revision || draft.status === "stale") throw new Error("This conversation changed. Generate and review a fresh draft.");
        if (draft.status === "uncertain") throw new Error("The prior save may have succeeded. Inspect your mailbox before creating another draft.");
        const target = account.connection === "browser"
          ? draft.nativeTarget ? {
            account: this.account(draft.nativeTarget.accountId), message: this.nativeDraftMessage(this.account(draft.nativeTarget.accountId), message, draft.nativeTarget),
            target: draft.nativeTarget, citations: []
          } : await this.browserDraftContext(message)
          : undefined;
        if (account.connection === "browser" && !target)
          throw new Error("Native Gmail draft saving for browser captures requires the same Gmail address to be connected under Optional API connections.");
        if (account.connection === "browser" && target && normalizeEmail(target.account.email) !== normalizeEmail(account.email))
          throw new Error("Relay Desk only saves browser-captured Gmail drafts through the same email address's authorized Gmail API account.");
        const latestDraft = this.vault.get<Draft>("drafts", draft.id);
        if (latestDraft?.updatedAt !== draft.updatedAt || latestDraft.body !== draft.body ||
          latestDraft.subject !== draft.subject || JSON.stringify(latestDraft.recipients) !== JSON.stringify(draft.recipients) ||
          latestDraft.status !== draft.status || this.message(message.id).revision !== draft.sourceRevision)
          throw new Error("The draft or source changed while preparing the save. Review it and save again.");
        const providerAccount = target?.account ?? account;
        const providerMessage = target?.message ?? message;
        const providerDraft = target ? {
          ...draft, accountId: providerAccount.id, messageId: providerMessage.id, sourceRevision: target.target.messageRevision,
          nativeTarget: target.target
        } : draft;
        return this.runJob("sync", "Save reviewed email draft", async () => {
          beforeWrite?.();
          const nextDraft = { ...draft, status: "uncertain", ...(target ? { nativeTarget: target.target } : {}) };
          this.vault.put("drafts", draft.id, nextDraft);
          this.host.changed();
          const result = await this.connectors.saveDraft(providerAccount, providerMessage, providerDraft, target ? { browserMessageId: message.id } : undefined);
          this.vault.put("drafts", draft.id, { ...nextDraft, ...result, savedBody: nextDraft.body, status: "saved", updatedAt: now() });
          return { message: "Saved to your mailbox as a draft. Nothing was sent." };
        }, providerAccount.id);
      }
      case "action.update": {
        const action = this.vault.get<ActionItem>("actions", command.actionId);
        if (!action) throw new Error("Action not found.");
        if (command.status === "snoozed" && (!command.snoozedUntil || Date.parse(command.snoozedUntil) <= Date.now())) throw new Error("Choose a future time for snooze.");
        const updated: ActionItem = { ...action, status: command.status, snoozedUntil: command.snoozedUntil };
        this.vault.put("actions", action.id, updated);
        this.productivity.syncActionStatus(updated);
        this.host.changed();
        return {};
      }
      case "browser.playwright.open": {
        const account = this.account(command.accountId);
        if (account.provider !== "gmail" || account.demo || !this.playwrightMail)
          throw new Error("Managed browser fallback is available only for connected Gmail accounts in the desktop app.");
        if (!this.vault.all<Source>("sources").some(source => source.accountId === account.id && source.kind === "mail" && source.selected))
          throw new Error("Select this account's mail source before opening its managed browser.");
        try { await this.playwrightMail.open(account.email); }
        catch (error) {
          this.pauseRejectedBrowserSignIn(error);
          throw error;
        }
        this.vault.put("settings", "preferences", { ...this.settings(), playwrightMailEnabled: true });
        this.host.changed();
        return { message: "Playwright fallback enabled. Sign in to the requested Gmail account in the dedicated browser. No existing browser credentials were copied." };
      }
      case "browser.playwright.close": {
        this.vault.put("settings", "preferences", { ...this.settings(), playwrightMailEnabled: false });
        try { await this.playwrightMail?.close(); }
        finally { this.host.changed(); }
        return { message: "Playwright browser closed and fallback paused. Gmail API connections remain available." };
      }
      case "search": return { citations: await this.retrieval.search(command.query, command.accountId) };
      case "ask": {
        const citations = (await this.retrieval.search(command.query, command.accountId))
          .filter(citation => this.citationAllowedForAi(citation));
        if (!citations.length) throw new Error("No eligible evidence found. Select sources, finish indexing and enable AI for the relevant account.");
        return this.runJob("ai", "Answer from your archive", async () => this.runAi(async () => {
          const result = await this.copilot.generate(`Answer the user's question using only the supplied archive excerpts: ${command.query}`, citations, command.model || this.settings().model);
          for (const citation of citations) this.requireMessageAi(this.message(citation.messageId));
          if (!citations.every(citation => this.citationAllowedForAi(citation)))
            throw new Error("Answer evidence permissions changed during generation.");
          return { answer: result.answer, citations: citations.filter(c => result.citationIds.includes(c.id)) };
        }));
      }
      case "attachment.view":
      case "attachment.save": {
        const revision = this.documentAccessRevision;
        const validate = attachmentViewGuard(this.vault, command.attachmentId,
          () => this.stopped || this.restoring || revision !== this.documentAccessRevision);
        validate();
        if (command.type === "attachment.view") {
          const attachmentView = await viewAttachment(this.vault, validate);
          validate();
          return { attachmentView };
        }
        if (this.documentSaving) throw new Error("Another document save is in progress. Finish or cancel its file dialog first.");
        if (!this.host.saveAttachmentPath) throw new Error("The native attachment save dialog is unavailable in this installation.");
        this.documentSaving = true;
        try {
          const attachmentSave = await saveAttachment(this.vault, validate, name => this.host.saveAttachmentPath!(name));
          validate();
          return { attachmentSave, message: attachmentSave.message };
        } finally { this.documentSaving = false; }
      }
      case "attachment.download": {
        const attachment = this.vault.get<Attachment>("attachments", command.attachmentId);
        if (attachment?.gmailApi)
          return this.command({ type: "attachment.process", attachmentId: attachment.id, approved: command.approved });
        if (!attachment || attachment.browser?.source !== "browser_gmail")
          throw new Error("Automatic browser attachment downloads require captured Gmail metadata.");
        return this.runJob("attachment", `Download Gmail attachment: ${attachment.name}`, async () => {
          await this.browserDownloads.download(attachment.id, command.approved);
          return { message: this.vault.get<Attachment>("attachments", attachment.id)?.reason || "Attachment download and local processing status updated." };
        }, attachment.accountId, command);
      }
      case "attachment.import":
      case "attachment.process": {
        if (this.attachmentBusy || this.browserDownloads.running) throw new Error("Another attachment is being processed. Its status is visible in Activity.");
        const attachment = this.vault.get<Attachment>("attachments", command.attachmentId);
        if (!attachment) throw new Error("Attachment not found.");
        const account = this.account(attachment.accountId);
        const message = this.message(attachment.messageId);
        if (message.accountId !== account.id) throw new Error("Attachment account does not match its message.");
        if (account.demo) throw new Error("This is a synthetic attachment. Real attachments are available after account connection.");
        const unavailable = () => this.stopped || this.restoring || this.settings().syncPaused;
        if (attachment.browser || account.connection === "browser" || command.type === "attachment.import") {
          browserAttachmentGuard(this.vault, attachment.id, unavailable)();
          if (command.type === "attachment.process" && !attachment.hash && !attachment.gmailApi)
            throw new Error("Use Download attachment for Gmail, or choose Import downloaded file for a manual fallback.");
        }
        if (command.type === "attachment.import" && !this.host.importAttachmentPath)
          throw new Error("The native downloaded-file picker is unavailable in this installation.");
        this.attachmentBusy = true;
        const controller = new AbortController();
        this.attachmentController = { accountId: account.id, linkedAccountId: attachment.gmailApi?.accountId, controller };
        try {
          return await this.runJob("attachment", `${command.type === "attachment.import" ? "Import downloaded copy" : "Process"}: ${attachment.name}`, async () => {
            if (command.type === "attachment.import")
              return importBrowserAttachment(this.vault, this.attachments, attachment.id, command.approved,
                () => this.host.importAttachmentPath!(), controller.signal, unavailable);
            if (attachment.gmailApi) {
              const origin = attachment.gmailApi;
              const validate = () => {
                controller.signal.throwIfAborted();
                const current = this.vault.get<Attachment>("attachments", attachment.id);
                const parent = this.message(attachment.messageId);
                if (unavailable() || !current || current.providerId !== attachment.providerId
                  || current.gmailApi?.accountId !== origin.accountId || current.gmailApi.sourceId !== origin.sourceId
                  || !mailOriginAllowed(this.vault, { ...parent, gmailApi: origin }))
                  throw new Error("Gmail attachment access changed or synchronization was paused.");
              };
              validate();
              await this.attachments.process(attachment.id, command.approved, controller.signal, {
                size: attachment.size, validate,
                open: async signal => {
                  validate();
                  const stream = await this.connectors.downloadLinkedGmailAttachment(account, attachment, origin.accountId, origin.sourceId, signal);
                  validate();
                  return stream;
                }
              });
            } else if (attachment.browser)
              await processRetainedBrowserAttachment(this.vault, this.attachments, attachment.id, command.approved, controller.signal, unavailable);
            else await this.attachments.process(attachment.id, command.approved, controller.signal);
            return { message: this.vault.get<Attachment>("attachments", attachment.id)?.reason || "Attachment processing status updated." };
          }, account.id, command);
        } finally {
          this.attachmentBusy = false;
          this.attachmentController = undefined;
        }
      }
      case "calendar.propose": {
        const account = this.account(command.change.accountId);
        if (account.connection === "browser") throw new Error("Browser calendars are read-only. Create or edit meetings in Google Calendar.");
        const source = this.selectedSource(command.change.sourceId, account.id);
        if (account.demo || source.kind !== "calendar") throw new Error("Choose a real connected calendar.");
        if (command.change.eventId) {
          const event = this.vault.get<CalendarEvent>("events", command.change.eventId);
          if (!event || event.accountId !== account.id || event.sourceId !== source.id) throw new Error("The event is not in this calendar.");
          if (event.recurring) throw new Error("Edit recurring series or individual occurrences in the provider calendar for now.");
          if (event.writable === false) throw new Error("This event is read-only.");
        }
        const approval = proposeChange(command.change);
        this.vault.put("approvals", approval.id, approval);
        this.host.changed();
        return { approvalId: approval.id, message: "Review the exact calendar change and its invitation effects before approving." };
      }
      case "calendar.approve": {
        const approval = this.vault.get<Approval>("approvals", command.approvalId);
        if (!approval) throw new Error("Approval not found.");
        validateApproval(approval, command.hash);
        const account = this.account(approval.change.accountId);
        if (account.connection === "browser") throw new Error("Browser calendars are read-only. Make changes in Google Calendar.");
        const source = this.selectedSource(approval.change.sourceId, account.id);
        beforeWrite?.();
        this.vault.put("approvals", approval.id, { ...approval, status: "executing" });
        this.host.changed();
        try {
          const event = await this.connectors.writeEvent(account, source, approval.change, approval.id);
          this.vault.transaction(() => {
            this.vault.put("events", event.id, event);
            this.vault.put("approvals", approval.id, { ...approval, status: "done" });
            this.vault.put("audit", approval.id, { id: approval.id, accountId: account.id, kind: "calendar.write", payloadHash: approval.hash, at: now() });
          });
          return { eventId: event.id, message: "Approved calendar change saved. Provider invitation rules apply." };
        } catch (error) {
          this.vault.put("approvals", approval.id, { ...approval, status: "uncertain", error: safeError(error) + " Inspect the provider calendar before creating another proposal." });
          throw error;
        } finally { this.host.changed(); }
      }
      case "message.downloadAll": {
        this.mailArchive.retry();
        const status = this.mailArchive.status();
        return { message: !status.enabled
          ? "Full email download is disabled. Enable it in Settings to download selected Gmail conversations."
          : this.settings().syncPaused ? "Full email retries queued. Resume synchronization to download them."
          : "Full email download requested for captured conversations in selected Gmail sources. Failures will retry with backoff." };
      }
      case "message.load": {
        const message = this.message(command.messageId);
        const account = this.account(message.accountId);
        const selected = this.selectedSource(message.sourceId, account.id);
        if (message.browser && account.provider === "gmail" && account.connection === "browser") {
          if (!this.mailReader)
            throw new Error("Pair the updated Edge or Chrome companion to load full emails in this inbox.");
          const messageThread = await this.mailReader.load(message.id, command.refresh);
          this.host.changed();
          return { messageThread };
        }
        if (account.provider === "gmail" && account.connection !== "browser" && !account.demo && command.refresh) {
          if (this.controllers.has(account.id)) throw new Error("This Gmail account is already refreshing. Wait for it to finish.");
          const controller = new AbortController(), revision = this.documentAccessRevision;
          const guard = () => {
            controller.signal.throwIfAborted();
            this.message(message.id);
            if (this.stopped || this.restoring || this.settings().syncPaused || revision !== this.documentAccessRevision)
              throw new Error("Gmail refresh was paused or its source permissions changed.");
          };
          guard();
          this.controllers.set(account.id, controller);
          try {
            await this.runJob("sync", "Load complete Gmail API conversation", async () => {
              const page = await this.connectors.readGmailThreadPage(account, selected, message.providerId, guard, controller.signal);
              guard();
              if (!page.messages.length || page.messages.some(item => item.accountId !== account.id
                || item.sourceId !== selected.id || item.threadId !== message.threadId))
                throw new Error("Gmail returned a different conversation or source.");
              this.vault.transaction(() => {
                for (const item of page.messages) {
                  const old = this.vault.get<Message>("messages", item.id);
                  this.vault.put("messages", item.id, item);
                  if (old && old.revision !== item.revision)
                    for (const draft of this.vault.all<Draft>("drafts").filter(draft => draft.messageId === item.id))
                      this.vault.put("drafts", draft.id, { ...draft, status: "stale" });
                }
                for (const item of page.attachments)
                  if (!this.vault.get("attachments", item.id)) this.vault.put("attachments", item.id, item);
              });
              for (const item of page.messages) { guard(); await this.retrieval.indexMessage(item); }
              guard();
            }, account.id);
          } finally { this.controllers.delete(account.id); this.host.changed(); }
        }
        const messages = this.vault.all<Message>("messages").filter(item => item.accountId === account.id
          && item.sourceId === message.sourceId && item.threadId === message.threadId && !item.deleted);
        const ids = new Set(messages.map(item => item.id));
        return { messageThread: { accountId: account.id, sourceId: message.sourceId, threadId: message.threadId, messages,
          attachments: this.vault.all<Attachment>("attachments").filter(item => item.accountId === account.id && ids.has(item.messageId)),
          loadedAt: now(), cached: !(account.provider === "gmail" && !account.demo && command.refresh) } };
      }
      case "open.message": {
        const message = this.message(command.messageId);
        if (!message.url) throw new Error("This archived or sample message has no provider link.");
        const url = new URL(message.url);
        const provider = this.account(message.accountId).provider;
        const allowed = provider === "gmail" ? url.hostname === "mail.google.com"
          : provider === "microsoft" ? ["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname)
          : url.hostname === "app.slack.com" || /^[a-z0-9-]+\.slack\.com$/.test(url.hostname);
        if (url.protocol !== "https:" || !allowed || url.username || url.password) throw new Error("The provider link is not an allowed destination.");
        await this.host.openExternal(url.href); return {};
      }
      case "clipboard.copy": this.host.copy(command.text); return { message: "Copied to clipboard." };
      case "job.retry": {
        const job = this.vault.get<Job>("jobs", command.jobId);
        const args = this.vault.get<Command>("checkpoints", `job:${command.jobId}`);
        if (!job || !["failed", "paused"].includes(job.status) || !args) throw new Error("This operation is not automatically retryable. Review its status and start a fresh request.");
        return this.command(args);
      }
      case "archive.reindex":
        return this.runJob("index", "Rebuild archive index", async () => { await this.retrieval.reindex(); return { message: "Archive index rebuilt." }; });
      case "archive.backup": {
        const path = await this.host.backupPath();
        if (!path) return { message: "Backup cancelled." };
        await this.runJob("backup", "Encrypt archive backup", async () => this.vault.backup(path));
        return { message: "Encrypted backup saved. Recovery requires this archive's encryption key." };
      }
      case "archive.restore": {
        if (this.browserDownloads.running || this.browserCaptures || this.activeJobs.size || this.controllers.size || this.aiBusy || this.vault.all<Approval>("approvals").some(a => a.status === "executing"))
          throw new Error("Pause sync and wait for active jobs before restoring.");
        const path = await this.host.restorePath();
        if (!path) return { message: "Restore cancelled." };
        if (this.browserDownloads.running || this.browserCaptures || this.activeJobs.size || this.controllers.size || this.aiBusy || this.vault.all<Approval>("approvals").some(a => a.status === "executing"))
          throw new Error("Pause sync and wait for active jobs before restoring.");
        this.productivity.pauseReview();
        this.documentAccessRevision++;
        this.restoring = true;
        try {
          try { await this.vault.restore(path); }
          finally {
            this.productivity.pauseReview();
            this.chat.recover(true);
            await this.browser?.revoke();
            // Cleanup can fail after the backup is installed; never replay its work.
            const settings = { ...this.settings(), syncPaused: true, backgroundAi: false };
            this.vault.put("settings", "preferences", settings);
            for (const job of this.vault.all<Job>("jobs"))
              if (job.status === "running" || job.status === "pending")
                this.vault.put("jobs", job.id, { ...job, status: "paused", detail: "Restore attempted. Retry to reconcile before resuming.", updatedAt: now() });
            for (const approval of this.vault.all<Approval>("approvals"))
              if (approval.status === "executing" || approval.status === "pending")
                this.vault.put("approvals", approval.id, { ...approval, status: "uncertain", error: "Restore attempted; previous approvals cannot be replayed. Inspect the provider calendar and create a new proposal." });
            this.host.settingsChanged(settings);
            await this.retrieval.configure(settings.semanticEnabled, settings.embeddingModel);
          }
          return { message: "Archive restored with automation paused. Review accounts and source selections before resuming." };
        } catch (error) {
          throw new Error(`${safeError(error)} Automation remains paused; review the archive before resuming.`, { cause: error });
        } finally {
          this.restoring = false;
          this.host.changed();
        }
      }
    }
  }
  async stop(): Promise<void> {
    await this.playwrightMail?.close();
    this.stopped = true;
    this.browserDownloads.permissionsChanged();
    this.productivity.pauseReview();
    await this.browser?.stop();
    await this.mailArchive.settled();
    await this.browserDownloads.settled();
    await this.chat.stop();
    await this.browserCaptureTail;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    this.attachmentController?.controller.abort();
    await this.copilot.stop();
    await this.productivity.review.settled();
  }
}
