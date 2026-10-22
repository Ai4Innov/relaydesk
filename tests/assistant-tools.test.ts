import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocument, parseMarkdown, safeDocumentName } from "../src/main/documents";
import { insidePath, WorkspaceSessionFs } from "../src/main/copilot/workspace-fs";
import { MemorySessionFs } from "../src/main/copilot/memory-fs";
import { host } from "../src/main/platform";

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "relay-tools-")); dirs.push(dir); return dir; };
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const markdown = "# Weekly report\n\nSome **bold** and *italic* text.\n\n- First\n- Second\n\n1. One\n2. Two\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n\n## Next\n\nMore text.";

describe("assistant document generation", () => {
  it("parses markdown blocks", () => {
    expect(parseMarkdown(markdown).map(block => block.kind)).toEqual(["heading", "paragraph", "bullet", "bullet", "bullet", "bullet", "table", "heading", "paragraph"]);
    expect(safeDocumentName("..\\evil:name?", "docx")).not.toMatch(/[\\/:?]/);
  });
  it.each(["docx", "xlsx", "pptx"] as const)("writes a real %s file inside the workspace", async format => {
    const dir = await temp();
    const created = await createDocument(dir, { fileName: "report", format, title: "Weekly report", content: markdown,
      sheets: format === "xlsx" ? [{ name: "Data", rows: [["Name", "Value"], ["A", "1"]] }] : undefined });
    expect(insidePath(dir, created.path)).toBe(true);
    expect(created.name).toBe(`report.${format}`);
    const bytes = await readFile(created.path);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(created.size).toBe(bytes.length);
  });
  it("does not overwrite an existing file unless asked", async () => {
    const dir = await temp();
    const first = await createDocument(dir, { fileName: "notes", format: "md", content: "one" });
    const second = await createDocument(dir, { fileName: "notes", format: "md", content: "two" });
    expect(second.path).not.toBe(first.path);
    expect(await readFile(first.path, "utf8")).toContain("one");
  });
  it("renders PDFs through the desktop renderer from escaped, print-styled HTML", async () => {
    const dir = await temp();
    let rendered = "";
    const created = await createDocument(dir, { fileName: "brief", format: "pdf", title: "Brief", content: markdown + "\n\n<script>alert(1)</script>" },
      { renderPdf: async html => { rendered = html; return Buffer.from("%PDF-1.7 synthetic"); } });
    expect(created.name).toBe("brief.pdf");
    expect((await readFile(created.path)).subarray(0, 4).toString()).toBe("%PDF");
    expect(rendered).toContain("<h1>Brief</h1>");
    expect(rendered).toContain("break-inside:avoid");
    expect(rendered).not.toContain("<script>");
    await expect(createDocument(dir, { fileName: "x", format: "pdf", content: "x" })).rejects.toThrow("desktop app");
  });
});

describe("workspace session filesystem", () => {
  it("allows the workspace, keeps session state in memory and denies other paths", async () => {
    const workspace = await temp(), outside = await temp();
    await writeFile(join(outside, "secret.txt"), "secret");
    const fs = new WorkspaceSessionFs(new MemorySessionFs(), workspace);
    await fs.writeFile(join(workspace, "a.txt"), "hello");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(join(workspace, "a.txt"))).toBe("hello");
    const state = host.path.join(host.sessionRoot, "state");
    await fs.mkdir(state, true);
    await fs.writeFile(host.path.join(state, "x.json"), "{}");
    expect(await fs.readFile(host.path.join(state, "x.json"))).toBe("{}");
    await expect(fs.readFile(join(outside, "secret.txt"))).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.writeFile(join(outside, "new.txt"), "x")).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.writeFile(join(workspace, "..", "escape.txt"), "x")).rejects.toMatchObject({ code: "EACCES" });
  });
  it("allows reads, never writes, for user-approved outside paths", async () => {
    const workspace = await temp(), outside = await temp();
    const file = join(outside, "approved.txt");
    await writeFile(file, "ok");
    const fs = new WorkspaceSessionFs(new MemorySessionFs(), workspace, path => path === file);
    expect(await fs.readFile(file)).toBe("ok");
    await expect(fs.writeFile(file, "changed")).rejects.toMatchObject({ code: "EACCES" });
  });
  it("edits and deletes only the exact outside files the write check approved", async () => {
    const workspace = await temp(), outside = await temp();
    const file = join(outside, "plan.md"), other = join(outside, "other.md");
    await writeFile(file, "old"); await writeFile(other, "keep");
    const fs = new WorkspaceSessionFs(new MemorySessionFs(), workspace, () => false, host, path => path === file);
    await fs.writeFile(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    await expect(fs.writeFile(other, "x")).rejects.toMatchObject({ code: "EACCES" });
    await fs.rm(file, false, false);
    expect(await fs.exists(file)).toBe(false);
  });
});
