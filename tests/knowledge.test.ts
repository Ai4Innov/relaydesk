import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Vault } from "../src/main/storage/vault";
import { KnowledgeLibrary } from "../src/main/knowledge";
import { classifyLink, dispositionName, listRemote } from "../src/main/knowledge/remote";

const roots: string[] = [];
const vaults: Vault[] = [];
function setup(fetcher?: typeof fetch) {
  const root = resolve(".test-data", randomUUID());
  const folder = join(root, "docs");
  mkdirSync(folder, { recursive: true }); roots.push(root);
  const vault = new Vault(join(root, "vault"), randomBytes(32));
  vaults.push(vault);
  const extract = vi.fn(async (bytes: Buffer, file: { name: string }) => ({ segments: [{ text: `extracted ${file.name}: ${bytes.toString("utf8")}`, location: "page 1" }] }));
  const library = new KnowledgeLibrary(vault, { extract, changed: () => {}, fetcher });
  return { root, folder, vault, library, extract };
}
afterEach(() => {
  for (const vault of vaults.splice(0)) vault.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response(body: string, init: { status?: number; type?: string; url?: string; disposition?: string } = {}): Response {
  const result = new Response(body, { status: init.status ?? 200, headers: {
    "content-type": init.type ?? "text/html; charset=utf-8", ...(init.disposition ? { "content-disposition": init.disposition } : {}) } });
  Object.defineProperty(result, "url", { value: init.url ?? "https://example.test/" });
  return result;
}
const entry = (href: string, title: string, modified: string) =>
  `<div class="flip-entry" id="entry-x"><a href="${href}" target="_blank"><div class="flip-entry-title">${title}</div></a><div class="flip-entry-last-modified"><div>${modified}</div></div></div>`;

describe("shared link classification", () => {
  it("recognises supported providers and rejects unsafe links", () => {
    expect(classifyLink("https://drive.google.com/drive/folders/15uNXeRBIhVvZJIhL4yTw4IsStMhUaaxl?usp=sharing").target).toEqual({ kind: "drive-folder", id: "15uNXeRBIhVvZJIhL4yTw4IsStMhUaaxl" });
    expect(classifyLink("https://drive.google.com/drive/u/1/folders/15uNXeRBIhVvZJIhL4yTw4IsStMhUaaxl").target.kind).toBe("drive-folder");
    expect(classifyLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing").target).toEqual({ kind: "drive-file", id: "1AbCdEfGhIjKlMnOp" });
    expect(classifyLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp").target.kind).toBe("drive-file");
    expect(classifyLink("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit").target.kind).toBe("google-doc");
    expect(classifyLink("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0").target.kind).toBe("google-sheet");
    expect(classifyLink("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit").target.kind).toBe("google-slides");
    expect(classifyLink("https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1&dl=0").provider).toBe("dropbox");
    expect(classifyLink("https://contoso.sharepoint.com/:b:/s/team/Eabc").provider).toBe("onedrive");
    expect(classifyLink("https://example.com/report.pdf").provider).toBe("web");
    expect(() => classifyLink("http://example.com/a.pdf")).toThrow("https://");
    expect(() => classifyLink("https://user:pass@example.com/a.pdf")).toThrow("credentials");
    expect(() => classifyLink("https://192.168.1.10/a.pdf")).toThrow("private");
    expect(() => classifyLink("https://localhost/a.pdf")).toThrow("private");
    expect(() => classifyLink("https://drive.google.com/drive/my-drive")).toThrow("shared folder or file");
    expect(() => classifyLink("not a link")).toThrow("https://");
    expect(dispositionName("attachment; filename=\"Q3 report.pdf\"; filename*=UTF-8''Q3%20r%C3%A9port.pdf")).toBe("Q3 réport.pdf");
  });
});

describe("public shared links", () => {
  it("lists nested Google Drive folders and exports Google Docs without credentials", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|cookie/i);
      if (url.includes("embeddedfolderview?id=ROOTFOLDER0001")) return response(`<html><title>Finco &amp; partners</title>${
        entry("https://drive.google.com/file/d/FILEPDF000001/view?usp=drive_web", "Offer.pdf", "Oct 19")}${
        entry("https://docs.google.com/document/d/GDOC00000001/edit?usp=drive_web", "Notes", "Oct 18")}${
        entry("https://drive.google.com/drive/folders/SUBFOLDER0001", "Archive", "Oct 1")}</html>`);
      if (url.includes("embeddedfolderview?id=SUBFOLDER0001")) return response(`<title>Archive</title>${entry("https://drive.google.com/file/d/FILETXT000001/view", "old.txt", "Sep 2")}`);
      if (url.includes("download?id=FILEPDF000001")) return response("pdf-bytes", { type: "application/pdf", url: "https://drive.usercontent.google.com/x", disposition: "attachment; filename=\"Offer.pdf\"" });
      if (url.includes("document/d/GDOC00000001/export?format=docx")) return response("docx-bytes", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: "https://docs.google.com/x" });
      if (url.includes("download?id=FILETXT000001")) return response("Legacy pricing was 4%.", { type: "text/plain", url: "https://drive.usercontent.google.com/y" });
      return response("missing", { status: 404 });
    });
    const listing = await listRemote("https://drive.google.com/drive/folders/ROOTFOLDER0001", new AbortController().signal, fetcher as typeof fetch);
    expect(listing.name).toBe("Finco & partners");
    expect(listing.files.map(file => file.path)).toEqual(["Offer.pdf", "Notes.docx", "Archive/old.txt"]);
    expect(listing.files.map(file => file.revision)).toEqual(["Oct 19", "Oct 18", "Sep 2"]);
    const doc = await listing.files[1].download(new AbortController().signal);
    expect(doc.bytes.toString()).toBe("docx-bytes");
    expect(calls.filter(url => url.includes("download") || url.includes("export"))).toHaveLength(1);
  });

  it("explains private folders and links that return a web page", async () => {
    const privateFolder = vi.fn(async () => response("Not found", { status: 404 }));
    await expect(listRemote("https://drive.google.com/drive/folders/PRIVATEFOLDER1", new AbortController().signal, privateFolder as unknown as typeof fetch))
      .rejects.toThrow("Anyone with the link");
    const loginRedirect = vi.fn(async () => response("<html>sign in</html>", { url: "https://accounts.google.com/ServiceLogin" }));
    await expect(listRemote("https://drive.google.com/file/d/PRIVATEFILE001/view", new AbortController().signal, loginRedirect as unknown as typeof fetch))
      .rejects.toThrow("Anyone with the link");
    const html = vi.fn(async () => response("<html>viewer</html>", { url: "https://example.com/viewer" }));
    await expect(listRemote("https://example.com/viewer", new AbortController().signal, html as unknown as typeof fetch)).rejects.toThrow("web page instead of a file");
  });
});

describe("knowledge library", () => {
  it("indexes a local folder, skips unchanged files, drops deleted ones and honours AI access", async () => {
    const { folder, library, extract, vault } = setup();
    mkdirSync(join(folder, "Finco", "node_modules"), { recursive: true });
    writeFileSync(join(folder, "Finco", "pricing.md"), "# Pricing\nThe Fineract core banking proposal costs 12,000 EUR per year.");
    writeFileSync(join(folder, "Finco", "offer.pdf"), "SBS scenario B");
    writeFileSync(join(folder, "notes.txt"), "Call Kezia about the échéance.");
    writeFileSync(join(folder, "photo.png"), "binary");
    writeFileSync(join(folder, ".hidden.txt"), "secret");
    writeFileSync(join(folder, "Finco", "node_modules", "pkg.md"), "ignored");
    const source = library.addFolder(folder, "Finco docs");
    expect(() => library.addFolder(folder)).toThrow("already added");
    await library.sync(source.id);
    let state = library.sources()[0];
    expect(state).toMatchObject({ status: "ready", files: 3, indexed: 3, failed: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(library.list().documents.map(document => document.path).sort()).toEqual(["Finco/offer.pdf", "Finco/pricing.md", "notes.txt"]);

    const hit = library.search("fineract core banking").results[0];
    expect(hit.path).toBe("Finco/pricing.md");
    expect(hit.excerpt).toContain("12,000 EUR");
    expect(library.search("echeance").results[0].path).toBe("notes.txt");
    expect(library.read(hit.documentId).text).toContain("Fineract");
    expect(library.search("scenario").results[0].excerpt).toContain("extracted offer.pdf: SBS scenario B");

    await library.sync(source.id);
    expect(extract).toHaveBeenCalledTimes(1);
    writeFileSync(join(folder, "Finco", "offer.pdf"), "SBS scenario C");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(folder, "Finco", "offer.pdf"), later, later);
    unlinkSync(join(folder, "notes.txt"));
    await library.sync(source.id);
    expect(extract).toHaveBeenCalledTimes(2);
    state = library.sources()[0];
    expect(state.files).toBe(2);
    expect(library.search("scenario").results[0].excerpt).toContain("scenario C");
    expect(library.search("kezia").results).toHaveLength(0);

    library.update(source.id, { aiEnabled: false });
    expect(library.list().documents).toHaveLength(0);
    expect(library.search("fineract").results).toHaveLength(0);
    expect(() => library.read(hit.documentId)).toThrow("not shared with AI");

    library.remove(source.id);
    expect(library.sources()).toHaveLength(0);
    expect(vault.all("documents")).toHaveLength(0);
  });

  it("indexes a public shared file link and reports private links as sync errors", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("download?id=PUBLICFILE0001")) return response("Board minutes: approve the Fineract pilot.", { type: "text/plain", url: "https://drive.usercontent.google.com/a", disposition: "attachment; filename=\"minutes.txt\"" });
      return response("no", { status: 403, url: "https://drive.usercontent.google.com/b" });
    });
    const { library } = setup(fetcher as unknown as typeof fetch);
    const shared = library.addLink("https://drive.google.com/file/d/PUBLICFILE0001/view?usp=sharing");
    await library.sync(shared.id);
    expect(library.sources()[0]).toMatchObject({ name: "minutes.txt", provider: "google-drive", status: "ready", indexed: 1 });
    expect(library.search("fineract pilot").results[0]).toMatchObject({ path: "minutes.txt", url: "https://drive.google.com/file/d/PUBLICFILE0001/view" });

    const hidden = library.addLink("https://drive.google.com/file/d/PRIVATEFILE001/view");
    await library.sync(hidden.id);
    expect(library.sources().find(source => source.id === hidden.id)).toMatchObject({ status: "error", error: expect.stringContaining("Anyone with the link") });
    expect(() => library.addLink("http://example.com/x.pdf")).toThrow("https://");
  });
});
