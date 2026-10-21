import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Vault, moveArchiveDirectory } from "../src/main/storage/vault";

const roots: string[] = [];
const vaults: Vault[] = [];
function setup() {
  const root = resolve(".test-data", randomUUID());
  mkdirSync(root, { recursive: true }); roots.push(root);
  const key = randomBytes(32), vault = new Vault(root, key);
  vaults.push(vault);
  return { root, key, vault };
}
afterEach(() => {
  for (const vault of vaults.splice(0)) vault.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } });

describe("encrypted vault", () => {
  it("serves cached reads that stay consistent with writes, deletes, rollbacks and purges", () => {
    const { vault } = setup();
    vault.put("tasks", "a", { id: "a", accountId: "one", n: 1 });
    vault.put("tasks", "b", { id: "b", accountId: "two", n: 1 });
    expect(vault.all<{ id: string }>("tasks").map(task => task.id)).toEqual(["a", "b"]);
    const before = vault.generation;
    vault.put("tasks", "a", { id: "a", accountId: "one", n: 2 });
    vault.put("tasks", "c", { id: "c", accountId: "one", n: 1 });
    expect(vault.generation).toBeGreaterThan(before);
    expect(vault.all<{ id: string; n: number }>("tasks")).toEqual([
      { id: "a", accountId: "one", n: 2 }, { id: "b", accountId: "two", n: 1 }, { id: "c", accountId: "one", n: 1 }]);
    const copy = vault.get<{ n: number }>("tasks", "a")!; copy.n = 99;
    expect(vault.get<{ n: number }>("tasks", "a")!.n).toBe(2);
    expect(() => vault.transaction(() => { vault.put("tasks", "b", { id: "b", n: 5 }); throw new Error("rollback"); })).toThrow("rollback");
    expect(vault.get<{ n: number }>("tasks", "b")!.n).toBe(1);
    vault.delete("tasks", "c");
    expect(vault.get("tasks", "c")).toBeUndefined();
    expect(vault.count("tasks")).toBe(2);
    vault.purgeAccount("one");
    expect(vault.all<{ id: string }>("tasks").map(task => task.id)).toEqual(["b"]);
  });
  it("selects the latest mailbox dates before undated captures, irrespective of capture time", () => {
    const { vault } = setup();
    vault.put("messages", "old", { id: "old", receivedAt: "2026-09-21T10:00:00Z" });
    vault.put("messages", "second", { id: "second", receivedAt: "", browser: { capturedAt: "2026-09-22T10:00:00Z", position: 1 } });
    vault.put("messages", "new", { id: "new", receivedAt: "", browser: { capturedAt: "2026-09-22T10:00:00Z", position: 0 } });
    expect(vault.listMessages(2).map(message => message.id)).toEqual(["old", "new"]);
    vault.put("messages", "offset", { id: "offset", receivedAt: "2026-09-21T11:00:00+02:00" });
    expect(vault.listMessages(2).map(message => message.id)).toEqual(["old", "offset"]);
  });
  it("repairs archived Gmail dates on reopen without changing draft or thread-cache revisions", () => {
    const { vault, root, key } = setup();
    const message = { id: "mail", accountId: "browser:google:reader@example.org", receivedAt: "", revision: "unchanged",
      browser: { completeness: "full", dateText: "Wed, Sep 23, 2026, 5:10\u202fPM", capturedAt: "2026-10-01T00:00:00Z" } };
    vault.put("messages", "mail", message);
    vault.put("drafts", "draft", { messageId: "mail", messageRevision: "unchanged", body: "My edited reply" });
    vault.put("checkpoints", "browser-mail:thread", { revisions: { mail: "unchanged" } });
    vault.close();
    const reopened = new Vault(root, key); vaults.push(reopened);
    expect(reopened.get("messages", "mail")).toEqual({ ...message, receivedAt: new Date(2026, 8, 23, 17, 10).toISOString() });
    expect(reopened.get("drafts", "draft")).toEqual({ messageId: "mail", messageRevision: "unchanged", body: "My edited reply" });
    expect(reopened.get("checkpoints", "browser-mail:thread")).toEqual({ revisions: { mail: "unchanged" } });
  });
  it.skipIf(process.platform !== "win32")("retries transient Windows rename locks without hiding permanent failures", async () => {
    const transient = Object.assign(new Error("locked"), { code: "EPERM" });
    const move = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue(undefined);
    await moveArchiveDirectory("archive", "rollback", move);
    expect(move).toHaveBeenCalledTimes(2);
    const invalid = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(moveArchiveDirectory("archive", "rollback", invalid)).rejects.toThrow("missing");
    expect(invalid).toHaveBeenCalledTimes(1);
  });
  it("persists records, rolls back transactions, and fails with the wrong key", () => {
    const { vault, root, key } = setup();
    vault.put("messages", "one", { id: "one", accountId: "a", body: "ultrasecret-canary" });
    expect(() => vault.transaction(() => { vault.put("messages", "two", {}); throw new Error("rollback"); })).toThrow("rollback");
    expect(vault.get("messages", "two")).toBeUndefined();
    expect(vault.all("messages")).toHaveLength(1);
    expect(vault.bytes()).toBeGreaterThan(0);
    for (const name of readdirSync(join(root, "archive")).filter(name => name.startsWith("vault.sqlite"))) {
      const data = readFileSync(join(root, "archive", name));
      expect(data.includes(Buffer.from("ultrasecret-canary"))).toBe(false);
      expect(data.subarray(0, 16).toString()).not.toBe("SQLite format 3\u0000");
    }
    vault.close();
    expect(() => new Vault(root, randomBytes(32))).toThrow("protected key");
    const reopened = new Vault(root, key); vaults.push(reopened);
    expect(reopened.get<{ body: string }>("messages", "one")?.body).toBe("ultrasecret-canary");
    reopened.delete("messages", "one");
    expect(reopened.all("messages")).toEqual([]);
  });
  it("encrypts blobs, prevents traversal, detects tampering and cleans cancellation", async () => {
    const { vault, root } = setup();
    const result = await vault.writeBlob("..\\..\\outside", stream("secret binary"));
    expect(result.size).toBe(13); expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await vault.readBlob("..\\..\\outside")).toString()).toBe("secret binary");
    await expect(vault.readBlob("..\\..\\outside", 12)).rejects.toThrow("budget");
    const file = join(root, "archive", "blobs", readdirSync(join(root, "archive", "blobs"))[0]);
    const data = readFileSync(file); expect(data.includes(Buffer.from("secret binary"))).toBe(false);
    data[data.length - 1] ^= 1; writeFileSync(file, data);
    await expect(vault.readBlob("..\\..\\outside")).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(vault.writeBlob("cancelled", stream("data"), abort.signal)).rejects.toThrow();
    expect(readdirSync(join(root, "archive", "blobs")).some(name => name.endsWith(".part"))).toBe(false);
  });
  it("permits local document text without AI while retaining account and source permissions", () => {
    const { vault } = setup();
    vault.put("accounts", "a", { id: "a", status: "connected", consent: true, aiEnabled: false });
    vault.put("sources", "s", { id: "s", accountId: "a", selected: true });
    vault.put("messages", "m", { id: "m", accountId: "a", sourceId: "s" });
    vault.replaceDocument("attachment:file", [{ id: "chunk", documentId: "attachment:file", accountId: "a",
      sourceId: "s", messageId: "m", attachmentId: "file", title: "Office file", text: "Local text", location: "Sheet 1" }]);
    expect(vault.documentChunks("attachment:file")).toEqual([]);
    expect(vault.localDocumentChunks("attachment:file").map(chunk => chunk.text)).toEqual(["Local text"]);
    vault.put("sources", "s", { id: "s", accountId: "a", selected: false });
    expect(vault.localDocumentChunks("attachment:file")).toEqual([]);
  });
  it("restores authenticated backups with attachments and leaves live data intact on corruption", async () => {
    const { vault, root } = setup();
    vault.put("messages", "one", { accountId: "a", body: "backup-canary" });
    await vault.writeBlob("attachment", stream("original attachment"));
    const backup = join(root, "archive.relay");
    await vault.backup(backup);
    expect(readFileSync(backup).includes(Buffer.from("backup-canary"))).toBe(false);
    vault.delete("messages", "one"); vault.deleteBlob("attachment");
    await vault.restore(backup);
    expect(vault.get("messages", "one")).toEqual({ accountId: "a", body: "backup-canary" });
    expect((await vault.readBlob("attachment")).toString()).toBe("original attachment");
    const damaged = readFileSync(backup); damaged[damaged.length - 1] ^= 1; writeFileSync(backup, damaged);
    await expect(vault.restore(backup)).rejects.toThrow();
    expect(vault.get("messages", "one")).toBeDefined();
  });
  it("purges nested account records and attachment originals", async () => {
    const { vault } = setup();
    vault.put("accounts", "a", { id: "a" });
    vault.put("attachments", "blob", { id: "blob", accountId: "a" });
    vault.put("approvals", "approval", { change: { accountId: "a" } });
    vault.put("messages", "other", { accountId: "b" });
    await vault.writeBlob("blob", stream("private"));
    vault.purgeAccount("a");
    expect(vault.all("accounts")).toEqual([]);
    expect(vault.all("approvals")).toEqual([]);
    expect(vault.all("messages")).toHaveLength(1);
    await expect(vault.readBlob("blob")).rejects.toThrow();
  });
  it("tracks committed blob bytes incrementally across replacements and deletion", async () => {
    const { vault } = setup();
    const initial = vault.bytes();
    await vault.writeBlob("one", stream("abc"));
    expect(vault.bytes() - initial).toBe(3 + 36);
    await vault.writeBlob("one", stream("abcdef"));
    expect(vault.bytes() - initial).toBe(6 + 36);
    vault.deleteBlob("one");
    expect(vault.bytes()).toBe(initial);
  });
});
