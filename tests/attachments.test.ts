import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { join, resolve } from "node:path";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { AttachmentProcessor } from "../src/main/attachments";
import type { Attachment, Collection } from "../src/shared/contracts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: { name: string; data: Buffer | string; mode?: number; compressed?: boolean; encrypted?: boolean }[]): Buffer {
  const locals: Buffer[] = [], directories: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const bytes = Buffer.from(file.data);
    const encoded = file.compressed ? deflateRawSync(bytes) : bytes;
    const content = file.encrypted ? Buffer.concat([Buffer.alloc(12), encoded]) : encoded;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(file.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(file.compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(file.encrypted ? 1 : 0, 8);
    directory.writeUInt16LE(file.compressed ? 8 : 0, 10);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, name, content);
    directories.push(directory, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pdf(text?: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 50 750 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  source += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}
let sequence = 0;
function fixture(bytes: Buffer, patch: Partial<Attachment> = {}, threshold = 25) {
  let attachment: Attachment = {
    id: `attachment-${sequence++}`, name: "notes.txt", mimeType: "text/plain", size: bytes.length,
    accountId: "account", messageId: "message", providerId: "provider", status: "pending", ...patch,
  };
  const blobs = new Map<string, Buffer>();
  const vault = {
    get<T>(_collection: Collection, id: string): T | undefined { return (id === attachment.id ? attachment : undefined) as T | undefined; },
    put<T>(_collection: Collection, _id: string, value: T) { attachment = value as Attachment; },
    all<T>(): T[] { return [attachment] as T[]; },
    writeBlob: vi.fn(async (id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal) => {
      const reader = stream.getReader();
      const chunks: Buffer[] = [];
      try {
        while (true) {
          signal?.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          chunks.push(Buffer.from(item.value));
        }
      } finally { reader.releaseLock(); }
      const value = Buffer.concat(chunks);
      blobs.set(id, value);
      return { hash: createHash("sha256").update(value).digest("hex"), size: value.length };
    }),
    readBlob: vi.fn(async (id: string) => blobs.get(id)!),
  };
  const download = vi.fn(async () => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }));
  const retrieval = { indexAttachment: vi.fn(async (_attachment: Attachment, _segments: { text: string; location: string }[]) => {}) };
  const processor = new AttachmentProcessor(vault, retrieval, download, {
    modelDirectory: resolve("tests", "uninstalled-attachment-models"),
    thresholdMb: () => threshold,
    workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs"),
  });
  return { processor, vault, retrieval, download, attachment: () => attachment,
    run: (approved = false, signal?: AbortSignal) => processor.process(attachment.id, approved, signal),
    text: () => retrieval.indexAttachment.mock.calls.flatMap(call => call[1]).map(segment => segment.text).join("\n"),
    locations: () => retrieval.indexAttachment.mock.calls.flatMap(call => call[1]).map(segment => segment.location),
  };
}

describe("attachment approval and lifecycle", () => {
  it.each([
    { size: undefined }, { size: 26 * 1048576 }, { name: "data.zip", mimeType: "application/zip" },
    { name: "recording.mp3", mimeType: "audio/mpeg" }, { name: "scan.png", mimeType: "image/png" },
  ])("requires approval before any download for %j", async patch => {
    const test = fixture(Buffer.from("text"), patch);
    await test.run();
    expect(test.attachment().status).toBe("awaiting-approval");
    expect(test.download).not.toHaveBeenCalled();
  });
  it("honors a lower configured threshold", async () => {
    const test = fixture(Buffer.from("text"), { size: 2 * 1048576 }, 1);
    await test.run();
    expect(test.attachment().status).toBe("awaiting-approval");
    expect(test.download).not.toHaveBeenCalled();
  });
  it("stops a deceptively sized stream before retaining excess data", async () => {
    const test = fixture(Buffer.alloc(2048, 65), { size: 4 }, 0.001);
    await test.run();
    expect(test.attachment().status).toBe("awaiting-approval");
    expect(test.vault.readBlob).not.toHaveBeenCalled();
  });
  it("indexes UTF-8 text with provenance only after encrypted persistence", async () => {
    const test = fixture(Buffer.from("Bonjour à tous\n日本語のメモ"));
    await test.run();
    expect(test.attachment().status).toBe("indexed");
    expect(test.attachment().hash).toMatch(/^[a-f0-9]{64}$/);
    expect(test.text()).toContain("日本語");
    expect(test.locations()).toEqual(["lines 1–2"]);
    expect(test.vault.writeBlob).toHaveBeenCalledOnce();
  });
  it("does not claim success for empty or invalid UTF-8 text", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x01])]) {
      const test = fixture(bytes);
      await test.run();
      expect(test.attachment().status).not.toBe("indexed");
      expect(test.text()).toBe("");
    }
  });
  it("keeps unsupported executable metadata visible without downloading", async () => {
    const test = fixture(Buffer.from("MZ"), { name: "danger.exe" });
    await test.run(true);
    expect(test.attachment().status).toBe("unsupported");
    expect(test.download).not.toHaveBeenCalled();
  });
  it("blocks executable content masquerading as text", async () => {
    const test = fixture(Buffer.from("MZexecutable"));
    await test.run();
    expect(test.attachment().status).toBe("blocked");
  });
  it("reports cancellation before contacting the provider", async () => {
    const test = fixture(Buffer.from("hello"));
    const controller = new AbortController(); controller.abort();
    await test.run(false, controller.signal);
    expect(test.attachment().status).toBe("cancelled");
    expect(test.download).not.toHaveBeenCalled();
  });
  it("reports provider/index failures without leaking message contents", async () => {
    const test = fixture(Buffer.from("private"));
    test.download.mockRejectedValueOnce(new Error("private credential"));
    await test.run();
    expect(test.attachment().status).toBe("failed");
    expect(test.attachment().reason).not.toContain("credential");
    const other = fixture(Buffer.from("private"));
    other.retrieval.indexAttachment.mockRejectedValueOnce(new Error("private content"));
    await other.run();
    expect(other.attachment().status).toBe("failed");
  });
  it("does not redownload an original retained after extraction failure", async () => {
    const test = fixture(Buffer.from([0xff]));
    await test.run();
    await test.run();
    expect(test.download).toHaveBeenCalledOnce();
  });
  it("approval never bypasses whole-buffer extraction memory limits", async () => {
    const test = fixture(Buffer.from("not read"), { hash: "already-retained-original", size: 256 * 1048576 });
    await test.run(true);
    expect(test.attachment().status).toBe("blocked");
    expect(test.attachment().reason).toContain("memory budget");
    expect(test.vault.readBlob).not.toHaveBeenCalled();
    expect(test.download).not.toHaveBeenCalled();
  });
  it("fails visibly when the shipped worker asset is missing", async () => {
    const test = fixture(Buffer.from("text"));
    const processor = new AttachmentProcessor(test.vault, test.retrieval, test.download, {
      modelDirectory: resolve("tests", "uninstalled-attachment-models"), thresholdMb: () => 25,
      workerPath: resolve("tests", "missing-worker-asset.cjs"),
    });
    await processor.process(test.attachment().id, false);
    expect(test.attachment().status).toBe("blocked");
    expect(test.attachment().reason).toContain("packaged attachment worker");
    expect(test.text()).toBe("");
  });
  it("survives a parser that crashes its whole process natively", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-crashing-parser-"));
    try {
      copyFileSync(resolve("src", "main", "attachments", "attachment-host.cjs"), join(directory, "attachment-host.cjs"));
      writeFileSync(join(directory, "attachment-worker.cjs"), "process.kill(process.pid, \"SIGKILL\");\n");
      const test = fixture(Buffer.from("text"));
      const processor = new AttachmentProcessor(test.vault, test.retrieval, test.download, {
        modelDirectory: resolve("tests", "uninstalled-attachment-models"), thresholdMb: () => 25,
        workerPath: join(directory, "attachment-worker.cjs"),
      });
      await processor.process(test.attachment().id, false);
      expect(test.attachment().status).toBe("failed");
      expect(test.attachment().reason).toContain("isolated parser");
      expect(test.text()).toBe("");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("isolated document parsers", () => {
  it("preserves CSV values as plain text without formula execution", async () => {
    const test = fixture(Buffer.from('name,value\nsample,"=WEBSERVICE(""https://invalid"")"'), { name: "data.csv" });
    await test.run();
    expect(test.attachment().status).toBe("indexed");
    expect(test.text()).toContain("WEBSERVICE");
    expect(test.locations()[0]).toContain("CSV physical lines");
  });
  it("extracts PDF text with page references", async () => {
    const test = fixture(pdf("Project relay"), { name: "brief.pdf", mimeType: "application/pdf" });
    await test.run();
    expect(test.attachment().status, test.attachment().reason).toBe("indexed");
    expect(test.text()).toContain("Project relay");
    expect(test.locations()).toEqual(["page 1"]);
  });
  it("gates scanned PDF OCR after detection and reports missing models explicitly", async () => {
    const test = fixture(pdf(), { name: "scan.pdf", mimeType: "application/pdf" });
    await test.run();
    expect(test.attachment().status, test.attachment().reason).toBe("awaiting-approval");
    await test.run(true);
    expect(test.attachment().status, test.attachment().reason).toBe("blocked");
    expect(test.attachment().reason).toMatch(/model/i);
    expect(test.download).toHaveBeenCalledOnce();
  });
  it("extracts DOCX paragraphs using mammoth without opening remote relationships", async () => {
    const bytes = zip([
      { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: "word/document.xml", data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Meeting notes</w:t></w:r></w:p></w:body></w:document>' },
    ]);
    const test = fixture(bytes, { name: "brief.docx" });
    await test.run();
    expect(test.attachment().status, test.attachment().reason).toBe("indexed");
    expect(test.text()).toContain("Meeting notes");
    expect(test.locations()[0]).toBe("paragraph 1");
  });
  it("extracts XLSX cached values with sheet and cell references", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    sheet.getCell("A1").value = "Revenue";
    sheet.getCell("B1").value = { formula: "1+2", result: 3 };
    const test = fixture(Buffer.from(await workbook.xlsx.writeBuffer()), { name: "budget.xlsx" });
    await test.run();
    expect(test.attachment().status, test.attachment().reason).toBe("indexed");
    expect(test.text()).toContain("Revenue");
    expect(test.locations()).toContain("sheet Budget, cell B1");
  });
  it("extracts PPTX slide text safely", async () => {
    const test = fixture(zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/presentation.xml", data: "<p:presentation/>" },
      { name: "ppt/slides/slide1.xml", data: "<p:sld><a:t>Research &amp; design</a:t></p:sld>" },
    ]), { name: "talk.pptx" });
    await test.run();
    expect(test.attachment().status).toBe("indexed");
    expect(test.text()).toBe("Research & design");
    expect(test.locations()).toEqual(["slide 1"]);
  });
  it("reports missing local media configuration without fake transcription", async () => {
    const test = fixture(Buffer.from("RIFF1234WAVE"), { name: "audio.wav" });
    await test.run(true);
    expect(test.attachment().status).toBe("blocked");
    expect(test.attachment().reason).toMatch(/RELAY_FFMPEG_PATH|model/);
    expect(test.text()).toBe("");
  });
  it("validates image dimensions before native decoding", async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    bytes.writeUInt32BE(100000, 16);
    bytes.writeUInt32BE(100000, 20);
    const test = fixture(bytes, { name: "oversized.png" });
    await test.run(true);
    expect(test.attachment().status).toBe("blocked");
    expect(test.attachment().reason).toContain("16-megapixel");
  });
  it("reports missing local image OCR models without downloading them", async () => {
    const test = fixture(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=", "base64"), { name: "scan.png" });
    await test.run(true);
    expect(test.attachment().status, test.attachment().reason).toBe("blocked");
    expect(test.attachment().reason).toMatch(/model/);
  });
  it("uses PPTX presentation order rather than slide file numbering", async () => {
    const test = fixture(zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/presentation.xml", data: '<p:presentation><p:sldIdLst><p:sldId r:id="first"/><p:sldId r:id="second"/></p:sldIdLst></p:presentation>' },
      { name: "ppt/_rels/presentation.xml.rels", data: '<Relationships><Relationship Id="first" Target="slides/slide2.xml"/><Relationship Id="second" Target="slides/slide1.xml"/></Relationships>' },
      { name: "ppt/slides/slide1.xml", data: "<p:sld><a:t>Second slide</a:t></p:sld>" },
      { name: "ppt/slides/slide2.xml", data: "<p:sld><a:t>Premi&#232;re slide</a:t></p:sld>" },
    ]), { name: "ordered.pptx" });
    await test.run();
    expect(test.attachment().status).toBe("indexed");
    expect(test.text()).toBe("Première slide\nSecond slide");
    expect(test.locations()).toEqual(["slide 1", "slide 2"]);
  });
});

describe("archive security limits", () => {
  it("extracts nested text and visibly reports unsupported members", async () => {
    const test = fixture(zip([
      { name: "folder/notes.txt", data: "useful archive evidence" }, { name: "script.exe", data: "MZ" },
    ]), { name: "bundle.zip" });
    await test.run(true);
    expect(test.attachment().status).toBe("partial");
    expect(test.text()).toContain("useful archive evidence");
    expect(test.locations()[0]).toBe("folder/notes.txt: lines 1–1");
  });
  it.each(["../escape.txt", "C:/escape.txt", "folder\\escape.txt", "/absolute.txt", "CON.txt"])("blocks unsafe entry %s", async name => {
    const test = fixture(zip([{ name, data: "unsafe" }]), { name: "unsafe.zip" });
    await test.run(true);
    expect(test.attachment().status).toBe("blocked");
    expect(test.text()).toBe("");
  });
  it("blocks symbolic links and compressed bombs even after approval", async () => {
    for (const entry of [{ name: "link", data: "../outside", mode: 0xa1ff }, { name: "huge.txt", data: "A".repeat(100000), compressed: true }]) {
      const test = fixture(zip([entry]), { name: "unsafe.zip" });
      await test.run(true);
      expect(test.attachment().status).toBe("blocked");
    }
  });
  it("reports encrypted archives", async () => {
    const test = fixture(zip([{ name: "secret.txt", data: "private", encrypted: true }]), { name: "secret.zip" });
    await test.run(true);
    expect(test.attachment().status).toBe("encrypted");
  });
  it("rejects dangerous XML and disguised macro packages", async () => {
    for (const files of [
      [{ name: "[Content_Types].xml", data: '<!DOCTYPE x [<!ENTITY x SYSTEM "https://invalid">]><Types>&x;</Types>' }],
      [{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/vbaProject.bin", data: "macro" }],
    ]) {
      const test = fixture(zip(files), { name: "unsafe.docx" });
      await test.run(true);
      expect(test.attachment().status).toBe("blocked");
    }
  });
  it("bounds nested archives", async () => {
    let bytes = zip([{ name: "notes.txt", data: "deep text" }]);
    for (let i = 0; i < 4; i++) bytes = zip([{ name: "nested.zip", data: bytes }]);
    const test = fixture(bytes, { name: "deep.zip" });
    await test.run(true);
    expect(test.attachment().status).toBe("blocked");
    expect(test.attachment().reason).toContain("recursion");
  });
});
