import type { Command, CommandResult, Snapshot } from "../shared/contracts";

export function AttachmentArchive({ data, run, busy }: {
  data: Snapshot; busy: boolean; run: (command: Command) => Promise<CommandResult | undefined>;
}) {
  const accounts = new Set(data.accounts.filter(account => account.provider === "gmail" && account.connection === "browser"
    && account.consent && account.status === "connected").map(account => account.id));
  const attachments = data.attachments.filter(attachment => {
    if (attachment.browser?.source !== "browser_gmail" || !accounts.has(attachment.accountId)) return false;
    const message = data.messages.find(message => message.id === attachment.messageId);
    return (message ? !message.deleted : attachment.parentAvailable === true) && data.sources.some(source =>
      source.id === (message?.sourceId || attachment.sourceId) && source.accountId === attachment.accountId && source.selected);
  });
  const retained = attachments.filter(item => item.hash).length;
  const indexed = attachments.filter(item => item.status === "indexed").length;
  const partial = attachments.filter(item => item.status === "partial").length;
  const awaiting = attachments.filter(item => item.status === "awaiting-approval").length;
  const active = attachments.filter(item => ["downloading", "extracting"].includes(item.status)).length;
  const attention = attachments.filter(item => ["failed", "blocked", "unsupported", "cancelled", "encrypted"].includes(item.status)).length;
  const unchecked = data.messages.filter(message => accounts.has(message.accountId) && !message.deleted
    && message.browser?.completeness === "full" && message.browser.attachmentManifestVersion !== 1
    && data.sources.some(source => source.id === message.sourceId && source.accountId === message.accountId && source.selected)).length;
  return <section aria-label="Local email attachment archive">
    <h3>Email attachments</h3>
    <label className="check-label"><input type="checkbox" checked={data.settings.browserAttachmentDownload}
      disabled={busy} onChange={event => void run({
        type: "settings.update", patch: { browserAttachmentDownload: event.target.checked }
      })}/>Automatically download and index Gmail attachments</label>
    <p role="status">{retained} of {attachments.length} files stored locally · {indexed} indexed · {partial} partially indexed
      {" · "}{awaiting} awaiting approval · {active} in progress · {attention} need attention
      {data.settings.syncPaused || !data.settings.browserAttachmentDownload ? " · Paused" : ""}</p>
    <p className="caption">Files and extracted text are stored in your encrypted archive. Metadata alone is not searchable file content.
      Unknown-size, large, and costly files require approval in their attachment card; unsupported formats remain visible.
      AI sharing still requires account consent. The updated companion needs browser Downloads permission.</p>
    {!attachments.length && <p className="caption">No Gmail attachment metadata has been captured yet. File discovery requires the full email,
      not just its inbox preview. Cloud links are not downloaded as attachments.</p>}
    {unchecked > 0 && <p className="inline-warning">{unchecked} displayed full messages still need their attachments checked.
      Previously saved emails are revisited automatically. Keep the updated companion running; an old companion cannot complete this scan.</p>}
  </section>;
}
