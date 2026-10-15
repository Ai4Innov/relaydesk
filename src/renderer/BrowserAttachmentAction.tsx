import React from "react";
import type { Attachment, Command, CommandResult } from "../shared/contracts";

export function BrowserAttachmentAction({ attachment, busy, run }: {
  attachment: Attachment;
  busy: boolean;
  run: (command: Command, success?: string) => Promise<CommandResult | undefined>;
}) {
  const retained = Boolean(attachment.hash);
  const gmail = attachment.browser?.source === "browser_gmail";
  const provider = attachment.browser?.source === "browser_whatsapp" ? "WhatsApp" : "Gmail";
  const actionable = ["pending", "awaiting-approval", "failed", "cancelled", "blocked", "partial"].includes(attachment.status);
  if (!actionable) return null;
  return <div className="attachment-details">
    {!retained && <p className="caption">{gmail
      ? "The file is not stored locally yet. Selected Gmail attachments download automatically, then supported text is indexed for local search and AI retrieval. Approval is required for unknown-size, large, or costly files."
      : `Metadata only. Download the original attachment in ${provider}, then select the matching downloaded copy here. The app does not download it automatically.`} Imports are encrypted; size approval and extraction safety limits still apply.</p>}
    {!retained && gmail && <button className="secondary small" disabled={busy} onClick={() => void run({
      type: "attachment.download", attachmentId: attachment.id,
      approved: attachment.approved === true || attachment.status === "awaiting-approval"
    })}>{attachment.status === "awaiting-approval" ? "Approve download and indexing" : "Download and index"}</button>}
    <button className="secondary small" disabled={busy} onClick={() => void run({
      type: retained ? "attachment.process" : "attachment.import", attachmentId: attachment.id,
      approved: retained || attachment.status === "awaiting-approval"
    })}>{retained ? attachment.status === "awaiting-approval" ? "Approve processing" : "Retry processing"
      : attachment.status === "awaiting-approval" ? "Approve and import downloaded file" : "Import downloaded file"}</button>
  </div>;
}
