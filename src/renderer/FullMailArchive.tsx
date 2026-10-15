import { Download, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";
import { AttachmentArchive } from "./AttachmentArchive";

export function FullMailArchive({ data, run, busy }: {
  data: Snapshot; busy: boolean; run: (command: Command) => Promise<CommandResult | undefined>;
}) {
  const coverage = data.fullMailArchive;
  if (!data.accounts.some(account => account.connection === "browser" && account.provider === "gmail")) return null;
  const enabled = data.settings.browserFullMailDownload;
  const paused = data.settings.syncPaused || !enabled;
  return <section className="card" aria-label="Local full-email archive">
    <div className="section-heading"><h2><Download size={18}/> Full emails, stored locally</h2>
      <label className="check-label"><input type="checkbox" checked={enabled} disabled={busy}
        onChange={event => void run({ type: "settings.update", patch: { browserFullMailDownload: event.target.checked } })}/>
        Automatically download full emails</label>
    </div>
    <p>Complete messages are downloaded into your encrypted archive and indexed for local search and AI retrieval.
      Only selected Gmail inboxes are included. AI sharing still requires account consent.</p>
    {coverage && <>
      <p role="status" aria-label="Full-email archive status">{coverage.complete} of {coverage.total} conversations downloaded
        {" · "}{coverage.queued} queued{" · "}{coverage.failed} need attention
        {paused ? " · Paused" : coverage.running ? " · Downloading" : coverage.queued ? " · Waiting for next download"
          : coverage.failed ? " · Incomplete - waiting to retry" : " · Up to date with discovered conversations"}</p>
      {coverage.total > 0 && <progress aria-label="Full-email download progress" max={coverage.total} value={coverage.complete}/>}
      {coverage.running && <p className="caption"><LoaderCircle size={14}/> Downloading from {data.accounts.find(account => account.id === coverage.currentAccountId)?.email || "a selected inbox"}.</p>}
      {coverage.lastError && <p className="inline-warning" role="alert">{coverage.lastError}
        {coverage.nextRetryAt && ` Next retry: ${new Date(coverage.nextRetryAt).toLocaleString()}.`}</p>}
    </>}
    <div className="button-row">
      <button className="secondary small" disabled={busy || paused}
        onClick={() => void run({ type: "message.downloadAll" })}><RefreshCw size={15}/>Download pending / retry failed</button>
      <button className="quiet small" disabled={busy} onClick={() => void run({
        type: "settings.update", patch: { browserFullMailDownload: !enabled },
      })}>{enabled ? <Pause size={15}/> : <Play size={15}/>} {enabled ? "Pause email downloads" : "Resume email downloads"}</button>
    </div>
    <p className="caption">Keep the paired browser running and signed in. Browser downloads can mark mail as read in Gmail.
      This covers discovered conversations, not yet your entire mailbox history.
      Preview-only messages are incomplete evidence until downloaded.</p>
    <AttachmentArchive {...{ data, run, busy }}/>
  </section>;
}
