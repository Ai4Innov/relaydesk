import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";
import type { MemorySessionFs } from "./memory-fs";

const SESSION_ROOT = "c:\\relay-session";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export function insidePath(root: string, path: string): boolean {
  const base = win32.resolve(root).toLowerCase().replace(/\\+$/, "");
  const target = win32.resolve(path).toLowerCase();
  return target === base || target.startsWith(base + "\\");
}
function denied(path: string, workspace: string): Error {
  return Object.assign(new Error(`Access denied: ${path} is outside the Relay Desk workspace (${workspace}). File tools can only use that folder; ask the user before using other locations.`), { code: "EACCES" });
}

/**
 * Session state stays in memory; built-in file tools may only touch the user's
 * assistant workspace, plus read-only paths the user approved during this turn.
 */
export class WorkspaceSessionFs implements SessionFsProvider {
  constructor(private memory: MemorySessionFs, private workspace: string, private readApproved: (path: string) => boolean = () => false) {}
  private isSession(path: string): boolean {
    return !win32.isAbsolute(path) || insidePath(SESSION_ROOT, path);
  }
  private async resolveReal(path: string): Promise<string> {
    // Resolve the nearest existing ancestor so symlinks/junctions cannot escape the workspace.
    let current = win32.resolve(path);
    const suffix: string[] = [];
    for (;;) {
      try { return win32.join(await realpath(current), ...suffix.reverse()); }
      catch {
        const parent = win32.dirname(current);
        if (parent === current) return win32.resolve(path);
        suffix.push(win32.basename(current)); current = parent;
      }
    }
  }
  private async disk(path: string, write: boolean): Promise<string> {
    const resolved = win32.resolve(path);
    const root = await this.resolveReal(this.workspace);
    if (insidePath(this.workspace, resolved) && insidePath(root, await this.resolveReal(resolved))) return resolved;
    if (!write && this.readApproved(resolved)) return resolved;
    throw denied(resolved, this.workspace);
  }
  async readFile(path: string): Promise<string> {
    if (this.isSession(path)) return this.memory.readFile(path);
    const target = await this.disk(path, false);
    if ((await stat(target)).size > MAX_TEXT_BYTES) throw new Error("File is too large for the text file tools. Use create_document or summarize a smaller file.");
    return readFile(target, "utf8");
  }
  async writeFile(path: string, content: string): Promise<void> {
    if (this.isSession(path)) return this.memory.writeFile(path, content);
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error("File content exceeds the 16 MB text limit.");
    await writeFile(await this.disk(path, true), content, "utf8");
  }
  async appendFile(path: string, content: string): Promise<void> {
    if (this.isSession(path)) return this.memory.appendFile(path, content);
    await appendFile(await this.disk(path, true), content, "utf8");
  }
  async exists(path: string): Promise<boolean> {
    if (this.isSession(path)) return this.memory.exists(path);
    try { await stat(await this.disk(path, false)); return true; } catch { return false; }
  }
  async stat(path: string): Promise<SessionFsFileInfo> {
    if (this.isSession(path)) return this.memory.stat(path);
    const info = await stat(await this.disk(path, false));
    return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtime: info.mtime.toISOString(), birthtime: info.birthtime.toISOString() };
  }
  async mkdir(path: string, recursive: boolean): Promise<void> {
    if (this.isSession(path)) return this.memory.mkdir(path, recursive);
    await mkdir(await this.disk(path, true), { recursive });
  }
  async readdir(path: string): Promise<string[]> {
    if (this.isSession(path)) return this.memory.readdir(path);
    return readdir(await this.disk(path, false));
  }
  async readdirWithTypes(path: string): Promise<{ name: string; type: "file" | "directory" }[]> {
    if (this.isSession(path)) return this.memory.readdirWithTypes(path);
    const entries = await readdir(await this.disk(path, false), { withFileTypes: true });
    return entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" as const : "file" as const }));
  }
  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    if (this.isSession(path)) return this.memory.rm(path, recursive, force);
    const target = await this.disk(path, true);
    if (insidePath(target, this.workspace)) throw new Error("The workspace folder itself cannot be removed.");
    await rm(target, { recursive, force });
  }
  async rename(src: string, dest: string): Promise<void> {
    const session = this.isSession(src);
    if (session !== this.isSession(dest)) throw new Error("Files cannot move between session state and the workspace.");
    if (session) return this.memory.rename(src, dest);
    await rename(await this.disk(src, true), await this.disk(dest, true));
  }
}
