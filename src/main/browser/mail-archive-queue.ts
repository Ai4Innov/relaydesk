import type { Account, FullMailArchive, Message, Source } from "../../shared/contracts";
import { BrowserMailReader, type MailVault } from "./mail-reader";

interface Attempt {
  kind: "browser-full-mail";
  accountId: string;
  threadId: string;
  state: "running" | "failed" | "complete" | "queued";
  attempts: number;
  nextRetryAt?: string;
  error?: string;
}
interface Hooks {
  enabled(): boolean;
  paused(): boolean;
  maintenance(): boolean;
  paired(): boolean;
  changed(): void;
  error(error: unknown): string;
  now?(): number;
}
interface Thread {
  message: Message;
  complete: boolean;
  attempt?: Attempt;
}
const key = (threadId: string) => `browser-full-mail:${threadId}`;
const retryDelay = (attempts: number) => Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.min(3, attempts - 1));

/** Local-only, serial Gmail viewing. The whole-thread reader checkpoint is the sole completion proof. */
export class BrowserMailArchiveQueue {
  private active?: { accountId: string; threadId: string };
  private work?: Promise<void>;
  private lastAccountId?: string;
  private published = "";
  private revision = 0;
  private clock: () => number;

  constructor(private vault: MailVault, private reader: BrowserMailReader | undefined, private hooks: Hooks) {
    this.clock = hooks.now ?? Date.now;
  }

  private threads(): Thread[] {
    const accounts = new Set(this.vault.all<Account>("accounts").filter(account => account.provider === "gmail"
      && account.connection === "browser" && account.consent && account.status === "connected" && !account.demo).map(account => account.id));
    const sources = new Map(this.vault.all<Source>("sources").filter(source =>
      source.selected && source.kind === "mail" && accounts.has(source.accountId)).map(source => [source.id, source]));
    const groups = new Map<string, Message[]>();
    for (const message of this.vault.all<Message>("messages")) {
      if (message.deleted || !message.browser || !accounts.has(message.accountId)
        || sources.get(message.sourceId)?.accountId !== message.accountId) continue;
      const id = JSON.stringify([message.accountId, message.threadId]);
      const members = groups.get(id) ?? [];
      members.push(message);
      groups.set(id, members);
    }
    return [...groups.values()].map(members => {
      const message = members.find(item => item.browser?.completeness === "preview") ?? members[0];
      return { message, complete: this.reader?.hasCachedThread(message, members) ?? false,
        attempt: this.vault.get<Attempt>("checkpoints", key(message.threadId)) };
    });
  }

  status(): FullMailArchive {
    const threads = this.threads(), incomplete = threads.filter(thread => !thread.complete);
    const failed = incomplete.filter(thread => thread.attempt?.state === "failed"
      || (thread.attempt?.state === "running" && thread.message.threadId !== this.active?.threadId));
    const retry = failed.map(thread => thread.attempt?.nextRetryAt).filter((at): at is string => !!at).sort()[0];
    const error = failed.find(thread => thread.attempt?.error)?.attempt?.error
      ?? (failed.length ? "A full email download was interrupted. It will retry automatically." : undefined);
    return { enabled: this.hooks.enabled(), running: !!this.active,
      queued: incomplete.length - failed.length, complete: threads.length - incomplete.length,
      failed: failed.length, total: threads.length,
      ...(this.active ? { currentAccountId: this.active.accountId } : {}),
      ...(error ? { lastError: error } : incomplete.length && (!this.reader || !this.hooks.paired())
        ? { lastError: "Pair the browser companion to download captured Gmail conversations." } : {}),
      ...(retry ? { nextRetryAt: retry } : {}) };
  }

  private publish(): void {
    const status = this.status(), serialized = JSON.stringify(status);
    if (serialized === this.published) return;
    this.published = serialized;
    this.vault.put("checkpoints", "browser-full-mail:coverage", status);
    this.hooks.changed();
  }

  /** Invalidate an in-flight automatic read without cancelling unrelated foreground reads. */
  permissionsChanged(): void { this.revision++; }

  retry(): void {
    for (const thread of this.threads()) {
      if (thread.complete || thread.message.threadId === this.active?.threadId || !thread.attempt) continue;
      this.vault.put("checkpoints", key(thread.message.threadId), {
        kind: "browser-full-mail", accountId: thread.message.accountId, threadId: thread.message.threadId,
        state: "queued", attempts: 0
      } satisfies Attempt);
    }
    this.tick();
  }

  tick(): void {
    this.publish();
    if (this.active || !this.reader?.backgroundAvailable || !this.hooks.enabled() || this.hooks.paused()
      || this.hooks.maintenance() || !this.hooks.paired()) return;
    const ready = this.threads().filter(thread => !thread.complete
      && (!thread.attempt?.nextRetryAt || !Number.isFinite(Date.parse(thread.attempt.nextRetryAt))
        || Date.parse(thread.attempt.nextRetryAt) <= this.clock()));
    const accountIds = [...new Set(ready.map(thread => thread.message.accountId))].sort();
    const nextAccount = accountIds.find(id => id > (this.lastAccountId ?? "")) ?? accountIds[0];
    const next = ready.find(thread => thread.message.accountId === nextAccount);
    if (!next) return;
    const { message } = next, revision = this.revision;
    this.active = { accountId: message.accountId, threadId: message.threadId };
    this.lastAccountId = message.accountId;
    const attempts = Math.min(4, (next.attempt?.attempts ?? 0) + 1);
    const record: Attempt = { kind: "browser-full-mail", ...this.active, state: "running", attempts,
      nextRetryAt: new Date(this.clock() + retryDelay(attempts)).toISOString() };
    this.vault.put("checkpoints", key(message.threadId), record);
    this.publish();
    const guard = () => {
      if (revision !== this.revision || !this.hooks.enabled() || this.hooks.paused()
        || this.hooks.maintenance() || !this.hooks.paired())
        throw new Error("Automatic full email download was paused or its local access changed.");
    };
    this.work = (async () => {
      try {
        // Force repair when a cache is incomplete, rather than accepting an isolated full message.
        await this.reader!.load(message.id, true, { background: true, beforeRead: guard });
        guard();
        this.vault.put("checkpoints", key(message.threadId), { ...record, state: "complete", attempts: 0,
          nextRetryAt: undefined } satisfies Attempt);
      } catch (error) {
        this.vault.put("checkpoints", key(message.threadId), { ...record, state: "failed",
          nextRetryAt: new Date(this.clock() + retryDelay(attempts)).toISOString(), error: this.hooks.error(error) } satisfies Attempt);
      } finally {
        this.active = undefined;
        this.publish();
      }
    })();
  }

  async settled(): Promise<void> { await this.work; }
}
