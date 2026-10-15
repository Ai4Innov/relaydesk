import { createHash } from "node:crypto";
import type { Account, Message, Source } from "../../shared/contracts";
import type { BrowserCapture } from "../../shared/browser";
import type { MailFreshnessRequest, MailFreshnessResult } from "../../shared/mail-freshness";
import type { BrowserMailReader, MailVault } from "./mail-reader";
import { GMAIL_RELAY_PROVIDER_ID } from "../connectors/gmail-relay";

interface Hooks {
  reader?: BrowserMailReader;
  transportIdentity?(accountId: string): string;
  revision(): number;
  unavailable(account?: Account): string | undefined;
  manual(): boolean;
  inbox(account: Account, guard: () => void, signal: AbortSignal): Promise<BrowserCapture>;
  capture(input: BrowserCapture, guard: () => void): Promise<unknown>;
  sync(account: Account, source: Source, signal: AbortSignal, guard: () => void): Promise<number>;
  busy(active: boolean): void;
}
interface Confirmation { checkedAt: string; revision: number; signature: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limitation = "Freshness covers the selected inbox's currently exposed recent mail and downloaded conversations, not the entire mailbox history or attachments.";

/** Never treats general capture timestamps as proof of an inbox refresh. */
export class MailFreshness {
  private confirmed = new Map<string, Confirmation>();
  private tail: Promise<unknown> = Promise.resolve();
  private lastSourceId = "";
  constructor(private vault: MailVault, private hooks: Hooks) {}

  refresh(request: MailFreshnessRequest): Promise<MailFreshnessResult> {
    const work = this.tail.then(() => this.run(request));
    this.tail = work.catch(() => {});
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(request.signal.reason ?? new Error("Mail refresh cancelled."));
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
    return Promise.race([work, cancelled]).finally(() => request.signal.removeEventListener("abort", abort));
  }
  private signature(source: Source): string {
    return digest([this.hooks.transportIdentity?.(source.accountId),
      this.vault.all<Message>("messages").filter(message => message.sourceId === source.id
        && message.accountId === source.accountId && !message.deleted).map(message => [message.id, message.revision]).sort()]);
  }
  private async run(request: MailFreshnessRequest): Promise<MailFreshnessResult> {
    request.signal.throwIfAborted();
    let sources = this.vault.all<Source>("sources").filter(source => source.kind === "mail" && source.selected
      && (!request.sourceId || source.id === request.sourceId) && (!request.accountId || source.accountId === request.accountId)
      && this.vault.get<Account>("accounts", source.accountId)?.aiEnabled).sort((a, b) => a.id.localeCompare(b.id));
    const next = sources.findIndex(source => source.id > this.lastSourceId);
    if (next > 0) sources = [...sources.slice(next), ...sources.slice(0, next)];
    // The mailbox's Apps Script relay delivers complete MIME messages, so it is refreshed first;
    // browser capture of the same mailbox becomes a fallback used only when the relay is unavailable.
    const mailboxOf = (source: Source) => {
      const account = this.vault.get<Account>("accounts", source.accountId);
      return account?.provider === "gmail" ? account.email.trim().toLowerCase() : undefined;
    };
    const isRelay = (source: Source) => source.providerId === GMAIL_RELAY_PROVIDER_ID;
    const relays = new Map<string, Source>();
    for (const source of this.vault.all<Source>("sources")) {
      const mailbox = mailboxOf(source);
      if (isRelay(source) && source.kind === "mail" && source.selected && mailbox
        && this.vault.get<Account>("accounts", source.accountId)?.aiEnabled) relays.set(mailbox, source);
    }
    for (const source of [...sources]) {
      const relay = relays.get(mailboxOf(source) ?? "");
      if (relay && !isRelay(source) && !sources.some(item => item.id === relay.id)) sources.push(relay);
    }
    sources = [...sources.filter(isRelay), ...sources.filter(source => !isRelay(source))];
    const relayCovered = new Set<string>();
    const results: MailFreshnessResult["sources"] = [];
    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Inbox refresh deadline reached; remaining conversations are pending.")), 150_000);
    const revision = this.hooks.revision();
    this.hooks.busy(true);
    try {
      for (const source of sources) {
        const mailbox = mailboxOf(source);
        if (!isRelay(source) && mailbox && relayCovered.has(mailbox)) continue;
        let checkedAt: string | undefined, downloaded = 0, pending = 0;
        const failures: string[] = [];
        const guard = () => {
          controller.signal.throwIfAborted();
          const current = this.vault.get<Account>("accounts", source.accountId);
          const unavailable = this.hooks.unavailable(current);
          const selected = this.vault.get<Source>("sources", source.id);
          if (unavailable) throw new Error(unavailable);
          if (revision !== this.hooks.revision() || !current?.aiEnabled || !current.consent
            || current.status !== "connected" || current.demo || !selected?.selected
            || selected.kind !== "mail" || selected.accountId !== current.id)
            throw new Error("Mail access changed or was revoked; a connected, selected inbox with local and AI consent is required.");
        };
        const wait = async <T>(work: Promise<T>): Promise<T> => {
          let abort!: () => void;
          const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(controller.signal.reason ?? new Error("Mail refresh cancelled."));
            if (controller.signal.aborted) abort();
            else controller.signal.addEventListener("abort", abort, { once: true });
          });
          try { return await Promise.race([work, cancelled]); }
          finally { controller.signal.removeEventListener("abort", abort); }
        };
        try {
          guard();
          this.lastSourceId = source.id;
          const previous = this.confirmed.get(source.id);
          if (!request.force && previous && previous.revision === revision
            && Date.now() - Date.parse(previous.checkedAt) >= 0
            && Date.now() - Date.parse(previous.checkedAt) < 60_000 && previous.signature === this.signature(source)) {
            results.push({ accountId: source.accountId, sourceId: source.id, status: "fresh",
              checkedAt: previous.checkedAt, downloaded: 0, pending: 0 });
            continue;
          }
          this.confirmed.delete(source.id);
          if (!request.force && this.hooks.manual())
            throw new Error("Automatic refresh is disabled (manual-only). Explicitly request a refresh to check this inbox.");
          const account = this.vault.get<Account>("accounts", source.accountId)!;
          request.progress(`Refreshing ${account.name} inbox and downloading changed conversations…`);
          if (account.connection !== "browser") {
            downloaded = await wait(this.hooks.sync(account, source, controller.signal, guard));
            guard();
            checkedAt = new Date().toISOString();
          } else {
            if (account.provider !== "gmail" || !this.hooks.reader)
              throw new Error("Awaited inbox refresh is unavailable for this browser source.");
            const capture = await wait(this.hooks.inbox(account, guard, controller.signal));
            guard();
            await wait(this.hooks.capture(capture, guard));
            guard();
            checkedAt = new Date().toISOString();
            const groups = new Map<string, BrowserCapture["messages"]>();
            for (const item of capture.messages) groups.set(item.threadId, [...(groups.get(item.threadId) ?? []), item]);
            const changed = [...groups].map(([threadId, items]) => {
              const localThread = `${account.id}:thread:${encodeURIComponent(threadId)}`;
              const message = this.vault.all<Message>("messages").find(message => message.accountId === account.id
                && message.sourceId === source.id && message.threadId === localThread && !message.deleted);
              const fingerprint = digest(items.map(({ id, subject, sender, recipients, body, dateText, receivedAt }) =>
                ({ id, subject, sender, recipients, body, dateText, receivedAt })));
              const key = `mail-inbox-thread:${source.id}:${threadId}`;
              let old = this.vault.get<{ fingerprint?: string; checkedAt?: string; attemptedAt?: string }>("checkpoints", key);
              const cached = !!message && this.hooks.reader!.hasCachedThread(message);
              // Migrate only real preview revisions covered by a successful whole-thread read.
              // An attempted/failed refresh must not recover its invalidated proof this way.
              if (!old && cached && items.every(item => {
                const preview = this.vault.get<Message>("messages", `${account.id}:message:${encodeURIComponent(item.id)}`);
                return preview?.accountId === account.id && preview.sourceId === source.id
                  && preview.threadId === localThread && !preview.deleted && preview.browser?.completeness === "preview";
              })) {
                old = { fingerprint, checkedAt };
                this.vault.put("checkpoints", key, old);
              }
              // Force bypasses inbox confirmation, not matching whole-thread download proof.
              const needsRead = !message || old?.fingerprint !== fingerprint || !old.checkedAt
                || !Number.isFinite(Date.parse(old.checkedAt)) || !cached;
              return { message, fingerprint, key, needsRead, attemptedAt: old?.attemptedAt ?? old?.checkedAt ?? "" };
            }).filter(item => item.needsRead).sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt));
            pending = changed.length;
            request.progress(`Refreshed ${account.name} inbox: ${groups.size} conversations checked; ${pending} need full download.`);
            // Every source gets a bounded batch; historic archive work resumes after the interactive turn.
            for (const item of changed.slice(0, 12)) {
              guard();
              if (!item.message) throw new Error("The refreshed inbox conversation was not retained in the selected source.");
              const attemptedAt = new Date().toISOString();
              this.vault.put("checkpoints", item.key, { attemptedAt });
              try {
                await wait(this.hooks.reader.load(item.message.id, true, { beforeRead: guard, signal: controller.signal }));
                guard();
                if (!this.hooks.reader.hasCachedThread(item.message))
                  throw new Error("The inbox conversation changed while downloading; a newer full read is still pending.");
                this.vault.put("checkpoints", item.key, { fingerprint: item.fingerprint, checkedAt: new Date().toISOString(), attemptedAt });
                downloaded++;
                pending--;
                request.progress(`${account.name}: ${downloaded} of ${changed.length} conversations downloaded and indexed; ${pending} pending.`);
              } catch (error) {
                guard();
                failures.push(error instanceof Error ? error.message : "Full conversation download failed.");
              }
            }
          }
          guard();
          if (!pending) this.confirmed.set(source.id, { checkedAt: checkedAt!, revision, signature: this.signature(source) });
          if (isRelay(source) && mailbox) relayCovered.add(mailbox);
          results.push({ accountId: source.accountId, sourceId: source.id, status: pending ? "partial" : "fresh",
            checkedAt, downloaded, pending, ...(pending ? { reason: failures.length ? [...new Set(failures)].join("; ")
              : "The bounded download batch ended; more changed conversations remain." } : {}) });
        } catch (error) {
          this.confirmed.delete(source.id);
          if (request.signal.aborted) throw request.signal.reason ?? error;
          results.push({ accountId: source.accountId, sourceId: source.id, status: checkedAt ? "partial" : "unavailable",
            ...(checkedAt ? { checkedAt } : {}), downloaded, pending,
            reason: error instanceof Error ? error.message : "Inbox refresh failed." });
        }
      }
      for (const result of results) {
        const account = this.vault.get<Account>("accounts", result.accountId);
        const source = this.vault.get<Source>("sources", result.sourceId);
        const unavailable = this.hooks.unavailable(account);
        if (revision !== this.hooks.revision() || !account?.aiEnabled || !account.consent
          || account.status !== "connected" || !source?.selected || source.accountId !== result.accountId || unavailable) {
          this.confirmed.delete(result.sourceId);
          result.status = "unavailable";
          delete result.checkedAt;
          result.reason = unavailable ?? "Mail access changed or was revoked before the refresh completed.";
        } else if (result.status === "fresh" && this.confirmed.get(source.id)?.signature !== this.signature(source)) {
          this.confirmed.delete(source.id);
          result.status = "partial";
          result.reason = "The local inbox changed during refresh; newer conversations may still need downloading.";
        }
      }
      return { status: results.length && results.every(result => result.status === "fresh") ? "fresh"
        : results.some(result => result.status !== "unavailable") ? "partial" : "unavailable",
        checkedAt: new Date().toISOString(), sources: results,
        limitation: results.length ? limitation : "No selected mail source in the requested account scope permits AI access. No permissions were changed." };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      controller.abort(new Error("Mail refresh completed."));
      this.hooks.busy(false);
    }
  }
}
