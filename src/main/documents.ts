import { mkdir, stat, writeFile } from "node:fs/promises";
import { host } from "./platform";
import { insidePath } from "./copilot/workspace-fs";

export const DOCUMENT_FORMATS = ["docx", "pdf", "xlsx", "pptx", "md", "txt", "csv", "html"] as const;
type DocumentFormat = typeof DOCUMENT_FORMATS[number];
interface DocumentRequest {
  fileName: string;
  format: DocumentFormat;
  title?: string;
  content?: string;
  sheets?: { name: string; rows: string[][] }[];
  overwrite?: boolean;
}
interface CreatedDocument { path: string; name: string; format: DocumentFormat; size: number }

type Inline = { text: string; bold?: boolean; italics?: boolean; code?: boolean };
type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "bullet"; ordered: boolean; level: number; inline: Inline[] }
  | { kind: "table"; rows: Inline[][][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) result.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) result.push({ text: match[2], bold: true });
    else if (match[4] !== undefined) result.push({ text: match[4], italics: true });
    else if (match[5] !== undefined) result.push({ text: match[5], code: true });
    else result.push({ text: `${match[6]} (${match[7]})` });
    last = match.index! + match[0].length;
  }
  if (last < text.length) result.push({ text: text.slice(last) });
  return result.length ? result : [{ text: "" }];
}
const plain = (inline: Inline[]) => inline.map(part => part.text).join("");
const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => parseInline(cell.trim()));

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) }); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2].trim()) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const rows = [tableCells(line)];
      i++;
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(tableCells(lines[++i]));
      blocks.push({ kind: "table", rows });
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: "bullet", ordered: /\d/.test(bullet[2]), level: Math.min(4, Math.floor(bullet[1].replace(/\t/g, "  ").length / 2)), inline: parseInline(bullet[3]) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

async function docx(title: string | undefined, markdown: string): Promise<Buffer> {
  const { AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const runs = (inline: Inline[], bold = false) => inline.map(part => new TextRun({ text: part.text, bold: part.bold || bold, italics: part.italics, font: part.code ? "Consolas" : undefined }));
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  let orderedInstance = 0, previousOrdered = false;
  for (const block of parseMarkdown(markdown)) {
    if (block.kind !== "bullet" || !block.ordered) previousOrdered = false;
    if (block.kind === "heading") children.push(new Paragraph({ heading: headingLevels[block.level - 1], children: runs(block.inline) }));
    else if (block.kind === "paragraph") children.push(new Paragraph({ children: runs(block.inline), spacing: { after: 120 } }));
    else if (block.kind === "bullet") {
      if (block.ordered && !previousOrdered) orderedInstance++;
      previousOrdered = block.ordered;
      children.push(new Paragraph({ children: runs(block.inline),
        ...(block.ordered ? { numbering: { reference: "relay-numbered", level: block.level, instance: orderedInstance } } : { bullet: { level: block.level } }) }));
    } else if (block.kind === "code") {
      for (const line of block.text.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })] }));
    } else if (block.kind === "rule") {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
    } else if (block.kind === "table") {
      const width = Math.max(...block.rows.map(row => row.length));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({
        tableHeader: index === 0,
        children: Array.from({ length: width }, (_, cell) => new TableCell({ children: [new Paragraph({ children: runs(row[cell] ?? [{ text: "" }], index === 0) })] }))
      })) }));
      children.push(new Paragraph({ children: [] }));
    }
  }
  const document = new Document({
    creator: "Relay Desk", title: title ?? "Document",
    numbering: { config: [{ reference: "relay-numbered", levels: [0, 1, 2, 3, 4].map(level => ({
      level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
    })) }] },
    sections: [{ children }]
  });
  return Packer.toBuffer(document);
}

function cellValue(value: string): string | number {
  const trimmed = value.trim();
  return /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(trimmed) && trimmed.length < 16 ? Number(trimmed.replace(/,/g, "")) : value;
}
async function xlsx(title: string | undefined, sheets: DocumentRequest["sheets"], markdown: string): Promise<Buffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Relay Desk";
  let data = sheets ?? [];
  if (!data.length) {
    const tables = parseMarkdown(markdown).filter((block): block is Extract<Block, { kind: "table" }> => block.kind === "table");
    data = tables.map((table, index) => ({ name: `Table ${index + 1}`, rows: table.rows.map(row => row.map(plain)) }));
  }
  if (!data.length) throw new Error("Provide sheets (rows of cells) or a Markdown table for an .xlsx file.");
  const used = new Set<string>();
  for (const sheet of data) {
    let name = (sheet.name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Sheet";
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    const worksheet = workbook.addWorksheet(name);
    for (const row of sheet.rows) worksheet.addRow(row.map(cellValue));
    if (sheet.rows.length) {
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
    }
    worksheet.columns.forEach((column, index) => {
      const longest = Math.max(8, ...sheet.rows.map(row => String(row[index] ?? "").length));
      column.width = Math.min(60, longest + 2);
    });
  }
  if (title) workbook.title = title;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function pptx(title: string | undefined, markdown: string): Promise<Buffer> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "Relay Desk";
  if (title) deck.title = title;
  const blocks = parseMarkdown(markdown);
  type Slide = { title: string; blocks: Block[] };
  const slides: Slide[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level <= 2) slides.push({ title: plain(block.inline), blocks: [] });
    else if (block.kind === "rule") slides.push({ title: "", blocks: [] });
    else {
      if (!slides.length) slides.push({ title: title ?? "", blocks: [] });
      slides[slides.length - 1].blocks.push(block);
    }
  }
  if (title && !(slides.length && slides[0].title === title && !slides[0].blocks.length)) {
    const cover = deck.addSlide();
    cover.addText(title, { x: 0.6, y: 2.6, w: 12.1, h: 1.4, fontSize: 40, bold: true, color: "1F2937" });
  }
  for (const item of slides.length ? slides : [{ title: title ?? "Slide", blocks: [] }]) {
    const slide = deck.addSlide();
    if (item.title) slide.addText(item.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: "1F2937" });
    const text: { text: string; options: Record<string, unknown> }[] = [];
    let y = item.title ? 1.4 : 0.5;
    for (const block of item.blocks) {
      if (block.kind === "table") {
        if (text.length) { slide.addText(text.splice(0), { x: 0.6, y, w: 12.1, h: 2.6, fontSize: 18, valign: "top" }); y += 2.7; }
        slide.addTable(block.rows.map((row, index) => row.map(cell => ({ text: plain(cell), options: { bold: index === 0, fill: { color: index === 0 ? "E5E7EB" : "FFFFFF" } } }))),
          { x: 0.6, y, w: 12.1, fontSize: 14, border: { type: "solid", pt: 0.5, color: "9CA3AF" } });
        y += 0.4 * block.rows.length + 0.3;
        continue;
      }
      const content = block.kind === "code" ? block.text : block.kind === "rule" ? "" : plain(block.inline);
      text.push({ text: content, options: {
        breakLine: true, bold: block.kind === "heading",
        ...(block.kind === "bullet" ? { bullet: block.ordered ? { type: "number" } : true, indentLevel: block.level } : {}),
        ...(block.kind === "code" ? { fontFace: "Consolas", fontSize: 14 } : {})
      } });
    }
    if (text.length) slide.addText(text, { x: 0.6, y, w: 12.1, h: Math.max(1, 7.0 - y), fontSize: 18, valign: "top", fit: "shrink" });
  }
  return await deck.write({ outputType: "nodebuffer" }) as Buffer;
}

function html(title: string | undefined, markdown: string, print = false): string {
  const escape = (value: string) => value.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!);
  const inline = (parts: Inline[]) => parts.map(part => {
    const text = escape(part.text);
    return part.code ? `<code>${text}</code>` : part.bold ? `<strong>${text}</strong>` : part.italics ? `<em>${text}</em>` : text;
  }).join("");
  const body: string[] = [];
  let list: "ul" | "ol" | undefined;
  for (const block of parseMarkdown(markdown)) {
    const wanted = block.kind === "bullet" ? (block.ordered ? "ol" : "ul") : undefined;
    if (list && list !== wanted) { body.push(`</${list}>`); list = undefined; }
    if (wanted && !list) { body.push(`<${wanted}>`); list = wanted; }
    if (block.kind === "heading") body.push(`<h${block.level}>${inline(block.inline)}</h${block.level}>`);
    else if (block.kind === "paragraph") body.push(`<p>${inline(block.inline)}</p>`);
    else if (block.kind === "bullet") body.push(`<li>${inline(block.inline)}</li>`);
    else if (block.kind === "code") body.push(`<pre><code>${escape(block.text)}</code></pre>`);
    else if (block.kind === "rule") body.push("<hr>");
    else body.push(`<table>${block.rows.map((row, index) => `<tr>${row.map(cell => index === 0 ? `<th>${inline(cell)}</th>` : `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</table>`);
  }
  if (list) body.push(`</${list}>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title ?? "Document")}</title><style>body{font-family:Segoe UI,Arial,sans-serif;max-width:860px;margin:${print ? "0 auto" : "40px auto"};line-height:1.5;color:#1f2937}table{border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:6px 10px}th{background:#f3f4f6}${print ? "h1,h2,h3{break-after:avoid}tr,pre{break-inside:avoid}pre{white-space:pre-wrap}" : ""}</style></head><body>${title ? `<h1>${escape(title)}</h1>` : ""}${body.join("\n")}</body></html>`;
}

function csv(sheets: DocumentRequest["sheets"], markdown: string): string {
  let rows = sheets?.[0]?.rows;
  if (!rows) {
    const table = parseMarkdown(markdown).find((block): block is Extract<Block, { kind: "table" }> => block.kind === "table");
    rows = table?.rows.map(row => row.map(plain));
  }
  if (!rows) throw new Error("Provide sheets (rows of cells) or a Markdown table for a .csv file.");
  return "\ufeff" + rows.map(row => row.map(cell => /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, "\"\"")}"` : cell).join(",")).join("\r\n") + "\r\n";
}

export function safeDocumentName(fileName: string, format: DocumentFormat): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120);
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) throw new Error("Choose a valid file name.");
  return `${base}.${format}`;
}

export interface DocumentRenderers { renderPdf?(html: string): Promise<Buffer> }

export async function createDocument(workspace: string, request: DocumentRequest, renderers: DocumentRenderers = {}): Promise<CreatedDocument> {
  if (request.format === "pdf" && !renderers.renderPdf) throw new Error("Documents can only be exported to PDF in the desktop app.");
  const name = safeDocumentName(request.fileName, request.format);
  await mkdir(workspace, { recursive: true });
  let path = host.path.join(workspace, name);
  if (!request.overwrite) {
    for (let n = 2; await stat(path).then(() => true, () => false); n++) {
      if (n > 999) throw new Error("Too many files with this name.");
      path = host.path.join(workspace, name.replace(/(\.[a-z]+)$/, ` (${n})$1`));
    }
  }
  if (!insidePath(workspace, path)) throw new Error("Documents can only be created in the Relay Desk workspace.");
  const content = request.content ?? "";
  const bytes = request.format === "docx" ? await docx(request.title, content)
    : request.format === "pdf" ? await renderers.renderPdf!(html(request.title, content, true))
    : request.format === "xlsx" ? await xlsx(request.title, request.sheets, content)
    : request.format === "pptx" ? await pptx(request.title, content)
    : Buffer.from(request.format === "html" ? html(request.title, content)
      : request.format === "csv" ? csv(request.sheets, content)
      : request.format === "md" && request.title && !/^#\s/.test(content) ? `# ${request.title}\n\n${content}` : content, "utf8");
  await writeFile(path, bytes);
  return { path, name: host.path.basename(path), format: request.format, size: bytes.length };
}
