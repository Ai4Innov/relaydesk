import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse } from "node:path";
import type { Account, Attachment, Collection, Message, Source } from "../../shared/contracts";
import { browserAccountId, browserAttachmentId } from "../browser/archive";
import type { AttachmentInput, AttachmentProcessor } from "./index";
import { attachmentFormat } from "./policy";
import { mailOriginAllowed } from "../../shared/mail-transport";

interface ImportVault {
  get<T>(collection: Collection, id: string): T | undefined;
}

export function browserAttachmentGuard(vault: ImportVault, attachmentId: string, unavailable: () => boolean): () => Attachment {
  let original: Attachment | undefined;
  let sourceId: string | undefined;
  let messageOrigin: Message["gmailApi"];
  return () => {
    const attachment = vault.get<Attachment>("attachments", attachmentId);
    const account = attachment && vault.get<Account>("accounts", attachment.accountId);
    const message = attachment && vault.get<Message>("messages", attachment.messageId);
    const source = message && vault.get<Source>("sources", message.sourceId);
    const matchedProvider = attachment?.browser?.source === "browser_gmail" && account?.provider === "gmail" && source?.kind === "mail"
      || attachment?.browser?.source === "browser_whatsapp" && account?.provider === "whatsapp" && source?.kind === "channel";
    if (unavailable() || !attachment?.browser || !matchedProvider
      || !account || account.connection !== "browser" || account.demo
      || account.status !== "connected" || !account.consent || !message || message.deleted
      || message.accountId !== account.id || message.browser?.completeness !== "full"
      || !source || source.accountId !== account.id || !source.selected
      || !mailOriginAllowed(vault, message)
      || !mailOriginAllowed(vault, { ...message, gmailApi: attachment.gmailApi }))
      throw new Error("Browser attachment import requires a connected, permitted account and selected full-message source.");
    if (account.provider === "whatsapp" && (!/^\+[1-9]\d{6,14}$/.test(account.email)
      || account.id !== browserAccountId(account.email, "whatsapp")
      || !/^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/.test(source.providerId)
      || source.id !== `${account.id}:chat:${encodeURIComponent(source.providerId)}`
      || message.threadId !== `${account.id}:thread:${encodeURIComponent(source.providerId)}`
      || !["true", "false"].some(prefix => message.providerId.startsWith(`${prefix}_${source.providerId}_`))))
      throw new Error("WhatsApp attachment provenance does not match its verified account and selected conversation.");
    if (attachment.id !== browserAttachmentId(account.id, message.id, {
      id: attachment.browser.metadataId, name: attachment.name, mimeType: attachment.mimeType
    }) || attachment.providerId !== attachment.browser.metadataId)
      throw new Error("Browser attachment provenance does not match its registered metadata.");
    if (original && (attachment.accountId !== original.accountId || attachment.messageId !== original.messageId
      || attachment.name !== original.name || attachment.mimeType !== original.mimeType
      || attachment.browser.source !== original.browser?.source
      || attachment.browser.metadataId !== original.browser?.metadataId || message.sourceId !== sourceId
      || JSON.stringify(attachment.gmailApi) !== JSON.stringify(original.gmailApi)
      || JSON.stringify(message.gmailApi) !== JSON.stringify(messageOrigin)))
      throw new Error("Browser attachment metadata changed. Select the attachment again.");
    if (!original) messageOrigin = message.gmailApi;
    original ??= attachment;
    sourceId ??= message.sourceId;
    return attachment;
  };
}

/**
 * macOS links /var, /tmp and /etc into /private. A root-owned ancestor link cannot be created or
 * swapped by the signed-in user, so it is not a redirection risk; user-owned links are still rejected.
 */
function systemAncestorLink(stat: { uid: number }, ancestor: boolean): boolean {
  return ancestor && process.platform !== "win32" && stat.uid === 0;
}

export async function regularLocalFile(path: string, directory = false): Promise<void> {
  if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//")
    || path.slice(parse(path).root.length).includes(":"))
    throw new Error("Choose a regular local downloaded file, not a network path or alternate data stream.");
  let current = path;
  while (true) {
    const stat = await lstat(current);
    if ((stat.isSymbolicLink() && !systemAncestorLink(stat, current !== path))
      || (!stat.isSymbolicLink() && (current === path && !directory ? !stat.isFile() : !stat.isDirectory())))
      throw new Error("Symbolic links and non-regular files cannot be imported.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** The picker is provided only by the main-process host; no IPC-supplied paths are accepted. */
export async function pickBrowserAttachment(
  validate: () => Attachment, picker: () => Promise<string | undefined>, signal: AbortSignal, owned = false
): Promise<(AttachmentInput & { close(): Promise<void>; removeOwned(): Promise<void> }) | undefined> {
  const original = validate();
  signal.throwIfAborted();
  if (!attachmentFormat(original)) throw new Error("This attachment type is not supported. Scripts, executables and macros cannot be imported.");
  const path = await picker();
  validate();
  signal.throwIfAborted();
  if (!path) return;
  const validateName = () => {
    const current = validate();
    if (basename(path) !== original.name || basename(path) !== current.name)
      throw new Error("The selected filename does not match this attachment. Download the original in its source app and select its matching downloaded copy.");
  };
  validateName();
  await regularLocalFile(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat();
    const pathStat = await lstat(path);
    if (!initial.isFile() || pathStat.isSymbolicLink() || initial.ino !== pathStat.ino || initial.dev !== pathStat.dev)
      throw new Error("The downloaded file changed while opening. Select a regular file again.");
    if (owned && initial.nlink !== 1) throw new Error("An owned download cannot be a hard link to another file.");
    if (!Number.isSafeInteger(initial.size) || initial.size < 0)
      throw new Error("The downloaded file exceeds the supported size range.");
    validateName();
    signal.throwIfAborted();
    const file = handle;
    const unchanged = async () => {
      validateName();
      signal.throwIfAborted();
      await regularLocalFile(path);
      const current = await file.stat(), named = await lstat(path);
      if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs
        || named.ino !== initial.ino || named.dev !== initial.dev || (owned && (current.nlink !== 1 || named.nlink !== 1)))
        throw new Error("The downloaded file changed during import. Select the original downloaded copy again.");
      validateName();
      signal.throwIfAborted();
    };
    return {
      size: initial.size, validate: validateName, close: () => file.close(),
      async removeOwned() {
        // Only the automatic downloader calls this, for its freshly created private job directory.
        await regularLocalFile(path);
        const current = await lstat(path);
        if (current.ino !== initial.ino || current.dev !== initial.dev || current.size !== initial.size
          || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs || current.nlink !== 1)
          throw new Error("The staged download changed; automatic cleanup refused.");
        await unlink(path);
      },
      async open(processingSignal) {
        await unchanged();
        let position = 0;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              processingSignal.throwIfAborted();
              validateName();
              const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, initial.size - position)));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
              processingSignal.throwIfAborted();
              validateName();
              if (!bytesRead) { await unchanged(); controller.close(); return; }
              position += bytesRead;
              if (position > initial.size) throw new Error("Downloaded file grew during import.");
              controller.enqueue(buffer.subarray(0, bytesRead));
            } catch (error) { controller.error(error); }
          }
        }, { highWaterMark: 0 });
      }
    };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

export async function importBrowserAttachment(
  vault: ImportVault, processor: AttachmentProcessor, attachmentId: string, approved: boolean,
  picker: () => Promise<string | undefined>, signal: AbortSignal, unavailable: () => boolean
): Promise<{ message: string }> {
  const validate = browserAttachmentGuard(vault, attachmentId, unavailable);
  const attachment = validate();
  if (attachment.hash) throw new Error("This attachment is already retained encrypted. Use processing retry instead of importing another copy.");
  const input = await pickBrowserAttachment(validate, picker, signal);
  if (!input) return { message: "File selection cancelled. No attachment was imported." };
  try {
    await processor.process(attachmentId, approved, signal, input);
    validate();
    return { message: vault.get<Attachment>("attachments", attachmentId)?.reason || "Downloaded attachment import status updated." };
  } finally { await input.close(); }
}

export async function processRetainedBrowserAttachment(
  vault: ImportVault, processor: AttachmentProcessor, attachmentId: string, approved: boolean,
  signal: AbortSignal, unavailable: () => boolean
): Promise<void> {
  const validate = browserAttachmentGuard(vault, attachmentId, unavailable);
  if (!validate().hash) throw new Error("Use Download attachment for Gmail, or choose Import downloaded file for a manual fallback.");
  await processor.process(attachmentId, approved, signal, {
    validate,
    async open() { throw new Error("Browser attachments cannot be downloaded through an API connection."); }
  });
  validate();
}
