import type { Attachment } from "../../shared/contracts";

export type Format = "text" | "csv" | "pdf" | "docx" | "xlsx" | "pptx" | "image" | "zip" | "media";
const extensions: Record<string, Format> = {
  txt: "text", csv: "csv", pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx",
  png: "image", jpg: "image", jpeg: "image", webp: "image", bmp: "image", tif: "image", tiff: "image",
  zip: "zip", wav: "media", mp3: "media", m4a: "media", ogg: "media", flac: "media",
  mp4: "media", mov: "media", webm: "media", mkv: "media", avi: "media",
};
const mimeTypes: Record<string, Format> = {
  "text/plain": "text", "text/csv": "csv", "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip", "application/x-zip-compressed": "zip",
};
export function attachmentFormat(attachment: Pick<Attachment, "name" | "mimeType">): Format | undefined {
  const extension = attachment.name.split(".").pop()?.toLowerCase() ?? "";
  // Never let a benign MIME label turn an executable/macro-enabled file into a document.
  if (/^(exe|dll|com|bat|cmd|ps1|js|vbs|hta|msi|scr|lnk|url|html?|svg|docm|xlsm|pptm|xlsb)$/.test(extension)) return;
  if (extensions[extension]) return extensions[extension];
  return mimeTypes[attachment.mimeType.toLowerCase().split(";")[0].trim()];
}
export function approvalLimit(thresholdMb: number): number {
  return Math.min(25, Number.isFinite(thresholdMb) && thresholdMb > 0 ? thresholdMb : 25) * 1024 * 1024;
}
export function approvalReason(attachment: Attachment, thresholdMb: number): string | undefined {
  if (attachment.size === undefined || !Number.isSafeInteger(attachment.size) || attachment.size < 0)
    return "The download size is unknown; approval is required before downloading.";
  if (attachment.size > approvalLimit(thresholdMb))
    return "The attachment exceeds the download approval threshold.";
  const format = attachmentFormat(attachment);
  if (format === "zip" || format === "media" || format === "image")
    return "Archive extraction, OCR and media transcription require explicit processing approval.";
}
