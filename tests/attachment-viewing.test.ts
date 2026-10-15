import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Attachment, Collection, Message, Source } from "../src/shared/contracts";
import type { IndexChunk } from "../src/main/storage/vault";
import { attachmentViewGuard, safeAttachmentName, saveAttachment, viewAttachment, VIEW_BYTES_MAX, VIEW_TEXT_MAX, SAVE_BYTES_MAX } from "../src/main/attachments/viewing";
import { commandSchema } from "../src/main/ipc/schema";

const directories: string[] = [];
async function directory() {
  const path = resolve(".test-data", `document-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  directories.push(path);
  return path;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

function fixture(patch: Partial<Attachment> = {}, content = Buffer.from("Plain document")) {
  const data = new Map<string, unknown>();
  const account: Account = { id: "account", provider: "gmail", status: "connected", name: "Test",
    email: "test@example.org", aiEnabled: false, consent: true };
  const source: Source = { id: "source", accountId: account.id, name: "Inbox", providerId: "inbox", kind: "mail", selected: true };
  const message: Message = { id: "message", accountId: account.id, sourceId: source.id, providerId: "message", threadId: "thread",
    subject: "Test", sender: "", recipients: [], body: "", receivedAt: "", url: "", unread: false, revision: "one", historical: true };
  const attachment: Attachment = { id: "attachment", accountId: account.id, messageId: message.id, providerId: "file",
    name: "notes.txt", mimeType: "text/plain", status: "indexed", hash: "retained", size: content.length, ...patch };
  const put = (collection: Collection, id: string, value: unknown) => data.set(`${collection}/${id}`, structuredClone(value));
  put("accounts", account.id, account); put("sources", source.id, source);
  put("messages", message.id, message); put("attachments", attachment.id, attachment);
  const chunks: IndexChunk[] = [];
  const vault = {
    get<T>(collection: Collection, id: string): T | undefined { return structuredClone(data.get(`${collection}/${id}`)) as T | undefined; },
    readBlob: vi.fn(async (_id: string, _maxBytes?: number) => Buffer.from(content)),
    localDocumentChunks: vi.fn((_id: string, offset = 0, limit = 6) => chunks.slice(offset, offset + limit))
  };
  const validate = attachmentViewGuard(vault, attachment.id, () => false);
  const chunk = (text: string): IndexChunk => ({ id: String(chunks.length), documentId: `attachment:${attachment.id}`,
    accountId: account.id, messageId: message.id, sourceId: source.id, attachmentId: attachment.id,
    text, location: "Page 1", title: attachment.name });
  return { vault, validate, put, account, source, message, attachment, chunks, chunk };
}

describe("local document viewing", () => {
  it("accepts only ID commands without renderer paths, URLs or approval flags", () => {
    for (const type of ["attachment.view", "attachment.save"]) {
      expect(commandSchema.safeParse({ type, attachmentId: "file" }).success).toBe(true);
      for (const extra of [{ path: "C:\\secret" }, { url: "file:///secret" }, { approved: true }])
        expect(commandSchema.safeParse({ type, attachmentId: "file", ...extra }).success).toBe(false);
    }
  });
  it("views local text without AI consent and bounds text output", async () => {
    const h = fixture({}, Buffer.from("é".repeat(VIEW_TEXT_MAX + 1)));
    const result = await viewAttachment(h.vault, h.validate);
    expect(result).toMatchObject({ kind: "text", canSave: true, truncated: true });
    expect(result.text).toHaveLength(VIEW_TEXT_MAX);
    expect(result.base64).toBeUndefined();
    expect(h.vault.readBlob).toHaveBeenCalledWith("attachment", VIEW_BYTES_MAX);
  });
  it("returns only sniffed PDF or safe raster bytes", async () => {
    const h = fixture({ name: "document.pdf", mimeType: "application/pdf" }, Buffer.from("%PDF-1.7\nexample"));
    const pdf = await viewAttachment(h.vault, h.validate);
    expect(pdf).toMatchObject({ kind: "pdf", mimeType: "application/pdf" });
    expect(Buffer.from(pdf.base64!, "base64").toString()).toBe("%PDF-1.7\nexample");
    const png = fixture({ name: "photo.png", mimeType: "image/png" },
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64"));
    expect(await viewAttachment(png.vault, png.validate)).toMatchObject({ kind: "image", mimeType: "image/png" });
  });
  it("bounds raster dimensions before allowing browser decoding", async () => {
    const bytes = Buffer.alloc(32);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(100_000, 16);
    bytes.writeUInt32BE(100_000, 20);
    const h = fixture({ name: "bomb.png", mimeType: "image/png" }, bytes);
    expect(await viewAttachment(h.vault, h.validate)).toMatchObject({ kind: "unsupported",
      message: expect.stringContaining("16-megapixel") });
  });
  it.each([
    ["index.html", "text/html", "<script>fetch('https://example.org')</script>"],
    ["drawing.svg", "image/svg+xml", '<svg onload="alert(1)"/>'],
    ["fake.pdf", "application/pdf", "<html>active</html>"],
    ["fake.png", "image/png", "<svg/>"],
    ["script.js", "application/javascript", "alert(1)"]
  ])("never renders active originals or trusting MIME metadata: %s", async (name, mimeType, content) => {
    const h = fixture({ name, mimeType }, Buffer.from(content));
    const result = await viewAttachment(h.vault, h.validate);
    expect(result).toMatchObject({ kind: "unsupported", canSave: true });
    expect(result.base64).toBeUndefined();
    expect(result.text).toBeUndefined();
  });
  it("falls back to bounded Office extraction without reading an oversized original", async () => {
    const h = fixture({ name: "workbook.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: VIEW_BYTES_MAX + 1 });
    h.chunks.push(h.chunk("Spreadsheet rows ".repeat(20_000)));
    const result = await viewAttachment(h.vault, h.validate);
    expect(result).toMatchObject({ kind: "text", canSave: true, truncated: true });
    expect(result.text).toHaveLength(VIEW_TEXT_MAX);
    expect(h.vault.readBlob).not.toHaveBeenCalled();
  });
  it("explains metadata-only imports and never starts provider downloads", async () => {
    const h = fixture({ hash: undefined, browser: { source: "browser_gmail", metadataId: "file" } });
    expect(await viewAttachment(h.vault, h.validate)).toMatchObject({ kind: "unavailable", canSave: false, message: expect.stringContaining("Import downloaded file") });
    const picker = vi.fn();
    expect(await saveAttachment(h.vault, h.validate, picker)).toMatchObject({ status: "unavailable" });
    expect(picker).not.toHaveBeenCalled();
    expect(h.vault.readBlob).not.toHaveBeenCalled();
  });
  it("directs WhatsApp metadata-only attachments to the original source app", async () => {
    const h = fixture({ hash: undefined, browser: { source: "browser_whatsapp", metadataId: "file" } });
    expect(await viewAttachment(h.vault, h.validate)).toMatchObject({ kind: "unavailable",
      message: expect.stringContaining("WhatsApp") });
  });
  it("allows existing extracted text when an original is no longer retained", async () => {
    const h = fixture({ hash: undefined });
    h.chunks.push(h.chunk("Office document text"));
    expect(await viewAttachment(h.vault, h.validate)).toMatchObject({ kind: "text", canSave: false, text: expect.stringContaining("Office document text") });
  });
  it("labels partial Office extraction as incomplete", async () => {
    const h = fixture({ name: "slides.pptx", mimeType: "application/octet-stream", status: "partial" });
    h.chunks.push(h.chunk("First slide only"));
    expect(await viewAttachment(h.vault, h.validate)).toMatchObject({ kind: "text", truncated: true,
      message: expect.stringContaining("Extraction is incomplete") });
  });
  it.each(["consent", "connected", "selected", "deleted", "ownership"])("enforces %s before returning local data", async restriction => {
    const h = fixture();
    if (restriction === "consent") h.put("accounts", h.account.id, { ...h.account, consent: false });
    if (restriction === "connected") h.put("accounts", h.account.id, { ...h.account, status: "disconnected" });
    if (restriction === "selected") h.put("sources", h.source.id, { ...h.source, selected: false });
    if (restriction === "deleted") h.put("messages", h.message.id, { ...h.message, deleted: true });
    if (restriction === "ownership") h.put("messages", h.message.id, { ...h.message, accountId: "different" });
    await expect(viewAttachment(h.vault, h.validate)).rejects.toThrow("Document access");
    expect(h.vault.readBlob).not.toHaveBeenCalled();
  });
  it("rechecks permissions and metadata after asynchronous decryption", async () => {
    const h = fixture();
    h.vault.readBlob.mockImplementation(async () => {
      h.put("sources", h.source.id, { ...h.source, selected: false });
      return Buffer.from("private");
    });
    await expect(viewAttachment(h.vault, h.validate)).rejects.toThrow("Document access");
    const changed = fixture();
    changed.vault.readBlob.mockImplementation(async () => {
      changed.put("attachments", changed.attachment.id, { ...changed.attachment, hash: "replaced" });
      return Buffer.from("private");
    });
    await expect(viewAttachment(changed.vault, changed.validate)).rejects.toThrow("metadata changed");
  });
  it("does not surface filesystem paths or secrets from decryption errors", async () => {
    const h = fixture();
    h.vault.readBlob.mockRejectedValue(Object.assign(new Error("C:\\private\\key ghp_private"), { code: "ENOENT" }));
    const result = await viewAttachment(h.vault, h.validate);
    expect(result).toMatchObject({ kind: "unavailable", canSave: false });
    expect(JSON.stringify(result)).not.toMatch(/private|ghp_/);
  });
});

describe("user initiated original saves", () => {
  it.each([
    ["..\\..\\original.pdf", "original.pdf"], ["../../original.pdf", "original.pdf"],
    ["CON.txt", "_CON.txt"], ["file:stream", "file_stream"], ["..", "attachment"],
    ["hello\u202eexe.txt", "hello_exe.txt"]
  ])("sanitizes the suggested filename %s", (input, expected) => expect(safeAttachmentName(input)).toBe(expected));
  it("clearly cancels without reading or writing original bytes", async () => {
    const h = fixture();
    expect(await saveAttachment(h.vault, h.validate, async () => undefined)).toMatchObject({ status: "cancelled" });
    expect(h.vault.readBlob).not.toHaveBeenCalled();
  });
  it("saves unsupported retained originals byte-for-byte without exposing paths", async () => {
    const h = fixture({ name: "..\\..\\document.odt", mimeType: "application/vnd.oasis.opendocument.text", status: "unsupported" });
    const path = join(await directory(), "document.odt");
    const picker = vi.fn(async () => path);
    const result = await saveAttachment(h.vault, h.validate, picker);
    expect(picker).toHaveBeenCalledWith("document.odt");
    expect(await readFile(path, "utf8")).toBe("Plain document");
    expect(result).toEqual({ status: "saved", name: "document.odt", message: "Original attachment saved to your chosen folder." });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(h.vault.readBlob).toHaveBeenCalledWith("attachment", SAVE_BYTES_MAX);
  });
  it("never overwrites existing files", async () => {
    const h = fixture(), path = join(await directory(), "notes.txt");
    await writeFile(path, "keep this");
    await expect(saveAttachment(h.vault, h.validate, async () => path)).rejects.toThrow("never overwritten");
    expect(await readFile(path, "utf8")).toBe("keep this");
  });
  it("rejects network paths, device names, and alternate data streams", async () => {
    for (const path of ["\\\\server\\share\\notes.txt", "C:\\folder\\notes.txt:stream", "C:\\folder\\NUL.txt"]) {
      const h = fixture();
      await expect(saveAttachment(h.vault, h.validate, async () => path)).rejects.toThrow("regular local filename");
      expect(h.vault.readBlob).not.toHaveBeenCalled();
    }
  });
  it("aborts when permission is revoked during the picker or original read", async () => {
    const h = fixture(), path = join(await directory(), "notes.txt");
    await expect(saveAttachment(h.vault, h.validate, async () => {
      h.put("sources", h.source.id, { ...h.source, selected: false }); return path;
    })).rejects.toThrow("Document access");
    expect(h.vault.readBlob).not.toHaveBeenCalled();
    const reading = fixture();
    reading.vault.readBlob.mockImplementation(async () => {
      reading.put("accounts", reading.account.id, { ...reading.account, consent: false });
      return Buffer.from("private");
    });
    await expect(saveAttachment(reading.vault, reading.validate, async () => path)).rejects.toThrow("Document access");
    await expect(access(path)).rejects.toThrow();
  });
  it("removes a partially exported original after access is revoked during writing", async () => {
    const h = fixture(), path = join(await directory(), "notes.txt");
    let checks = 0;
    const validate = () => {
      if (++checks >= 8) throw new Error("Access revoked");
      return h.validate();
    };
    await expect(saveAttachment(h.vault, validate, async () => path)).rejects.toThrow("Access revoked");
    await expect(access(path)).rejects.toThrow();
  });
  it("bounds original export allocation before asking for a destination", async () => {
    const h = fixture({ size: SAVE_BYTES_MAX + 1 }), picker = vi.fn();
    expect(await saveAttachment(h.vault, h.validate, picker)).toMatchObject({ status: "unavailable", message: expect.stringContaining("128 MiB") });
    expect(picker).not.toHaveBeenCalled();
    expect(h.vault.readBlob).not.toHaveBeenCalled();
  });
});
