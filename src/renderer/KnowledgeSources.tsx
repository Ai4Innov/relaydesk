import { useState } from "react";
import { ExternalLink, FolderOpen, FolderPlus, Link2, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import type { Command, CommandResult, KnowledgeSource, Snapshot } from "../shared/contracts";
import { formatDate } from "./utils";

type Run = (command: Command, success?: string, onError?: (text: string) => void) => Promise<CommandResult | undefined>;
const providerLabel: Record<KnowledgeSource["provider"], string> = {
  local: "Local folder", "google-drive": "Google Drive", dropbox: "Dropbox", onedrive: "OneDrive / SharePoint", web: "Web link"
};

function SourceCard({ source, run, busy }: { source: KnowledgeSource; run: Run; busy: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const syncing = source.status === "syncing";
  return <article className="account-card knowledge-card" aria-label={`${source.name} (${providerLabel[source.provider]})`}>
    <div className="knowledge-row">
      {source.kind === "folder" ? <FolderOpen size={18}/> : <Link2 size={18}/>}
      <div className="knowledge-main">
        <strong>{source.name}</strong>
        <small title={source.location}>{providerLabel[source.provider]} · {source.location}</small>
      </div>
      <label className="knowledge-ai" title="Let the assistant search and read these documents">
        <button type="button" className={`toggle ${source.aiEnabled ? "on" : ""}`} role="switch" aria-checked={source.aiEnabled}
          aria-label={`Assistant can read ${source.name}`} disabled={busy}
          onClick={() => void run({ type: "knowledge.update", sourceId: source.id, aiEnabled: !source.aiEnabled })}><span/></button>
        <span>AI</span>
      </label>
    </div>
    <p className={source.status === "error" ? "inline-error" : "caption"} role={source.status === "error" ? "alert" : "status"}>
      {syncing ? <><LoaderCircle size={13} className="spin"/> {source.progress ?? "Syncing…"}</>
        : source.status === "error" ? source.error
        : source.status === "idle" ? "Not synced yet."
        : `${source.indexed} of ${source.files} files searchable${source.skipped ? ` · ${source.skipped} skipped` : ""}${source.failed ? ` · ${source.failed} failed` : ""}${source.truncated ? " · limit reached" : ""}${source.lastSyncAt ? ` · synced ${formatDate(source.lastSyncAt)}` : ""}`}
    </p>
    <div className="button-row wrap">
      <button type="button" className="secondary small" disabled={busy || syncing} onClick={() => void run({ type: "knowledge.sync", sourceId: source.id })}><RefreshCw size={13}/>Sync now</button>
      <button type="button" className="secondary small" onClick={() => void run({ type: "knowledge.open", sourceId: source.id })}>{source.kind === "folder" ? <FolderOpen size={13}/> : <ExternalLink size={13}/>}Open</button>
      {!confirm && <button type="button" className="danger-text small push-right" disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={13}/>Remove</button>}
      {confirm && <span className="push-right knowledge-confirm">Remove and delete its extracted text?
        <button type="button" className="danger small" onClick={() => void run({ type: "knowledge.remove", sourceId: source.id }, "Removed.")}>Remove</button>
        <button type="button" className="secondary small" onClick={() => setConfirm(false)}>Cancel</button></span>}
    </div>
  </article>;
}

/** Settings card: local folders and public shared links the assistant can search and read. */
export function KnowledgeSources({ data, run, busy }: { data: Snapshot; run: Run; busy: boolean }) {
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const sources = data.knowledge ?? [];
  const addLink = async () => {
    setNotice(undefined);
    const result = await run({ type: "knowledge.link.add", url: url.trim() }, undefined, text => setNotice({ text, error: true }));
    if (result) { setUrl(""); setNotice({ text: result.message ?? "Link added.", error: false }); }
  };
  return <section className="card settings-section" aria-label="Folders and shared links">
    <div className="settings-heading"><div className="setting-icon"><FolderPlus/></div><div><h2>Folders &amp; shared links</h2>
      <p>Give the assistant read-only access to documents: a folder on this computer, or a link shared as "Anyone with the link" (Google Drive folder or file, Google Docs/Sheets/Slides, Dropbox, OneDrive or a direct file URL). PDF, Word, Excel, PowerPoint, text, Markdown, CSV and HTML are indexed into your encrypted archive. Original files are never changed.</p></div></div>
    {sources.map(source => <SourceCard key={source.id} source={source} run={run} busy={busy}/>)}
    <div className="knowledge-add">
      <button type="button" disabled={busy} onClick={() => void run({ type: "knowledge.folder.add" }, undefined, text => setNotice({ text, error: true }))}><FolderPlus size={16}/>Add a folder</button>
      <form className="knowledge-link" aria-label="Add a shared link" onSubmit={event => { event.preventDefault(); void addLink(); }}>
        <input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://drive.google.com/drive/folders/…" aria-label="Shared link URL"/>
        <button type="submit" className="secondary" disabled={busy || !url.trim().startsWith("https://")}><Link2 size={16}/>Add link</button>
      </form>
    </div>
    {notice && <p className={notice.error ? "inline-error" : "caption"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    <p className="caption">Folders re-sync every 10 minutes and links every 6 hours while the app runs. Private links need sharing set to "Anyone with the link"; images and media inside folders are not indexed. Ask in Chat, for example: "What does the Q3 report in my Finco folder say about pricing?"</p>
  </section>;
}
