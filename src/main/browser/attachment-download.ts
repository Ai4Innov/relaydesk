import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { Account, Attachment, Message, Source } from "../../shared/contracts";
import type { BrowserCapture } from "../../shared/browser";
import type { BrowserMailRequest } from "../../shared/browser-mail";
import { browserAccountId } from "./archive";
import type { BrowserMailReader, MailVault } from "./mail-reader";
import { browserAttachmentGuard, pickBrowserAttachment, regularLocalFile } from "../attachments/browser-import";
import type { AttachmentProcessor } from "../attachments";
import { approvalLimit, approvalReason, attachmentFormat } from "../attachments/policy";

interface Bridge {
  readMailThread(input: BrowserMailRequest, guard: () => void): Promise<BrowserCapture>;
}
interface Hooks {
  downloadsDirectory?: string;
  enabled(): boolean;
  unavailable(): boolean;
  revision(): number;
  thresholdMb(): number;
  autoApprove?(): boolean;
  changed(): void;
  now?(): number;
}
interface Attempt {
  kind: "browser-attachment-download";
  attachmentId: string;
  state: "running" | "failed" | "complete";
  attempts: number;
  nextRetryAt?: number;
  relativePath?: string;
  bytes?: number;
}
interface MetadataAttempt {
  accountId: string;
  threadId: string;
  state: "running" | "failed" | "complete";
  nextRetryAt: number;
}
const key = (id: string) => `browser-attachment-download:${id}`;
const MAX_APPROVED_BYTES = 512 * 1024 * 1024;
const safeName = (name: string) => name.length <= 200 && name !== "." && name !== ".."
  && !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) && !/[. ]$/.test(name)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);

/** One native Gmail download at a time, sharing the full-mail reader's serialized tab path. */
export class BrowserAttachmentDownloads {
  private work?: Promise<void>;
  private busy = false;
  private revision = 0;
  private controller?: AbortController;
  private clock: () => number;
  get running(): boolean { return this.busy; }
  constructor(private vault: MailVault, private bridge: Bridge | undefined, private reader: BrowserMailReader | undefined,
    private processor: AttachmentProcessor, private hooks: Hooks) { this.clock = hooks.now ?? Date.now; }

  permissionsChanged(): void { this.revision++; this.controller?.abort(); }
  async settled(): Promise<void> { await this.work; }

  /** After a crash, deletion of a verified owned staging copy needs no renewed ingestion consent. */
  async recoverStaging(): Promise<void> {
    if (!this.hooks.downloadsDirectory || this.busy) return;
    for (const attachment of this.vault.all<Attachment>("attachments")) {
      const attempt = this.vault.get<Attempt>("checkpoints", key(attachment.id));
      if (attachment.gmailApi || attachment.browser?.source !== "browser_gmail" || !safeName(attachment.name)
        || attempt?.kind !== "browser-attachment-download" || attempt.attachmentId !== attachment.id
        || !attempt.relativePath || !/^RelayDesk\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\//.test(attempt.relativePath)
        || attempt.relativePath.split("/").length !== 3 || attempt.relativePath.split("/")[2] !== attachment.name) continue;
      let permitted = this.hooks.enabled() && !this.hooks.unavailable();
      try { browserAttachmentGuard(this.vault, attachment.id, () => !permitted)(); } catch { permitted = false; }
      if (!attachment.hash && permitted) continue;
      const directory = join(this.hooks.downloadsDirectory, "RelayDesk", attempt.relativePath.split("/")[1]);
      const file = await pickBrowserAttachment(() => attachment, async () => join(directory, attachment.name),
        new AbortController().signal, true).catch(() => undefined);
      if (!file) continue;
      await file.close();
      try {
        await file.removeOwned();
        this.vault.put("checkpoints", key(attachment.id), { ...attempt, relativePath: undefined, bytes: undefined });
        await regularLocalFile(directory, true);
        await rmdir(directory).catch(() => {});
      } catch { /* Replaced files remain untouched; never search arbitrary browser download locations. */ }
    }
  }

  tick(): void {
    if (this.busy || !this.reader?.backgroundAvailable || !this.bridge || !this.hooks.downloadsDirectory
      || !this.hooks.enabled() || this.hooks.unavailable()) return;
    for (const attachment of this.vault.all<Attachment>("attachments")) {
      const attempt = this.vault.get<Attempt>("checkpoints", key(attachment.id));
      if (attachment.gmailApi || attachment.browser?.source !== "browser_gmail"
        || (["indexed", "partial", "unsupported", "blocked", ...(this.hooks.autoApprove?.() ? [] : ["awaiting-approval"])].includes(attachment.status)
          && !(attachment.hash && attempt?.relativePath))) continue;
      if (attempt?.nextRetryAt && attempt.nextRetryAt > this.clock()) continue;
      try { browserAttachmentGuard(this.vault, attachment.id, this.hooks.unavailable)(); } catch { continue; }
      this.work = this.download(attachment.id, false, true).catch(() => {});
      return;
    }
    const legacy = this.vault.all<Message>("messages").find(message => {
      if (message.deleted || message.gmailApi || message.browser?.completeness !== "full" || message.browser.attachmentManifestVersion === 1) return false;
      const account = this.vault.get<Account>("accounts", message.accountId);
      const source = this.vault.get<Source>("sources", message.sourceId);
      const attempt = this.vault.get<MetadataAttempt>("checkpoints", `browser-attachment-metadata:${message.threadId}`);
      return account?.provider === "gmail" && account.connection === "browser" && account.status === "connected"
        && account.consent && !account.demo && source?.selected && source.kind === "mail" && source.accountId === account.id
        && (!attempt || attempt.nextRetryAt <= this.clock());
    });
    if (legacy) this.work = this.refreshMetadata(legacy).catch(() => {});
  }

  private async refreshMetadata(message: Message): Promise<void> {
    this.busy = true;
    const epoch = this.hooks.revision(), revision = this.revision;
    const id = `browser-attachment-metadata:${message.threadId}`;
    const record: MetadataAttempt = { accountId: message.accountId, threadId: message.threadId,
      state: "running", nextRetryAt: this.clock() + 15 * 60_000 };
    const guard = () => {
      if (!this.hooks.enabled() || this.hooks.unavailable() || epoch !== this.hooks.revision() || revision !== this.revision)
        throw new Error("Attachment metadata refresh is no longer permitted.");
    };
    this.vault.put("checkpoints", id, record);
    try {
      await this.reader!.load(message.id, true, { background: true, beforeRead: guard });
      guard();
      const members = this.vault.all<Message>("messages").filter(item => item.accountId === message.accountId
        && item.sourceId === message.sourceId && item.threadId === message.threadId && !item.deleted
        && item.browser?.completeness === "full");
      if (!members.length || members.some(item => item.browser?.attachmentManifestVersion !== 1))
        throw new Error("The companion did not verify attachment metadata. Update it and refresh this full conversation.");
      this.vault.put("checkpoints", id, { ...record, state: "complete" } satisfies MetadataAttempt);
    } catch (error) {
      if (this.vault.get<Message>("messages", message.id))
        this.vault.put("checkpoints", id, { ...record, state: "failed",
          error: error instanceof Error ? error.message : "Attachment metadata refresh failed." });
      throw error;
    } finally { this.busy = false; this.hooks.changed(); }
  }

  async download(attachmentId: string, approved: boolean, automatic = false): Promise<void> {
    if (this.busy) throw new Error("Another browser attachment is downloading. Wait for it to finish.");
    if (!this.reader || !this.bridge || !this.hooks.downloadsDirectory)
      throw new Error("Automatic Gmail downloads need the paired updated companion and the local Downloads folder.");
    this.busy = true;
    this.controller = new AbortController();
    const work = this.perform(attachmentId, approved, automatic);
    this.work = work.catch(() => {});
    try { await work; }
    catch (error) {
      const previous = this.vault.get<Attempt>("checkpoints", key(attachmentId));
      if (this.vault.get("attachments", attachmentId) && (!previous?.nextRetryAt || previous.nextRetryAt <= this.clock())) {
        this.vault.put("checkpoints", key(attachmentId), {
          ...previous, kind: "browser-attachment-download", attachmentId, state: "failed",
          attempts: Math.min(4, (previous?.attempts ?? 0) + 1), nextRetryAt: this.clock() + 5 * 60_000
        } satisfies Attempt);
      }
      throw error;
    }
    finally { this.busy = false; this.controller = undefined; }
  }

  private async perform(attachmentId: string, approved: boolean, automatic: boolean): Promise<void> {
    approved ||= this.hooks.autoApprove?.() === true;
    const epoch = this.hooks.revision(), revision = this.revision;
    const unavailable = () => this.hooks.unavailable() || epoch !== this.hooks.revision()
      || revision !== this.revision || this.controller!.signal.aborted || (automatic && !this.hooks.enabled());
    const validate = browserAttachmentGuard(this.vault, attachmentId, unavailable);
    const original = validate();
    const message = this.vault.get<Message>("messages", original.messageId)!;
    const account = this.vault.get<Account>("accounts", original.accountId)!;
    const prefix = `${account.id}:thread:`;
    const threadId = message.threadId.startsWith(prefix) ? decodeURIComponent(message.threadId.slice(prefix.length)) : "";
    const guard = () => {
      const current = validate(), parent = this.vault.get<Message>("messages", original.messageId);
      const owner = this.vault.get<Account>("accounts", original.accountId);
      const source = parent && this.vault.get<Source>("sources", parent.sourceId);
      if (current.browser?.source !== "browser_gmail" || account.id !== browserAccountId(account.email)
        || !parent || parent.providerId !== message.providerId || parent.threadId !== message.threadId
        || parent.sourceId !== `${account.id}:mail` || source?.providerId !== "mail"
        || parent.id !== `${account.id}:message:${encodeURIComponent(parent.providerId)}`
        || parent.providerId.startsWith("thread:") || !/^[A-Za-z0-9_-]{1,256}$/.test(threadId)
        || owner?.email !== account.email)
        throw new Error("Gmail attachment account, thread or exact message metadata changed.");
    };
    guard();
    const set = (status: Attachment["status"], reason: string) => {
      guard();
      this.vault.put("attachments", attachmentId, { ...validate(), status, reason });
      this.hooks.changed();
    };
    if (!attachmentFormat(original) || !safeName(original.name)) {
      set("unsupported", "This attachment type or filename cannot be downloaded safely. Executables, scripts and macros are never opened.");
      return;
    }
    const approval = approvalReason(original, this.hooks.thresholdMb());
    if (!approved && approval && !original.hash) { set("awaiting-approval", approval); return; }
    if (original.size !== undefined && original.size > MAX_APPROVED_BYTES) {
      set("blocked", "Automatic browser downloads are limited to 512 MiB, even with approval. Download a smaller export.");
      return;
    }
    const maxBytes = approved ? MAX_APPROVED_BYTES : approvalLimit(this.hooks.thresholdMb());
    const previous = this.vault.get<Attempt>("checkpoints", key(attachmentId));
    const attempts = Math.min(4, (previous?.attempts ?? 0) + 1);
    const attempt: Attempt = { kind: "browser-attachment-download", attachmentId, attempts, state: "running",
      nextRetryAt: this.clock() + Math.min(30 * 60_000, 60_000 * 2 ** attempts) };
    const previousOwned = previous?.relativePath
      && /^RelayDesk\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\//.test(previous.relativePath)
      && previous.relativePath.split("/").length === 3 && previous.relativePath.split("/")[2] === original.name;
    let input: Awaited<ReturnType<typeof pickBrowserAttachment>>;
    let directory = previousOwned ? join(this.hooks.downloadsDirectory!, "RelayDesk", previous!.relativePath!.split("/")[1]) : undefined;
    try {
      if (original.hash) {
        if (previousOwned) { attempt.relativePath = previous!.relativePath; attempt.bytes = previous!.bytes; }
        await this.processor.process(attachmentId, approved || original.approved === true, this.controller!.signal, {
          validate: guard, async open() { throw new Error("Retained browser bytes never use provider API credentials."); }
        });
        guard();
        const status = this.vault.get<Attachment>("attachments", attachmentId)?.status;
        if (status === "failed" || status === "cancelled" || status === "extracting" || status === "downloading")
          throw new Error("Retained attachment processing was interrupted; it will retry locally.");
        this.vault.put("checkpoints", key(attachmentId), { ...attempt, state: "complete", nextRetryAt: undefined } satisfies Attempt);
        return;
      }
      const root = join(this.hooks.downloadsDirectory!, "RelayDesk");
      await regularLocalFile(this.hooks.downloadsDirectory!, true);
      await mkdir(root, { recursive: true });
      await regularLocalFile(root, true);
      guard();
      // Completed staging proofs survive a restart; never repeat a browser download for retained bytes.
      const recovery = previousOwned && previous!.bytes !== undefined;
      let result: NonNullable<BrowserCapture["attachmentDownload"]>;
      if (recovery) {
        attempt.relativePath = previous.relativePath;
        result = { metadataId: original.browser!.metadataId, name: original.name,
          relativePath: previous.relativePath!, bytes: previous.bytes! };
        directory = join(root, previous.relativePath!.split("/")[1]);
      } else {
        if (directory) {
          const stale = await pickBrowserAttachment(() => original, async () => join(directory!, original.name),
            new AbortController().signal, true).catch(() => undefined);
          if (stale) { await stale.close(); await stale.removeOwned(); }
          await rmdir(directory).catch(() => {});
        }
        const jobId = randomUUID();
        directory = join(root, jobId);
        await mkdir(directory);
        await regularLocalFile(directory, true);
        const relativePath = `RelayDesk/${jobId}/${original.name}`;
        attempt.relativePath = relativePath;
        this.vault.put("checkpoints", key(attachmentId), attempt);
        set("downloading", "Downloading the exact Gmail attachment into an owned local staging folder; encryption and local text extraction follow.");
        const capture = await this.reader!.exclusive(() => this.bridge!.readMailThread({
          accountId: account.id, accountEmail: account.email, threadId, messageProviderId: message.providerId,
          attachment: { metadataId: original.browser!.metadataId, name: original.name, maxBytes, relativePath, approved,
            ...(approved ? { allowUnknownSize: true } : {}) }
        }, guard));
        guard();
        const metadata = capture.messages.find(item => item.id === message.providerId)?.attachments
          ?.find(item => item.id === original.browser!.metadataId);
        if (capture.kind !== "mail" || capture.accountEmail.toLowerCase() !== account.email.toLowerCase()
          || capture.meetings.length || !capture.messages.length || capture.messages.some(item =>
            item.threadId !== threadId || item.completeness !== "full") || !metadata || metadata.name !== original.name
          || metadata.mimeType !== original.mimeType || !capture.attachmentDownload)
          throw new Error("The browser returned a different attachment or message.");
        result = capture.attachmentDownload;
      }
      if (result.relativePath !== attempt.relativePath || result.name !== original.name
        || result.metadataId !== original.browser!.metadataId || !Number.isSafeInteger(result.bytes)
        || result.bytes < 0 || result.bytes > maxBytes)
        throw new Error("The attachment completion did not match the owned download request.");
      attempt.bytes = result.bytes;
      this.vault.put("checkpoints", key(attachmentId), attempt);
      const signal = this.controller!.signal;
      input = await pickBrowserAttachment(() => { guard(); return validate(); }, async () => join(directory!, original.name), signal, true);
      if (!input || input.size !== result.bytes) throw new Error("The completed browser file size does not match its verified download.");
      guard();
      await this.processor.process(attachmentId, approved, signal, { ...input, validate: guard });
      guard();
      const retained = this.vault.get<Attachment>("attachments", attachmentId);
      if (retained && !retained.hash && ["awaiting-approval", "unsupported", "blocked"].includes(retained.status)) {
        this.vault.put("checkpoints", key(attachmentId), { ...attempt, state: "complete", nextRetryAt: undefined } satisfies Attempt);
        return;
      }
      if (!retained?.hash) throw new Error("The browser file was not retained encrypted. Retry the download.");
      if (retained.status === "failed" || retained.status === "cancelled")
        throw new Error("The original is retained encrypted but local extraction failed; it will retry without downloading again.");
      this.vault.put("checkpoints", key(attachmentId), { ...attempt, state: "complete", nextRetryAt: undefined } satisfies Attempt);
    } catch (error) {
      if (this.vault.get("attachments", attachmentId))
        this.vault.put("checkpoints", key(attachmentId), { ...attempt, state: "failed" } satisfies Attempt);
      try { set("failed", error instanceof Error ? error.message + " If the browser uses another Downloads folder, choose the system Downloads folder or import the file manually." : "Browser attachment download failed; it will retry."); }
      catch { /* Permission revocation must not rewrite removed or excluded attachment records. */ }
      throw error;
    } finally {
      if (!input && directory) {
        // Cleanup is not ingestion: revoked access must still remove only our exact regular staged file.
        input = await pickBrowserAttachment(() => original, async () => join(directory!, original.name),
          new AbortController().signal, true).catch(() => undefined);
      }
      if (input) {
        await input.close();
        try {
          await input.removeOwned();
          const record = this.vault.get<Attempt>("checkpoints", key(attachmentId));
          if (record) this.vault.put("checkpoints", key(attachmentId), { ...record, relativePath: undefined, bytes: undefined });
          if (directory) {
            await regularLocalFile(directory, true);
            await rmdir(directory).catch(() => {});
          }
        } catch {
          const record = this.vault.get<Attempt>("checkpoints", key(attachmentId));
          if (record) this.vault.put("checkpoints", key(attachmentId), { ...record, nextRetryAt: attempt.nextRetryAt });
          try {
            const current = validate();
            const notice = "The owned staging copy could not be removed safely. Check the browser Downloads folder.";
            if (!current.reason?.includes(notice))
              set(current.status, [current.reason, notice].filter(Boolean).join(" "));
          } catch { /* Do not rewrite revoked metadata or delete a replaced file. */ }
        }
      } else if (directory) {
        try {
          await regularLocalFile(directory, true);
          await rmdir(directory);
          const record = this.vault.get<Attempt>("checkpoints", key(attachmentId));
          if (record) this.vault.put("checkpoints", key(attachmentId), { ...record, relativePath: undefined, bytes: undefined });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            const record = this.vault.get<Attempt>("checkpoints", key(attachmentId));
            if (record) this.vault.put("checkpoints", key(attachmentId), { ...record, relativePath: undefined, bytes: undefined });
          }
        }
      }
      this.hooks.changed();
    }
  }
}
