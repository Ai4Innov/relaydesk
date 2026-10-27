import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOcrModels, OCR_MODELS } from "../src/main/attachments/ocr-models";

const directories: string[] = [];
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), "relay-ocr-")); directories.push(directory); return directory; };
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const bytes = Buffer.from("fake traineddata");
const model = { language: "eng", file: "eng.traineddata", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const response = (body: Buffer) => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer });

describe("automatic OCR model installation", () => {
  it("pins exact upstream files with SHA-256 digests for English and French", () => {
    expect(OCR_MODELS.map(item => item.language)).toEqual(["eng", "fra"]);
    for (const item of OCR_MODELS) expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("downloads verified models once and records them while preserving other manifest entries", async () => {
    const directory = await temp();
    await writeFile(join(directory, "models.json"), JSON.stringify({ version: 1, transcription: { file: "w.bin", sha256: "a".repeat(64) } }));
    const fetcher = vi.fn(async (url: string) => { expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/[a-f0-9]{40}\/eng\.traineddata$/); return response(bytes); });
    await ensureOcrModels(directory, fetcher, [model]);
    await ensureOcrModels(directory, fetcher, [model]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, "eng.traineddata"))).toEqual(bytes);
    expect(JSON.parse(await readFile(join(directory, "models.json"), "utf8"))).toEqual({ version: 1,
      transcription: { file: "w.bin", sha256: "a".repeat(64) }, ocr: { languages: [{ language: "eng", file: "eng.traineddata", sha256: model.sha256 }] } });
  });
  it("rejects tampered downloads, writes nothing, and can retry later", async () => {
    const directory = await temp();
    const bad = vi.fn(async () => response(Buffer.from("tampered tramed")));
    await expect(ensureOcrModels(directory, bad, [model])).rejects.toThrow("integrity");
    await expect(readFile(join(directory, "models.json"))).rejects.toThrow();
    await ensureOcrModels(directory, vi.fn(async () => response(bytes)), [model]);
    expect(JSON.parse(await readFile(join(directory, "models.json"), "utf8")).ocr.languages).toHaveLength(1);
  });
  it("never overrides a user-configured OCR model", async () => {
    const directory = await temp();
    await writeFile(join(directory, "models.json"), JSON.stringify({ version: 1, ocr: { language: "deu", file: "deu.traineddata", sha256: "b".repeat(64) } }));
    const fetcher = vi.fn();
    await ensureOcrModels(directory, fetcher, [model]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses a single canvas native addon shared with pdf.js (two copies crash scanned-PDF rendering)", () => {
    const root = createRequire(join(process.cwd(), "package.json"));
    const fromPdf = createRequire(root.resolve("pdfjs-dist/package.json"));
    expect(dirname(fromPdf.resolve("@napi-rs/canvas"))).toBe(dirname(root.resolve("@napi-rs/canvas")));
  });
});