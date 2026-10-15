import { lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, win32 } from "node:path";
import type { Account, Attachment, AttachmentSave, AttachmentView, Collection, Message, Source } from "../../shared/contracts";
import type { IndexChunk } from "../storage/vault";
import { mailOriginAllowed } from "../../shared/mail-transport";

export const VIEW_BYTES_MAX = 12 * 1024 * 1024;
export const VIEW_TEXT_MAX = 200_000;
export const SAVE_BYTES_MAX = 128 * 1024 * 1024;
interface ViewingVault {
  get<T>(collection: Collection, id: string): T | undefined;
  readBlob(id: string, maxBytes?: number): Promise<Buffer>;
  localDocumentChunks(documentId: string, offset?: number, limit?: number): IndexChunk[];
}
type Guard = () => Attachment;

export function safeAttachmentName(name: string): string {
  let safe = win32.basename(name.replace(/\//g, "\\"))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/[. ]+$/g, "").slice(0, 180).replace(/[. ]+$/g, "");
  if (!safe || safe === "." || safe === "..") safe = "attachment";
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

export function attachmentViewGuard(vault: ViewingVault, id: string, unavailable: () => boolean): Guard {
  let identity: string | undefined;
  return () => {
    const attachment = vault.get<Attachment>("attachments", id);
    const account = attachment && vault.get<Account>("accounts", attachment.accountId);
    const message = attachment && vault.get<Message>("messages", attachment.messageId);
    const source = message && vault.get<Source>("sources", message.sourceId);
    if (unavailable() || !attachment || !account || account.status !== "connected" || !account.consent
      || !message || message.deleted || message.accountId !== account.id
      || !source || source.accountId !== account.id || !source.selected
      || !mailOriginAllowed(vault, message)
      || !mailOriginAllowed(vault, { ...message, gmailApi: attachment.gmailApi }))
      throw new Error("Document access requires a connected, permitted account and a selected message source. Access may have been revoked.");
    const current = JSON.stringify([attachment.accountId, attachment.messageId, attachment.providerId,
      attachment.name, attachment.mimeType, attachment.hash, attachment.size, attachment.gmailApi,
      message.sourceId, message.revision, message.gmailApi]);
    if (identity !== undefined && current !== identity)
      throw new Error("Document metadata changed. Select the attachment again.");
    identity = current;
    return attachment;
  };
}

function missingOriginal(attachment: Attachment): string {
  return attachment.browser
    ? `Download the original in ${attachment.browser.source === "browser_whatsapp" ? "WhatsApp" : "Gmail"}, then choose Import downloaded file in Relay Desk.`
    : "Download/process this attachment first. Any required file-size approval still applies.";
}

function extractedText(vault: ViewingVault, validate: Guard): { text: string; truncated: boolean } {
  const attachment = validate();
  let text = "";
  for (let offset = 0; offset < 600; offset += 6) {
    const chunks = vault.localDocumentChunks(`attachment:${attachment.id}`, offset, 6);
    for (const chunk of chunks) {
      if (chunk.attachmentId !== attachment.id || chunk.accountId !== attachment.accountId
        || chunk.messageId !== attachment.messageId) continue;
      const remaining = VIEW_TEXT_MAX - text.length;
      const part = `${text ? "\n\n" : ""}${chunk.location ? `${chunk.location.slice(0, 200)}\n` : ""}${chunk.text}`;
      text += part.slice(0, remaining);
      if (part.length >= remaining) { validate(); return { text, truncated: true }; }
    }
    if (chunks.length < 6) { validate(); return { text, truncated: false }; }
  }
  validate();
  return { text, truncated: true };
}

function rasterMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function boundedRaster(bytes: Buffer, mime: string): boolean {
  const bounded = (width: number, height: number) => width > 0 && height > 0
    && width <= 16_384 && height <= 16_384 && width * height <= 16_000_000;
  try {
    if (mime === "image/png") return bytes.toString("ascii", 12, 16) === "IHDR" && bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    if (mime === "image/gif") return bounded(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    if (mime === "image/webp") {
      const type = bytes.toString("ascii", 12, 16);
      if (type === "VP8X") return bounded(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
      if (type === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return bounded((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (type === "VP8 ") return bounded(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset++] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
          return bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
        offset += length;
      }
    }
  } catch { return false; }
  return false;
}

export async function viewAttachment(vault: ViewingVault, validate: Guard): Promise<AttachmentView> {
  const attachment = validate();
  const base = { attachmentId: attachment.id, name: safeAttachmentName(attachment.name),
    mimeType: "text/plain", truncated: false, canSave: !!attachment.hash };
  const fallback = (message: string, canSave = base.canSave): AttachmentView => {
    const extracted = extractedText(vault, validate);
    return extracted.text
      ? { ...base, ...extracted, truncated: extracted.truncated || attachment.status === "partial", canSave, kind: "text",
        message: `Extracted text preview; original formatting may differ.${attachment.status === "partial" ? " Extraction is incomplete." : ""} ${message}` }
      : { ...base, canSave, kind: canSave ? "unsupported" : "unavailable", message };
  };
  if (!attachment.hash) return fallback(missingOriginal(attachment), false);
  if (attachment.size !== undefined && attachment.size > VIEW_BYTES_MAX)
    return fallback("Original exceeds the 12 MiB preview limit. Save the original to view it in another application.");
  let bytes: Buffer;
  try { bytes = await vault.readBlob(attachment.id, VIEW_BYTES_MAX); }
  catch (error) {
    validate();
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return fallback("The retained original is unavailable or exceeds the preview memory limit. Import/download it again, or try saving the original.", !missing);
  }
  try {
    validate();
    if (bytes.length > VIEW_BYTES_MAX) return fallback("Original exceeds the 12 MiB preview limit. Save the original instead.");
    const mime = attachment.mimeType.toLowerCase().split(";")[0].trim();
    const extension = win32.extname(attachment.name).toLowerCase();
    if ((mime === "application/pdf" || extension === ".pdf") && bytes.toString("ascii", 0, 5) === "%PDF-")
      return { ...base, kind: "pdf", mimeType: "application/pdf", base64: bytes.toString("base64") };
    const image = rasterMime(bytes);
    if (image && (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension))) {
      if (!boundedRaster(bytes, image)) return fallback("Image dimensions are invalid or exceed the 16-megapixel preview limit. Save the original instead.");
      return { ...base, kind: "image", mimeType: image, base64: bytes.toString("base64") };
    }
    if (mime === "text/plain" || [".txt", ".md", ".csv", ".tsv", ".log", ".json"].includes(extension)) {
      const text = bytes.toString("utf8");
      if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
        return { ...base, kind: "text", text: text.slice(0, VIEW_TEXT_MAX), truncated: text.length > VIEW_TEXT_MAX };
    }
    return fallback("No safe original preview is available for this format. Save the original if needed.");
  } finally { bytes.fill(0); }
}

async function safeDestination(path: string): Promise<void> {
  if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//")
    || path.slice(parse(path).root.length).includes(":") || basename(path) !== safeAttachmentName(basename(path)))
    throw new Error("Choose a regular local filename, not a network path, device name or alternate data stream.");
  let current = dirname(path);
  while (true) {
    const stat = await lstat(current).catch(() => { throw new Error("The selected local folder is unavailable."); });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Choose a local folder without symbolic links.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Only the trusted native host supplies a destination; the renderer supplies an attachment ID. */
export async function saveAttachment(
  vault: ViewingVault, validate: Guard, picker: (name: string) => Promise<string | undefined>
): Promise<AttachmentSave> {
  const attachment = validate();
  if (!attachment.hash) return { status: "unavailable", message: missingOriginal(attachment) };
  if (attachment.size !== undefined && attachment.size > SAVE_BYTES_MAX)
    return { status: "unavailable", message: "The original exceeds the 128 MiB local export memory limit. Download it directly from its provider." };
  const path = await picker(safeAttachmentName(attachment.name));
  validate();
  if (!path) return { status: "cancelled", message: "Save cancelled. No file was written." };
  await safeDestination(path);
  validate();
  let bytes: Buffer;
  try { bytes = await vault.readBlob(attachment.id, SAVE_BYTES_MAX); }
  catch {
    validate();
    return { status: "unavailable", message: "The retained original could not be read within the local export memory limit. Import/download it again or download directly from its provider." };
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created: { ino: number; dev: number } | undefined;
  let saved = false;
  try {
    validate();
    if (bytes.length > SAVE_BYTES_MAX) return { status: "unavailable", message: "The original exceeds the 128 MiB local export memory limit. Download it directly from its provider." };
    await safeDestination(path);
    validate();
    try { file = await open(path, "wx", 0o600); }
    catch { throw new Error("The selected file already exists or cannot be created. Choose a new filename; existing files are never overwritten."); }
    created = await file.stat();
    validate();
    for (let offset = 0; offset < bytes.length;) {
      validate();
      const result = await file.write(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      validate();
      if (!result.bytesWritten) throw new Error("The document could not be saved.");
      offset += result.bytesWritten;
    }
    await file.sync();
    validate();
    await file.close();
    file = undefined;
    validate();
    saved = true;
    return { status: "saved", name: basename(path), message: "Original attachment saved to your chosen folder." };
  } catch {
    validate();
    throw new Error("The document could not be saved. Choose a new filename in a writable local folder; existing files are never overwritten.");
  } finally {
    bytes.fill(0);
    if (file) await file.close().catch(() => {});
    if (!saved && created) {
      const current = await lstat(path).catch(() => undefined);
      if (current?.ino === created.ino && current.dev === created.dev) await unlink(path).catch(() => {});
    }
  }
}
