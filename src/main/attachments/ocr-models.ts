import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pinned Tesseract "fast" models: an exact upstream commit plus a SHA-256 per file. */
const COMMIT = "87416418657359cb625c412a48b6e1d6d41c29bd";
export const OCR_MODELS = [
  { language: "eng", file: "eng.traineddata", size: 4_113_088, sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" },
  { language: "fra", file: "fra.traineddata", size: 1_130_365, sha256: "ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca" },
] as const;
const source = (file: string) => `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${COMMIT}/${file}`;

type Model = { language: string; file: string; size: number; sha256: string };
type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
const pending = new Map<string, Promise<void>>();

/**
 * Installs the pinned OCR models into `directory` once, then records them in models.json.
 * Existing user-configured OCR entries are left untouched. Every byte is hash-verified before use.
 */
export function ensureOcrModels(directory: string, fetcher: Fetch = fetch as unknown as Fetch, models: readonly Model[] = OCR_MODELS): Promise<void> {
  let work = pending.get(directory);
  if (!work) {
    work = install(directory, fetcher, models).catch(error => { pending.delete(directory); throw error; });
    pending.set(directory, work);
  }
  return work;
}

async function install(directory: string, fetcher: Fetch, models: readonly Model[]): Promise<void> {
  const manifestPath = join(directory, "models.json");
  let manifest: Record<string, unknown> = { version: 1 };
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.version === 1) manifest = parsed;
  } catch { /* missing or unreadable: rebuilt below with other entries absent */ }
  if (manifest.ocr) return;
  await mkdir(directory, { recursive: true });
  for (const model of models) {
    const target = join(directory, model.file);
    try { if (digest(await readFile(target)) === model.sha256) continue; } catch { /* download below */ }
    const response = await fetcher(source(model.file), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OCR model download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== model.size || digest(bytes) !== model.sha256) throw new Error("Downloaded OCR model failed its integrity check.");
    const temporary = `${target}.${randomUUID()}.part`;
    await writeFile(temporary, bytes);
    try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  const updated = { ...manifest, version: 1, ocr: { languages: models.map(({ language, file, sha256 }) => ({ language, file, sha256 })) } };
  const temporary = `${manifestPath}.${randomUUID()}.part`;
  await writeFile(temporary, JSON.stringify(updated, null, 2));
  await rename(temporary, manifestPath);
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
