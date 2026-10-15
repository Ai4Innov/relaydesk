import { host, type PlatformProfile } from "../platform";
import type { SessionFsProvider, SessionFsFileInfo } from "@github/copilot-sdk";

/** Session transcripts stay in memory instead of unencrypted runtime files. */
export class MemorySessionFs implements SessionFsProvider {
  private entries = new Map<string, { text?: string; created: string; modified: string }>();
  constructor(private profile: PlatformProfile = host) {}
  private get path() { return this.profile.path; }
  private key(path: string): string {
    const key = this.path.resolve(this.profile.sessionRoot, path);
    return this.profile.caseInsensitive ? key.toLowerCase() : key;
  }
  private missing(): Error { return Object.assign(new Error("Session entry does not exist"), { code: "ENOENT" }); }
  async readFile(path: string): Promise<string> {
    const entry = this.entries.get(this.key(path));
    if (entry?.text === undefined) throw this.missing();
    return entry.text;
  }
  async writeFile(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error("Session artifact exceeds memory safety limit.");
    await this.mkdir(this.path.dirname(this.key(path)), true);
    const now = new Date().toISOString();
    this.entries.set(this.key(path), { text: content, created: this.entries.get(this.key(path))?.created ?? now, modified: now });
  }
  async appendFile(path: string, content: string): Promise<void> {
    await this.writeFile(path, (this.entries.get(this.key(path))?.text ?? "") + content);
  }
  async exists(path: string): Promise<boolean> { return this.entries.has(this.key(path)); }
  async stat(path: string): Promise<SessionFsFileInfo> {
    const entry = this.entries.get(this.key(path));
    if (!entry) throw this.missing();
    return { isFile: entry.text !== undefined, isDirectory: entry.text === undefined, size: Buffer.byteLength(entry.text ?? ""), mtime: entry.modified, birthtime: entry.created };
  }
  async mkdir(path: string, recursive: boolean): Promise<void> {
    const key = this.key(path);
    if (this.entries.has(key)) return;
    const parent = this.path.dirname(key);
    if (parent !== key && !this.entries.has(parent)) {
      if (!recursive) throw this.missing();
      await this.mkdir(parent, true);
    }
    const now = new Date().toISOString();
    this.entries.set(key, { created: now, modified: now });
  }
  async readdir(path: string): Promise<string[]> {
    if (!await this.exists(path)) throw this.missing();
    const key = this.key(path);
    return [...this.entries.keys()].filter(child => child !== key && this.path.dirname(child) === key).map(child => this.path.basename(child));
  }
  async readdirWithTypes(path: string): Promise<{ name: string; type: "file" | "directory" }[]> {
    return Promise.all((await this.readdir(path)).map(async name => ({ name, type: (await this.stat(this.path.join(path, name))).isFile ? "file" as const : "directory" as const })));
  }
  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    const key = this.key(path);
    if (!this.entries.has(key) && !force) throw this.missing();
    const children = [...this.entries.keys()].filter(child => child.startsWith(key + this.path.sep));
    if (children.length && !recursive) throw new Error("Session directory is not empty");
    for (const child of children) this.entries.delete(child);
    this.entries.delete(key);
  }
  async rename(src: string, dest: string): Promise<void> {
    const from = this.key(src), to = this.key(dest);
    if (!this.entries.has(from)) throw this.missing();
    for (const [key, value] of [...this.entries])
      if (key === from || key.startsWith(from + this.path.sep)) {
        this.entries.set(to + key.slice(from.length), value);
        this.entries.delete(key);
      }
  }
  clear(): void { this.entries.clear(); }
}
