import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileText, LoaderCircle, Minus, Plus, X } from "lucide-react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Attachment, AttachmentView, Command, CommandResult, Snapshot } from "../shared/contracts";
import "./document-viewer.css";

type Run = (command: Command, success?: string) => Promise<CommandResult | undefined>;
export function accessibleDocument(data: Snapshot, id: string): Attachment | undefined {
  const attachment = data.attachments.find(item => item.id === id);
  if (!attachment) return;
  const message = data.messages.find(item => item.id === attachment.messageId);
  if (attachment.parentAvailable === false || (message && (message.accountId !== attachment.accountId || message.deleted))) return;
  if (!message && attachment.parentAvailable !== true) return;
  if (!data.accounts.some(item => item.id === attachment.accountId && item.status === "connected" && item.consent)) return;
  const sourceId = message?.sourceId ?? attachment.sourceId;
  return sourceId && data.sources.some(item => item.id === sourceId && item.accountId === attachment.accountId && item.selected) ? attachment : undefined;
}

interface Documents { data: Snapshot; open(id: string): void; save(id: string): Promise<void>; saving: string; saveNotice: string; saveNoticeId: string }
const DocumentContext = createContext<Documents | undefined>(undefined);

export function DocumentWorkspace({ data, run, children }: { data: Snapshot; run: Run; children: ReactNode }) {
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [saveNoticeId, setSaveNoticeId] = useState("");
  const saveLock = useRef(false);
  const currentData = useRef(data);
  currentData.current = data;
  const attachment = selected ? accessibleDocument(data, selected) : undefined;
  useEffect(() => { if (selected && !attachment) setSelected(""); }, [selected, attachment]);
  const save = async (id: string) => {
    if (saveLock.current || !accessibleDocument(currentData.current, id)?.hash) return;
    saveLock.current = true; setSaving(id); setSaveNotice(""); setSaveNoticeId(id);
    try {
      const result = await run({ type: "attachment.save", attachmentId: id });
      if (accessibleDocument(currentData.current, id)) setSaveNotice(result?.attachmentSave?.message || (result ? "Review the save result in Activity." : "The document could not be saved."));
    } catch { if (accessibleDocument(currentData.current, id)) setSaveNotice("The document could not be saved."); }
    finally { saveLock.current = false; setSaving(""); }
  };
  return <DocumentContext.Provider value={{ data, open: id => {
    if (accessibleDocument(currentData.current, id)) { setSaveNotice(""); setSelected(id); }
  }, save, saving, saveNotice, saveNoticeId }}>
    {children}
    {attachment && <DocumentViewer key={`${attachment.id}:${attachment.hash ?? ""}:${attachment.status}`} attachment={attachment} run={run} onClose={() => setSelected("")} save={() => save(attachment.id)} saving={saving === attachment.id} saveNotice={saveNotice}/>}
  </DocumentContext.Provider>;
}

export function DocumentActions({ attachmentId, viewOnly = false }: { attachmentId: string; viewOnly?: boolean }) {
  const documents = useContext(DocumentContext);
  const attachment = documents && accessibleDocument(documents.data, attachmentId);
  if (!attachment || !documents) return null;
  return <span className="document-actions">
    <button type="button" className="secondary small" onClick={() => documents.open(attachmentId)} aria-label={`View document ${attachment.name}`}><FileText size={14}/>View document</button>
    {!viewOnly && <button type="button" className="quiet small" disabled={!attachment.hash || !!documents.saving} title={attachment.hash ? "Choose a location; the save dialog starts in Downloads." : "Import or process the original first."} onClick={() => void documents.save(attachmentId)} aria-label={`Save ${attachment.name} to Downloads`}><ArrowDownToLine size={14}/>Save to Downloads</button>}
    {!viewOnly && documents.saveNoticeId === attachmentId && <span className="document-save-notice" role="status">{documents.saveNotice}</span>}
  </span>;
}

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length > 90_000_000) throw new Error("This file is too large for the internal viewer.");
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function ImagePreview({ view }: { view: AttachmentView }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!view.base64 || !["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(view.mimeType)) {
      setError("This image format is not available in the safe viewer."); return;
    }
    let objectUrl: string | undefined;
    try {
      objectUrl = URL.createObjectURL(new Blob([bytes(view.base64)], { type: view.mimeType }));
      setUrl(objectUrl);
    } catch { setError("The image could not be decoded."); }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [view]);
  return error ? <p role="alert">{error}</p> : url ? <img className="document-image" src={url} alt={view.name} onError={() => setError("The image could not be displayed.")}/> : <p role="status">Preparing image…</p>;
}

function PdfPreview({ view }: { view: AttachmentView }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const engine = await import("pdfjs-dist");
        if (cancelled) return;
        engine.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        task = engine.getDocument({
          data: bytes(view.base64 || ""), enableXfa: false, useWorkerFetch: false,
          disableFontFace: true, useSystemFonts: true, useWasm: false, isImageDecoderSupported: false,
          maxImageSize: 16_000_000, stopAtErrors: true,
        });
        task.onPassword = () => { if (!cancelled) setError("Password-protected PDFs cannot be previewed. Save the original to open it in your trusted PDF application."); void task?.destroy(); };
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch { if (!cancelled) setError(previous => previous || "This PDF could not be safely rendered. You can save the original instead."); }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [view]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    const target = canvas.current;
    setRendering(true);
    void (async () => {
      try {
        const content = await pdf.getPage(page);
        if (cancelled) return;
        const base = content.getViewport({ scale: 1 });
        const desired = zoom * Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min(desired, 4096 / base.width, 4096 / base.height, Math.sqrt(16_000_000 / (base.width * base.height)));
        const viewport = content.getViewport({ scale });
        target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
        const displayScale = Math.min(zoom, 4096 / base.width, 4096 / base.height);
        target.style.width = `${Math.round(base.width * displayScale)}px`;
        target.style.height = `${Math.round(base.height * displayScale)}px`;
        task = content.render({ canvas: target, viewport, annotationMode: 0 });
        await task.promise;
        if (!cancelled) setRendering(false);
      } catch { if (!cancelled) { setRendering(false); setError("This page could not be rendered. Save the original to inspect it."); } }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page, zoom]);
  return <>
    <div className="document-pdf-toolbar">
      <button className="quiet small" aria-label="Previous PDF page" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17}/></button>
      <span aria-live="polite">Page {page} of {pdf?.numPages ?? "…"}</span>
      <button className="quiet small" aria-label="Next PDF page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={17}/></button>
      <span className="document-toolbar-divider"/>
      <button className="quiet small" aria-label="Zoom out document" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={14}/></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button className="quiet small" aria-label="Zoom in document" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + .25))}><Plus size={14}/></button>
      {rendering && !error && <span role="status"><LoaderCircle size={13} className="spin"/>Rendering page…</span>}
    </div>
    {error ? <p className="document-error" role="alert">{error}</p> : <div className="document-pdf-page"><canvas ref={canvas} style={{ visibility: rendering ? "hidden" : "visible" }} aria-label={`PDF page ${page}`} role="img"/></div>}
    <p className="document-safety-note">Read-only pages. Embedded links, scripts, forms, and external content are not opened.</p>
  </>;
}

function DocumentViewer({ attachment, run, onClose, save, saving, saveNotice }: {
  attachment: Attachment; run: Run; onClose: () => void; save: () => Promise<void>; saving: boolean; saveNotice: string;
}) {
  const [view, setView] = useState<AttachmentView>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await run({ type: "attachment.view", attachmentId: attachment.id });
        if (cancelled) return;
        if (result?.attachmentView?.attachmentId === attachment.id) setView(result.attachmentView);
        else setError("This document is not available. Check its source access and import status.");
      } catch { if (!cancelled) setError("The document could not be opened."); }
    })();
    return () => { cancelled = true; };
  }, [attachment.id, run]);
  return <dialog ref={dialog} className="document-viewer" aria-labelledby={heading} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="document-header"><FileText size={23}/><div><span className="eyebrow">LOCAL DOCUMENT</span><h2 id={heading}>{attachment.name}</h2><p>{attachment.mimeType} · Read-only preview</p></div><button className="icon-button" aria-label="Close document" onClick={onClose}><X size={20}/></button></header>
    <div className="document-content">
      {!view && !error && <p role="status"><LoaderCircle className="spin" size={16}/>Opening encrypted local document…</p>}
      {error && <p role="alert" className="document-error">{error}</p>}
      {view?.message && <p className="document-format-note">{view.message}</p>}
      {view?.truncated && <p className="document-format-note">This preview is partial. Save the original for the complete document.</p>}
      {view?.kind === "pdf" && <PdfPreview view={view}/>}
      {view?.kind === "image" && <ImagePreview view={view}/>}
      {view?.kind === "text" && <><p className="document-format-note">Extracted text · original document layout and formatting are not reproduced.</p><pre className="document-text" tabIndex={0}>{view.text || "No readable text was extracted."}</pre></>}
      {view?.kind === "unsupported" && <p>This format has no safe internal preview. Save the original to open it in an application you trust.</p>}
      {view?.kind === "unavailable" && <p>The original has not been retained locally. {attachment.browser?.source === "browser_gmail"
        ? "Check automatic Gmail attachment downloads in the inbox, or close this viewer and use Download and index on the attachment card. Files requiring approval wait for your confirmation."
        : "Use the attachment’s import or processing action first; opening this viewer does not download the original."}</p>}
    </div>
    <footer className="document-footer"><span role="status">{saveNotice}</span><button className="secondary small" disabled={!view?.canSave || saving} onClick={() => void save()}><ArrowDownToLine size={15}/>{saving ? "Saving…" : "Save to Downloads"}</button><button className="small" onClick={onClose}>Close</button></footer>
  </dialog>;
}
