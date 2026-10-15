"use strict";

// This is a shipped CommonJS worker asset, not runtime-transpiled TypeScript.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { freemem } = require("node:os");
const { syncBuiltinESMExports } = require("node:module");

const denyNetwork = () => { throw new Error("Parser network access is disabled."); };
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
for (const module of ["node:http", "node:https"]) {
  const api = require(module);
  api.request = denyNetwork;
  api.get = denyNetwork;
}
for (const module of ["node:net", "node:tls"]) {
  const api = require(module);
  api.connect = denyNetwork;
  api.createConnection = denyNetwork;
}
require("node:net").Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();

const LIMITS = { entries: 2000, expanded: 128 * 1048576, entry: 32 * 1048576, ratio: 200, depth: 3, characters: 2_000_000, segments: 10000, pages: 300, pixels: 16_000_000 };
class Failure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const budget = { entries: 0, expanded: 0, characters: 0, segments: 0 };
const warnings = new Set();
let incompleteStatus;
const children = new Set();
parentPort.on("message", message => {
  if (message === "cancel") for (const child of children) child.kill();
});
function partial(reason) { warnings.add(reason); }
function segment(text, location) {
  text = String(text).replace(/\u0000/g, "").trim();
  if (!text) return [];
  if (budget.characters + text.length > LIMITS.characters || ++budget.segments > LIMITS.segments)
    throw new Failure("blocked", "Extraction exceeded its bounded text/segment budget. Original retained encrypted.");
  budget.characters += text.length;
  return [{ text, location }];
}
function utf8(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || /[\x01-\x08\x0b\x0e-\x1f]/.test(text))
      throw new Error("Binary data");
    return text.replace(/^\uFEFF/, "");
  } catch { throw new Failure("unsupported", "Only valid UTF-8 plain text is indexed; binary or legacy-encoded content was not interpreted."); }
}
function extension(name) { return name.split(".").pop().toLowerCase(); }
function kind(name, mime = "") {
  const ext = extension(name);
  const map = { txt: "text", csv: "csv", pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx", png: "image", jpg: "image", jpeg: "image", webp: "image", bmp: "image", tif: "image", tiff: "image", zip: "zip", wav: "media", mp3: "media", m4a: "media", ogg: "media", flac: "media", mp4: "media", mov: "media", webm: "media", mkv: "media", avi: "media" };
  if (/^(exe|dll|com|bat|cmd|ps1|js|vbs|hta|msi|scr|lnk|url|html?|svg|docm|xlsm|pptm|xlsb)$/.test(ext)) return;
  return map[ext] ?? ({
    "text/plain": "text", "text/csv": "csv", "application/pdf": "pdf", "application/zip": "zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  })[mime.split(";")[0].trim().toLowerCase()];
}
function signature(bytes, format) {
  const start = bytes.subarray(0, 16);
  if (start.subarray(0, 2).toString() === "MZ" || start.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    throw new Failure("blocked", "Executable content was detected; extraction was refused.");
  const zip = start[0] === 0x50 && start[1] === 0x4b && [0x03, 0x05, 0x07].includes(start[2]);
  if (["docx", "xlsx", "pptx", "zip"].includes(format) && !zip) {
    if (start.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new Failure("encrypted", "Encrypted or legacy Office content cannot be extracted.");
    throw new Failure("blocked", "File content does not match its declared ZIP/Office format.");
  }
  if (format === "pdf" && !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new Failure("blocked", "File content does not match its declared PDF format.");
  if (format === "image") {
    const image = start.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      (start[0] === 0xff && start[1] === 0xd8) || start.subarray(0, 2).toString() === "BM" ||
      start.subarray(0, 4).toString() === "II*\0" || start.subarray(0, 4).toString() === "MM\0*" ||
      (start.subarray(0, 4).toString() === "RIFF" && start.subarray(8, 12).toString() === "WEBP");
    if (!image) throw new Failure("blocked", "File content does not match a supported raster image.");
  }
  if (format === "media") {
    const media = start.subarray(0, 3).toString() === "ID3" || (start[0] === 0xff && (start[1] & 0xe0) === 0xe0) ||
      ["RIFF", "OggS", "fLaC"].includes(start.subarray(0, 4).toString()) ||
      start.subarray(4, 8).toString() === "ftyp" || start.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
    if (!media) throw new Failure("blocked", "File content does not match a supported local media container.");
  }
}

function safeEntry(entry) {
  const name = entry.fileName;
  const parts = name.replace(/\\/g, "/").split("/");
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (name.includes("\0") || /[\\:]/.test(name) || name.startsWith("/") || parts.includes("..") ||
      parts.some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      (unixMode & 0xf000) === 0xa000 || ((unixMode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(unixMode & 0xf000)))
    throw new Failure("blocked", "Unsafe archive path, symbolic link or special entry detected.");
  if (entry.generalPurposeBitFlag & 1) throw new Failure("encrypted", "Password-protected archive entries cannot be extracted.");
  if (![0, 8].includes(entry.compressionMethod)) throw new Failure("unsupported", "Archive compression method is unsupported.");
  if (++budget.entries > LIMITS.entries) throw new Failure("blocked", "Archive exceeds the 2,000-entry resource budget.");
  budget.expanded += entry.uncompressedSize;
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > LIMITS.entry ||
      budget.expanded > LIMITS.expanded || entry.uncompressedSize / Math.max(1, entry.compressedSize) > LIMITS.ratio)
    throw new Failure("blocked", "Archive exceeds entry size, total expansion or compression-ratio safety limits.");
}
async function zipEntries(bytes) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(new Failure("failed", "Corrupt ZIP directory.")); return; }
      const result = new Map();
      let finished = false;
      const fail = error => { if (finished) return; finished = true; zip.close(); reject(error); };
      zip.on("error", () => fail(new Failure("blocked", "Invalid archive structure, path or decompressed size.")));
      zip.on("entry", entry => {
        try {
          safeEntry(entry);
          if (result.has(entry.fileName)) throw new Failure("blocked", "Duplicate archive entry names are ambiguous.");
          if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
        } catch (error) { fail(error); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(new Failure("failed", "Archive entry could not be decoded.")); return; }
          let size = 0;
          const chunks = [];
          stream.on("data", chunk => {
            size += chunk.length;
            if (size > LIMITS.entry || size > entry.uncompressedSize) {
              stream.destroy();
              fail(new Failure("blocked", "Archive expansion did not match its declared size."));
            } else chunks.push(chunk);
          });
          stream.on("error", () => fail(new Failure("blocked", "Archive entry failed decompression validation.")));
          stream.on("end", () => {
            if (finished) return;
            if (size !== entry.uncompressedSize) { fail(new Failure("blocked", "Archive entry size mismatch.")); return; }
            const content = Buffer.concat(chunks);
            // ZIP CRC protects against corruption that size validation alone cannot catch.
            if (crc32(content) !== entry.crc32) { fail(new Failure("failed", "Archive checksum mismatch.")); return; }
            result.set(entry.fileName, content);
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => { if (!finished) { finished = true; resolve(result); } });
      zip.readEntry();
    });
  });
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function xml(bytes) {
  const text = utf8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Failure("blocked", "XML entities and document type declarations are prohibited.");
  const { XMLParser, XMLValidator } = require("fast-xml-parser");
  if (XMLValidator.validate(text) !== true) throw new Failure("failed", "Malformed Office XML.");
  return new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false, trimValues: false }).parse(text);
}
function xmlText(node, key, output = []) {
  if (!node || typeof node !== "object") return output;
  for (const [name, value] of Object.entries(node)) {
    if (name === key) {
      for (const item of Array.isArray(value) ? value : [value])
        output.push(typeof item === "object" ? String(item["#text"] ?? "") : String(item));
    } else if (Array.isArray(value)) for (const item of value) xmlText(item, key, output);
    else if (typeof value === "object") xmlText(value, key, output);
  }
  return output;
}
function decodeEntities(text) {
  // Office XML text needs the five XML entities, but never custom entity expansion.
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);/g, value => {
    if (value.startsWith("&#")) {
      const point = value.startsWith("&#x") ? parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[value];
  });
}
function nodes(node, key) {
  if (!node || typeof node !== "object") return [];
  const result = [];
  for (const [name, value] of Object.entries(node)) {
    if (name === key) result.push(...(Array.isArray(value) ? value : [value]));
    else for (const child of Array.isArray(value) ? value : [value]) result.push(...nodes(child, key));
  }
  return result;
}
function relationships(entries, name) {
  const content = entries.get(name);
  return content ? nodes(xml(content), "Relationship").filter(value => value["@_TargetMode"] !== "External") : [];
}
async function office(bytes, format, location) {
  const entries = await zipEntries(bytes);
  if (!entries.has("[Content_Types].xml")) throw new Failure("blocked", "ZIP is not a valid Office package.");
  for (const [name, content] of entries) {
    if (/vbaProject|(?:^|\/)embeddings\//i.test(name))
      throw new Failure("blocked", "Office packages containing macros or embedded objects are not processed.");
    if (/\.(xml|rels)$/i.test(name)) xml(content);
    if (/\.rels$/i.test(name) && /TargetMode\s*=\s*["']External["']/i.test(content.toString("utf8")))
      partial("External Office relationships were not fetched or followed.");
  }
  if (format === "docx") {
    if (!entries.has("word/document.xml")) throw new Failure("blocked", "Document content does not match DOCX.");
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes }, { externalFileAccess: false });
    if (result.messages.length) partial("The document parser reported unsupported or incomplete document content.");
    return result.value.split(/\n\s*\n/).flatMap((text, index) => segment(text, `${location}paragraph ${index + 1}`));
  }
  if (format === "xlsx") {
    if (!entries.has("xl/workbook.xml")) throw new Failure("blocked", "Workbook content does not match XLSX.");
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const result = [];
    workbook.eachSheet(sheet => {
      sheet.eachRow(row => {
        row.eachCell(cell => {
          let text = cell.text;
          if (cell.value && typeof cell.value === "object" && ("formula" in cell.value || "sharedFormula" in cell.value)) {
            const cached = cell.result;
            text = cached === undefined ? "" : String(cached);
            if (cached === undefined) partial("Spreadsheet formulas without cached values were not calculated.");
          }
          result.push(...segment(text, `${location}sheet ${sheet.name}, cell ${cell.address}`));
        });
      });
    });
    return result;
  }
  if (!entries.has("ppt/presentation.xml")) throw new Failure("blocked", "Presentation content does not match PPTX.");
  const slideIds = nodes(xml(entries.get("ppt/presentation.xml")), "p:sldId");
  const links = relationships(entries, "ppt/_rels/presentation.xml.rels");
  const slides = slideIds.length ? slideIds.map(id => {
    const link = links.find(value => value["@_Id"] === id["@_r:id"]);
    if (!link) throw new Failure("failed", "Presentation slide relationship is missing.");
    const target = path.posix.normalize(path.posix.join("ppt", link["@_Target"]));
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(target) || !entries.has(target))
      throw new Failure("blocked", "Presentation slide relationship is unsafe or invalid.");
    return target;
  }) : [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const result = [];
  for (const [index, slide] of slides.entries()) {
    const number = index + 1;
    result.push(...segment(decodeEntities(xmlText(xml(entries.get(slide)), "a:t").join("\n")), `${location}slide ${number}`));
    const notesLink = relationships(entries, `ppt/slides/_rels/${path.posix.basename(slide)}.rels`)
      .find(value => String(value["@_Type"]).endsWith("/notesSlide"));
    const notesName = notesLink ? path.posix.normalize(path.posix.join("ppt/slides", notesLink["@_Target"])) : "";
    const notes = /^ppt\/notesSlides\/[^/]+\.xml$/.test(notesName) ? entries.get(notesName) : undefined;
    if (notes) result.push(...segment(decodeEntities(xmlText(xml(notes), "a:t").join("\n")), `${location}slide ${number}, notes`));
  }
  return result;
}

function modelConfig() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(workerData.modelDirectory, "models.json"), "utf8"));
    if (manifest.version !== 1) throw new Error();
    return manifest;
  } catch { throw new Failure("blocked", "Local OCR/transcription models are not configured. Install reviewed models and their SHA-256 manifest; no model is downloaded automatically."); }
}
async function checkedModel(config) {
  if (!config || !/^[a-zA-Z0-9_.-]+$/.test(config.file) || !/^[a-f0-9]{64}$/i.test(config.sha256))
    throw new Failure("blocked", "Model configuration requires a local filename and verified SHA-256 digest.");
  const filename = path.resolve(workerData.modelDirectory, config.file);
  const root = fs.realpathSync(workerData.modelDirectory);
  let actual;
  try { actual = fs.realpathSync(filename); }
  catch { throw new Failure("blocked", "Configured local model is missing. No network fallback is permitted."); }
  if (path.dirname(actual) !== root) throw new Failure("blocked", "Model path escapes the configured model directory.");
  if (fs.statSync(actual).size > Math.min(512 * 1048576, freemem() / 8))
    throw new Failure("blocked", "The selected local model exceeds the current model-memory budget; configure a smaller reviewed model.");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(actual)) hash.update(chunk);
  if (hash.digest("hex").toLowerCase() !== config.sha256.toLowerCase())
    throw new Failure("blocked", "Local model integrity check failed.");
  return actual;
}
async function ocr(bytes) {
  if (!workerData.approved) throw new Failure("awaiting-approval", "Scanned pages require explicit approval before local OCR.");
  const config = modelConfig().ocr;
  await checkedModel(config);
  const language = config.language ?? "eng";
  if (!/^[a-z]{3}$/.test(language) || config.file !== `${language}.traineddata`)
    throw new Failure("blocked", "OCR needs an uncompressed local language.traineddata file matching the manifest.");
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker(language, 1, {
    langPath: workerData.modelDirectory, gzip: false, cacheMethod: "none",
    workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
    corePath: require.resolve("tesseract.js-core"),
    logger: () => {}, errorHandler: () => {},
  });
  try { return (await worker.recognize(bytes)).data.text; }
  finally { await worker.terminate(); }
}
async function raster(bytes) {
  const [width, height] = rasterDimensions(bytes);
  if (!width || !height || width * height > LIMITS.pixels)
    throw new Failure("blocked", "Raster image exceeds the 16-megapixel OCR budget or has unsupported dimensions.");
  let canvas;
  try { canvas = require("@napi-rs/canvas"); }
  catch { throw new Failure("blocked", "Local raster/OCR renderer is unavailable. Install the packaged PDF canvas dependency."); }
  const image = await canvas.loadImage(bytes);
  if (image.width * image.height > LIMITS.pixels)
    throw new Failure("blocked", "Raster image exceeds the 16-megapixel OCR resource budget.");
  const target = canvas.createCanvas(image.width, image.height);
  target.getContext("2d").drawImage(image, 0, 0);
  return target.toBuffer("image/png");
}
function rasterDimensions(bytes) {
  // Validate dimensions before native decoding, whose allocations are outside V8's heap limit.
  try {
    if (bytes.subarray(1, 4).toString() === "PNG") return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (bytes.subarray(0, 2).toString() === "BM") {
      if (bytes.readUInt32LE(14) === 12) return [bytes.readUInt16LE(18), bytes.readUInt16LE(20)];
      return [Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22))];
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset++] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = bytes.readUInt16BE(offset);
        if (length < 2) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
          return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
        offset += length;
      }
    }
    if (bytes.subarray(8, 12).toString() === "WEBP") {
      const type = bytes.subarray(12, 16).toString();
      if (type === "VP8X") {
        if (bytes[20] & 2) throw new Failure("blocked", "Animated images are outside the single-raster OCR resource budget.");
        return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
      }
      if (type === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      }
      if (type === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a])))
        return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    }
    if (["II", "MM"].includes(bytes.subarray(0, 2).toString())) {
      const little = bytes[0] === 0x49;
      const u16 = offset => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
      const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      const offset = u32(4);
      const count = u16(offset);
      if (count > 1024) return [];
      let width, height;
      for (let i = 0; i < count; i++) {
        const tag = offset + 2 + i * 12;
        if (![256, 257].includes(u16(tag)) || u32(tag + 4) !== 1) continue;
        const value = u16(tag + 2) === 3 ? u16(tag + 8) : u16(tag + 2) === 4 ? u32(tag + 8) : 0;
        if (u16(tag) === 256) width = value; else height = value;
      }
      if (u32(offset + 2 + count * 12)) throw new Failure("blocked", "Multipage TIFF requires a PDF export for page-bounded OCR.");
      return [width, height];
    }
  } catch (error) { if (error instanceof Failure) throw error; }
  throw new Failure("blocked", "Image dimensions could not be validated safely before decoding.");
}
async function pdf(bytes, location) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes), isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, verbosity: 0, maxImageSize: LIMITS.pixels,
    stopAtErrors: true,
  });
  let document;
  try {
    document = await task.promise;
    const result = [];
    const pages = Math.min(document.numPages, LIMITS.pages);
    if (pages < document.numPages) partial("Only the first 300 pages were processed within the page resource budget.");
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        if (text) result.push(...segment(text, `${location}page ${pageNumber}`));
        else {
          try {
            if (!workerData.approved) throw new Failure("awaiting-approval", "Scanned PDF pages await explicit local OCR approval.");
            let canvas;
            try { canvas = require("@napi-rs/canvas"); }
            catch { throw new Failure("blocked", "Scanned PDF rendering requires the local canvas dependency."); }
            const viewport = page.getViewport({ scale: 1.5 });
            if (viewport.width * viewport.height > LIMITS.pixels) throw new Failure("blocked", "PDF page exceeds the OCR pixel resource budget.");
            const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvasContext: surface.getContext("2d"), viewport, canvas: surface }).promise;
            result.push(...segment(await ocr(surface.toBuffer("image/png")), `${location}page ${pageNumber}, OCR`));
          } catch (error) {
            if (!(error instanceof Failure)) throw error;
            incompleteStatus = error.status;
            partial(error.message);
          }
        }
      } finally { page.cleanup(); }
    }
    return result;
  } catch (error) {
    if (error?.name === "PasswordException") throw new Failure("encrypted", "Password-protected PDF cannot be extracted.");
    throw error;
  } finally { await task.destroy(); }
}
function localBinary(variable) {
  const filename = process.env[variable];
  if (!filename || !path.isAbsolute(filename) || !fs.existsSync(filename))
    throw new Failure("blocked", `Local media transcription requires an explicitly configured ${variable} absolute binary path.`);
  return filename;
}
function run(binary, arguments_, input, maxBuffer, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: process.env.SystemRoot ?? "", PATH: path.dirname(binary) },
    });
    children.add(child);
    const chunks = [];
    let outputSize = 0, errorSize = 0, exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, timeout);
    child.stdout.on("data", chunk => {
      outputSize += chunk.length;
      if (outputSize > maxBuffer) { exceeded = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => {
      errorSize += chunk.length;
      if (errorSize > 1048576) { exceeded = true; child.kill(); }
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer); children.delete(child);
      reject(new Failure("blocked", "Configured local media tool could not be started."));
    });
    child.once("close", code => {
      clearTimeout(timer); children.delete(child);
      if (exceeded || code !== 0) reject(new Failure("blocked", "Local media tool failed or exceeded its time/output budget. Check trusted binaries and a compatible model."));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
async function media(bytes, location) {
  if (!workerData.approved) throw new Failure("awaiting-approval", "Media transcription requires explicit approval.");
  const ffmpeg = localBinary("RELAY_FFMPEG_PATH");
  const whisper = localBinary("RELAY_WHISPER_CPP_PATH");
  const model = await checkedModel(modelConfig().transcription);
  // Input/output remain in anonymous pipes. Restrict protocols so playlists cannot
  // trigger network fetches or read arbitrary local files.
  const wav = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-max_alloc", "33554432", "-protocol_whitelist", "pipe", "-i", "pipe:0",
    "-vn", "-t", "600", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], bytes, 24 * 1048576, 60000);
  const transcript = (await run(whisper, ["-m", model, "-f", "-", "-l", "auto", "-t", "2"], wav, 4 * 1048576, 120000)).toString("utf8");
  const result = [];
  for (const line of transcript.split(/\r?\n/)) {
    const match = line.match(/^\s*\[(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})\]\s*(.+)$/);
    if (match) result.push(...segment(match[3], `${location}${match[1]}–${match[2]}`));
  }
  if (!result.length) throw new Failure("partial", "Local transcription produced no timestamped speech. Verify whisper.cpp stdin/timestamp support or audio content.");
  // The WAV data rate is 32,000 bytes/second; 600 seconds means the decoder limit was reached.
  if (wav.length >= 600 * 32000) partial("Media transcription is limited to the first ten minutes by the current resource budget.");
  return result;
}

async function extract(bytes, name, mime = "", location = "", depth = 0) {
  const format = kind(name, mime);
  if (!format) throw new Failure("unsupported", "Unsupported archive member/file type was not executed or interpreted.");
  signature(bytes, format);
  if (format === "text" || format === "csv") {
    const lines = utf8(bytes).split(/\r?\n/);
    const result = [];
    for (let start = 0; start < lines.length; start += 100)
      result.push(...segment(lines.slice(start, start + 100).join("\n"), `${location}${format === "csv" ? "CSV physical lines" : "lines"} ${start + 1}–${Math.min(start + 100, lines.length)}`));
    return result;
  }
  if (["docx", "xlsx", "pptx"].includes(format)) return office(bytes, format, location);
  if (format === "pdf") return pdf(bytes, location);
  if (format === "image") return segment(await ocr(await raster(bytes)), `${location}image OCR`);
  if (format === "media") return media(bytes, location);
  if (!workerData.approved) throw new Failure("awaiting-approval", "Archive expansion requires explicit approval.");
  if (depth >= LIMITS.depth) throw new Failure("blocked", "Archive nesting exceeds the three-level recursion budget.");
  const entries = await zipEntries(bytes);
  const result = [];
  for (const [entryName, content] of entries) {
    try { result.push(...await extract(content, entryName, "", `${location}${entryName}: `, depth + 1)); }
    catch (error) {
      if (error instanceof Failure && ["unsupported", "encrypted", "partial"].includes(error.status)) {
        partial(`Some archive members are ${error.status} and were not indexed.`);
      } else throw error;
    }
  }
  return result;
}

async function main() {
  try {
    const segments = await extract(Buffer.from(workerData.bytes), workerData.attachment.name, workerData.attachment.mimeType);
    parentPort.postMessage({
      segments,
      status: warnings.size ? (segments.length ? "partial" : incompleteStatus ?? "partial") : segments.length ? "indexed" : "partial",
      reason: warnings.size ? [...warnings].join(" ") : segments.length ? undefined : "No searchable text was found; extraction is not indexed.",
    });
  } catch (error) {
    parentPort.postMessage({
      segments: [], status: error instanceof Failure ? error.status : "failed",
      reason: error instanceof Failure ? error.message : "The isolated parser could not safely extract this file. It may be corrupt, unsupported or require a missing local component.",
    });
  }
}
void main();
