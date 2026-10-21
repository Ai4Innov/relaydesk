import type { KnowledgeProvider } from "../../shared/contracts";

export const REMOTE_FILE_MAX = 50 * 1024 * 1024;
export const REMOTE_ENTRIES_MAX = 500;
const FOLDER_DEPTH_MAX = 5;
const TIMEOUT_MS = 60_000;

export interface RemoteFile {
  /** Stable key within the source (provider id or link). */
  key: string;
  /** Display path, e.g. "Reports/2026/Q3.pdf". */
  path: string;
  name: string;
  url: string;
  revision?: string;
  download(signal: AbortSignal): Promise<{ bytes: Buffer; name?: string; mimeType?: string }>;
}
export interface RemoteListing { name: string; provider: KnowledgeProvider; files: RemoteFile[]; truncated: boolean }
type Fetcher = typeof fetch;
type Target = { kind: "drive-folder" | "drive-file" | "google-doc" | "google-sheet" | "google-slides"; id: string } | { kind: "dropbox" } | { kind: "web" };

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"").replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
export const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 200) || "file";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** Parses a share link into a supported target. Only https links to public hosts are accepted. */
export function classifyLink(raw: string): { url: URL; provider: KnowledgeProvider; target: Target } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("Paste a full https:// share link."); }
  if (url.protocol !== "https:") throw new Error("Only https:// share links are supported.");
  if (url.username || url.password) throw new Error("Links containing credentials are not allowed.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host.startsWith("[") || host.endsWith(".local") || host.endsWith(".internal")
    || /^(127|10)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host))
    throw new Error("Links to local or private network addresses are not supported.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "drive.google.com") {
    const folder = parts.indexOf("folders");
    if (folder >= 0 && DRIVE_ID.test(parts[folder + 1] ?? "")) return { url, provider: "google-drive", target: { kind: "drive-folder", id: parts[folder + 1] } };
    if (parts[0] === "embeddedfolderview" && DRIVE_ID.test(url.searchParams.get("id") ?? "")) return { url, provider: "google-drive", target: { kind: "drive-folder", id: url.searchParams.get("id")! } };
    if (parts[0] === "file" && parts[1] === "d" && DRIVE_ID.test(parts[2] ?? "")) return { url, provider: "google-drive", target: { kind: "drive-file", id: parts[2] } };
    const id = url.searchParams.get("id") ?? "";
    if ((parts[0] === "open" || parts[0] === "uc") && DRIVE_ID.test(id)) return { url, provider: "google-drive", target: { kind: "drive-file", id } };
    throw new Error("This Google Drive link is not a shared folder or file link.");
  }
  if (host === "docs.google.com") {
    const kinds = { document: "google-doc", spreadsheets: "google-sheet", presentation: "google-slides" } as const;
    const kind = kinds[parts[0] as keyof typeof kinds];
    const id = parts[1] === "d" ? parts[2] : undefined;
    if (kind && id && DRIVE_ID.test(id)) return { url, provider: "google-drive", target: { kind, id } };
    throw new Error("This Google Docs link is not a shared document, spreadsheet or presentation.");
  }
  if (host === "www.dropbox.com" || host === "dropbox.com") return { url, provider: "dropbox", target: { kind: "dropbox" } };
  const onedrive = host.endsWith("sharepoint.com") || host === "1drv.ms" || host === "onedrive.live.com";
  return { url, provider: onedrive ? "onedrive" : "web", target: { kind: "web" } };
}

interface Fetched { bytes: Buffer; type: string; finalUrl: string; status: number; disposition: string }
async function get(fetcher: Fetcher, url: string, signal: AbortSignal, max = REMOTE_FILE_MAX): Promise<Fetched> {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    headers: { "user-agent": "Mozilla/5.0 (RelayDesk knowledge sync)", "accept-language": "en" } });
  const finalUrl = response.url || url;
  if (!finalUrl.startsWith("https://")) { await response.body?.cancel().catch(() => {}); throw new Error("The share link redirected to a non-https address."); }
  const tooLarge = () => new Error(`File is larger than ${Math.round(max / 1048576)} MB.`);
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > max) { await response.body?.cancel().catch(() => {}); throw tooLarge(); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), type: (response.headers.get("content-type") ?? "").toLowerCase(), finalUrl, status: response.status,
    disposition: response.headers.get("content-disposition") ?? "" };
}

export function dispositionName(disposition: string): string | undefined {
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* use the plain name */ }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1]?.trim();
}

function requireFile(result: Fetched, what: string): void {
  if ([401, 403, 404].includes(result.status) || /accounts\.google\.com|login\.microsoftonline\.com|dropbox\.com\/login/.test(result.finalUrl))
    throw new Error(`${what} is not shared publicly. Set sharing to "Anyone with the link" and retry.`);
  if (result.status >= 400) throw new Error(`${what} could not be downloaded (HTTP ${result.status}).`);
  if (result.type.includes("text/html")) throw new Error(`${what} opened a web page instead of a file. Share it as "Anyone with the link", or paste a direct download link.`);
}

function driveFile(fetcher: Fetcher, id: string, name: string, path: string, revision?: string): RemoteFile {
  return {
    key: `gdrive:${id}`, path, name, url: `https://drive.google.com/file/d/${id}/view`, revision,
    download: async signal => {
      const result = await get(fetcher, `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, signal);
      requireFile(result, `"${name}"`);
      return { bytes: result.bytes, name: dispositionName(result.disposition), mimeType: result.type };
    }
  };
}
function googleExport(fetcher: Fetcher, kind: "google-doc" | "google-sheet" | "google-slides", id: string, name: string, folder: string, revision?: string): RemoteFile {
  const spec = kind === "google-doc" ? { base: "document", suffix: "export?format=docx", ext: "docx" }
    : kind === "google-sheet" ? { base: "spreadsheets", suffix: "export?format=xlsx", ext: "xlsx" }
    : { base: "presentation", suffix: "export/pptx", ext: "pptx" };
  const fileName = name.toLowerCase().endsWith(`.${spec.ext}`) ? name : `${name}.${spec.ext}`;
  return {
    key: `gdoc:${id}`, path: `${folder}${fileName}`, name: fileName, url: `https://docs.google.com/${spec.base}/d/${id}/edit`, revision,
    download: async signal => {
      const result = await get(fetcher, `https://docs.google.com/${spec.base}/d/${encodeURIComponent(id)}/${spec.suffix}`, signal);
      requireFile(result, `"${name}"`);
      return { bytes: result.bytes, name: fileName, mimeType: result.type };
    }
  };
}

async function driveFolder(fetcher: Fetcher, id: string, signal: AbortSignal): Promise<RemoteListing> {
  const files: RemoteFile[] = [];
  let truncated = false, rootName = "Google Drive folder";
  const seen = new Set<string>();
  const walk = async (folderId: string, prefix: string, depth: number): Promise<void> => {
    if (seen.has(folderId)) return;
    seen.add(folderId);
    const page = await get(fetcher, `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}&hl=en`, signal, 10 * 1024 * 1024);
    if ([401, 403, 404].includes(page.status) || /accounts\.google\.com/.test(page.finalUrl))
      throw new Error("This Google Drive folder is not shared publicly. Set sharing to \"Anyone with the link\" and retry.");
    if (page.status >= 400) throw new Error(`Google Drive returned HTTP ${page.status} for this folder.`);
    const html = page.bytes.toString("utf8");
    if (depth === 0) rootName = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "").trim() || rootName;
    for (const entry of html.split(/<div class="flip-entry"/).slice(1)) {
      if (files.length >= REMOTE_ENTRIES_MAX) { truncated = true; return; }
      const href = decode(/<a href="([^"]+)"/.exec(entry)?.[1] ?? "");
      const title = decode(/class="flip-entry-title">([^<]*)</.exec(entry)?.[1] ?? "").trim();
      const modified = decode(/class="flip-entry-last-modified"><div>([^<]*)</.exec(entry)?.[1] ?? "").trim() || undefined;
      if (!href || !title) continue;
      let target: Target;
      try { target = classifyLink(href).target; } catch { continue; }
      const name = safeName(title);
      if (target.kind === "drive-folder") {
        if (depth + 1 < FOLDER_DEPTH_MAX) await walk(target.id, `${prefix}${name}/`, depth + 1); else truncated = true;
      } else if (target.kind === "drive-file") files.push(driveFile(fetcher, target.id, name, `${prefix}${name}`, modified));
      else if (target.kind === "google-doc" || target.kind === "google-sheet" || target.kind === "google-slides")
        files.push(googleExport(fetcher, target.kind, target.id, name, prefix, modified));
    }
  };
  await walk(id, "", 0);
  return { name: rootName, provider: "google-drive", files, truncated };
}

async function singleDownload(fetcher: Fetcher, url: URL, href: string, provider: KnowledgeProvider, signal: AbortSignal): Promise<RemoteListing> {
  const result = await get(fetcher, href, signal);
  requireFile(result, "This link");
  const fallback = decodeURIComponent(new URL(result.finalUrl).pathname.split("/").filter(Boolean).pop() ?? "download");
  let name = safeName(dispositionName(result.disposition) ?? fallback);
  // Dropbox folders arrive as a zip; the isolated parser extracts each file inside it.
  if (provider === "dropbox" && result.type.includes("zip") && !/\.zip$/i.test(name)) name = `${name}.zip`;
  return { name, provider, truncated: false, files: [{ key: `${provider}:${url.href}`, path: name, name, url: url.href,
    download: async () => ({ bytes: result.bytes, name, mimeType: result.type }) }] };
}

/** Lists the files behind a public share link. Only "anyone with the link" content is reachable; no account credentials are sent. */
export async function listRemote(raw: string, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<RemoteListing> {
  const { url, provider, target } = classifyLink(raw);
  if (target.kind === "drive-folder") return driveFolder(fetcher, target.id, signal);
  if (target.kind === "drive-file") {
    const file = driveFile(fetcher, target.id, "Shared file", "Shared file");
    const downloaded = await file.download(signal);
    const name = safeName(downloaded.name ?? "Shared file");
    return { name, provider, truncated: false, files: [{ ...file, name, path: name, download: async () => downloaded }] };
  }
  if (target.kind === "google-doc" || target.kind === "google-sheet" || target.kind === "google-slides") {
    const file = googleExport(fetcher, target.kind, target.id, "Shared document", "");
    return { name: file.name, provider, truncated: false, files: [file] };
  }
  const direct = new URL(url.href);
  if (target.kind === "dropbox") direct.searchParams.set("dl", "1");
  else if (provider === "onedrive" && !direct.searchParams.has("download")) direct.searchParams.set("download", "1");
  return singleDownload(fetcher, url, direct.href, provider, signal);
}
