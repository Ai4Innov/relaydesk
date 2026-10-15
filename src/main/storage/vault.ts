import Database from "better-sqlite3-multiple-ciphers";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { copyFile, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freemem } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Account, Collection, Message, Source } from "../../shared/contracts";
import { insidePath } from "../platform";
import { mailboxDate } from "../../shared/mail-date";

export interface IndexChunk {
  id: string; documentId: string; accountId: string; sourceId: string; messageId: string;
  attachmentId?: string; title: string; text: string; location: string;
}
export interface VectorChunk extends IndexChunk { vector?: Buffer; model?: string }
const BLOB_MAGIC = Buffer.from("RLYBLB01");
const BACKUP_MAGIC = Buffer.from("RLYBAK01");
export async function moveArchiveDirectory(from: string, to: string, move: typeof rename = rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await move(from, to); return; }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(String(code)) || attempt >= 5) throw error;
      // Windows scanners can briefly retain a handle after SQLite closes it.
      await delay(50 * (attempt + 1));
    }
  }
}
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw new Error("Unable to complete archive write.");
    offset += result.bytesWritten;
  }
}
function originEligible(record: string, ai: boolean): string {
  return `(json_extract(${record}.value,'$.gmailApi') IS NULL OR EXISTS (
    SELECT 1 FROM records origin_account JOIN records origin_source
      ON origin_source.collection='sources' AND origin_source.id=json_extract(${record}.value,'$.gmailApi.sourceId')
    WHERE origin_account.collection='accounts' AND origin_account.id=json_extract(${record}.value,'$.gmailApi.accountId')
      AND json_extract(origin_account.value,'$.provider')='gmail'
      AND COALESCE(json_extract(origin_account.value,'$.connection'),'')!='browser'
      AND json_extract(origin_account.value,'$.status')='connected'
      AND json_extract(origin_account.value,'$.consent')=1
      ${ai ? "AND json_extract(origin_account.value,'$.aiEnabled')=1" : ""}
      AND lower(trim(json_extract(origin_account.value,'$.email')))=lower(trim(json_extract(a.value,'$.email')))
      AND json_extract(origin_source.value,'$.accountId')=origin_account.id
      AND json_extract(origin_source.value,'$.kind')='mail' AND json_extract(origin_source.value,'$.selected')=1))`;
}
const eligible = (ai = false) => `
 JOIN records a ON a.collection='accounts' AND a.id=c.account_id
 JOIN records s ON s.collection='sources' AND s.id=c.source_id
 JOIN records m ON m.collection='messages' AND m.id=c.message_id
 LEFT JOIN records attachment ON attachment.collection='attachments' AND attachment.id=c.attachment_id
 WHERE json_extract(a.value,'$.status')='connected'
 AND json_extract(a.value,'$.consent')=1
 AND json_extract(s.value,'$.selected')=1 AND s.account_id=c.account_id
 AND m.account_id=c.account_id AND json_extract(m.value,'$.sourceId')=c.source_id
 AND COALESCE(json_extract(m.value,'$.deleted'),0)=0
 AND ${originEligible("m", ai)}
 AND ${originEligible("attachment", ai)}`;
const selectChunk = `c.id,c.document_id AS documentId,c.account_id AS accountId,c.source_id AS sourceId,
 c.message_id AS messageId,c.attachment_id AS attachmentId,c.title,c.text,c.location`;

export class Vault {
  private db!: Database.Database;
  private readonly key: Buffer;
  private readonly blobKey: Buffer;
  private readonly backupKey: Buffer;
  private readonly active: string;
  private busy = false;
  private writing = new Set<string>();
  private blobBytes = 0;
  private statements = new Map<string, Database.Statement>();

  constructor(private readonly directory: string, key: Buffer) {
    if (key.length !== 32) throw new Error("The encrypted vault requires a 32-byte protected key.");
    this.key = Buffer.from(key);
    this.blobKey = Buffer.from(hkdfSync("sha256", key, "", "relay-blob-v1", 32));
    this.backupKey = Buffer.from(hkdfSync("sha256", key, "", "relay-backup-v1", 32));
    this.active = join(directory, "archive");
    mkdirSync(directory, { recursive: true });
    if (!existsSync(this.active) && existsSync(this.active + ".rollback")) renameSync(this.active + ".rollback", this.active);
    mkdirSync(join(this.active, "blobs"), { recursive: true });
    this.db = this.connect(join(this.active, "vault.sqlite"));
    try { this.migrate(); this.repairMailboxDates(); } catch (error) { this.db.close(); this.key.fill(0); this.blobKey.fill(0); this.backupKey.fill(0); throw error; }
    rmSync(this.active + ".rollback", { recursive: true, force: true });
    for (const file of readdirSync(join(this.active, "blobs")))
      if (file.endsWith(".part")) rmSync(join(this.active, "blobs", file), { force: true });
    this.refreshBlobBytes();
  }

  private connect(file: string): Database.Database {
    const db = new Database(file);
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      db.pragma(`key='${this.key.toString("hex")}'`);
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      if (db.pragma("cipher", { simple: true }) !== "sqlcipher") throw new Error("SQLCipher encryption is unavailable.");
      db.pragma("journal_mode=WAL");
      db.pragma("foreign_keys=ON");
      db.pragma("secure_delete=ON");
      db.pragma("temp_store=MEMORY");
      db.pragma("busy_timeout=5000");
      return db;
    } catch (error) { db.close(); throw new Error("Cannot open encrypted archive with the protected key.", { cause: error }); }
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) throw new Error("This archive requires a newer application version.");
    if (version === 1) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,account_id TEXT,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(collection,id));
        CREATE INDEX records_account ON records(account_id,collection);
        CREATE INDEX records_messages_date ON records(json_extract(value,'$.receivedAt') DESC) WHERE collection='messages';
        CREATE TABLE chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,account_id TEXT NOT NULL,source_id TEXT NOT NULL,message_id TEXT NOT NULL,attachment_id TEXT,title TEXT NOT NULL,text TEXT NOT NULL,location TEXT NOT NULL);
        CREATE INDEX chunks_document ON chunks(document_id);
        CREATE INDEX chunks_account ON chunks(account_id,source_id);
        CREATE INDEX chunks_message ON chunks(message_id);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(title,text,content='chunks',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;
        CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); END;
        CREATE TRIGGER chunks_update AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text);
          INSERT INTO chunks_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text);
        END;
        CREATE TABLE embeddings(chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,model TEXT NOT NULL,bucket INTEGER NOT NULL,vector BLOB NOT NULL);
        CREATE INDEX embeddings_model_bucket ON embeddings(model,bucket);
        PRAGMA user_version=1;
      `);
    })();
  }

  private repairMailboxDates(): void {
    // Fill missing metadata only; keep content revisions and draft/thread-cache references intact.
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,value FROM records WHERE collection='messages'
        AND COALESCE(json_extract(value,'$.receivedAt'),'')=''
        AND json_extract(value,'$.browser.dateText') IS NOT NULL
        AND account_id LIKE 'browser:google:%'`).all() as { id: string; value: string }[];
      const update = this.db.prepare("UPDATE records SET value=? WHERE collection='messages' AND id=?");
      for (const row of rows) {
        const message = JSON.parse(row.value) as Message;
        const receivedAt = mailboxDate(message.browser!.dateText);
        if (receivedAt) update.run(JSON.stringify({ ...message, receivedAt }), row.id);
      }
    })();
  }

  private statement(sql: string): Database.Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.statements.set(sql, stmt); }
    return stmt;
  }
  private writable(): void {
    if (this.busy) throw new Error("Archive maintenance is in progress; retry this operation.");
    if (!this.db.open) throw new Error("The archive is closed.");
  }
  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.statement("SELECT value FROM records WHERE collection=? AND id=?").get(collection, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  put<T>(collection: Collection, id: string, value: T): void {
    this.writable();
    const object = value as { accountId?: string; change?: { accountId?: string } };
    const accountId = collection === "accounts" ? id : object?.accountId ?? object?.change?.accountId ?? null;
    this.statement("INSERT INTO records(collection,id,account_id,value) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET account_id=excluded.account_id,value=excluded.value")
      .run(collection, id, accountId, JSON.stringify(value));
  }
  all<T>(collection: Collection): T[] {
    return (this.statement("SELECT value FROM records WHERE collection=? ORDER BY rowid").all(collection) as { value: string }[]).map(row => JSON.parse(row.value) as T);
  }
  count(collection: Collection): number {
    return (this.statement("SELECT count(*) AS total FROM records WHERE collection=?").get(collection) as { total: number }).total;
  }
  listMessages(limit = 500): Message[] {
    return (this.statement(`SELECT value FROM records WHERE collection='messages'
      ORDER BY julianday(json_extract(value,'$.receivedAt')) DESC,account_id ASC,json_extract(value,'$.sourceId') ASC,
      COALESCE(json_extract(value,'$.browser.position'),9007199254740991) ASC,id ASC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, Math.floor(limit)))) as { value: string }[]).map(row => JSON.parse(row.value) as Message);
  }
  delete(collection: Collection, id: string): void {
    this.writable();
    this.transaction(() => {
      if (collection === "messages") {
        for (const row of this.statement("SELECT id FROM records WHERE collection='attachments' AND json_extract(value,'$.messageId')=?").all(id) as { id: string }[]) this.delete("attachments", row.id);
        this.statement("DELETE FROM chunks WHERE message_id=?").run(id);
      }
      if (collection === "attachments") { this.removeDocument(`attachment:${id}`); this.deleteBlob(id); }
      this.statement("DELETE FROM records WHERE collection=? AND id=?").run(collection, id);
    });
  }
  transaction<T>(fn: () => T): T {
    this.writable();
    return this.db.transaction(() => {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Vault transactions must be synchronous.");
      return result;
    })();
  }
  close(): void {
    if (this.busy || this.writing.size) throw new Error("Archive operations must finish before closing.");
    if (this.db.open) this.db.close();
    this.key.fill(0); this.blobKey.fill(0); this.backupKey.fill(0);
  }
  bytes(): number {
    return ["vault.sqlite", "vault.sqlite-wal", "vault.sqlite-shm"].reduce((total, name) => {
      try { return total + statSync(join(this.active, name)).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return total;
        throw error;
      }
    }, this.blobBytes);
  }
  private refreshBlobBytes(): void {
    this.blobBytes = readdirSync(join(this.active, "blobs")).filter(name => /^[a-f0-9]{64}\.blob$/.test(name))
      .reduce((total, name) => total + statSync(join(this.active, "blobs", name)).size, 0);
  }
  purgeAccount(accountId: string): void {
    this.writable();
    const ids = this.statement("SELECT id FROM records WHERE collection='attachments' AND account_id=?").all(accountId) as { id: string }[];
    for (const { id } of ids) this.deleteBlob(id);
    this.transaction(() => {
      for (const row of this.statement("SELECT collection,id FROM records WHERE account_id=? AND collection IN ('messages','jobs')").all(accountId) as { collection: string; id: string }[]) {
        if (row.collection === "jobs") this.statement("DELETE FROM records WHERE collection='checkpoints' AND id=?").run(`job:${row.id}`);
        else {
          const prefix = `ai:${row.id}:`;
          this.statement("DELETE FROM records WHERE collection='checkpoints' AND substr(id,1,?)=?").run(prefix.length, prefix);
        }
      }
      this.statement("DELETE FROM records WHERE collection='secrets' AND id=?").run(`provider:${accountId}`);
      this.statement("DELETE FROM chunks WHERE account_id=?").run(accountId);
      this.statement("DELETE FROM records WHERE account_id=?").run(accountId);
    });
  }

  permitted(accountId: string, sourceId: string): boolean {
    const account = this.get<Account>("accounts", accountId);
    const source = this.get<Source>("sources", sourceId);
    return !!(account?.status === "connected" && account.consent && source?.selected && source.accountId === accountId);
  }
  replaceDocument(documentId: string, chunks: IndexChunk[]): void {
    this.transaction(() => {
      this.removeDocument(documentId);
      this.appendDocumentChunks(documentId, chunks);
    });
  }
  appendDocumentChunks(documentId: string, chunks: IndexChunk[]): void {
    this.transaction(() => {
      const stmt = this.statement("INSERT INTO chunks(id,document_id,account_id,source_id,message_id,attachment_id,title,text,location) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const c of chunks) stmt.run(c.id, documentId, c.accountId, c.sourceId, c.messageId, c.attachmentId ?? null, c.title, c.text, c.location);
    });
  }
  removeDocument(documentId: string): void { this.writable(); this.statement("DELETE FROM chunks WHERE document_id=?").run(documentId); }
  forgetIndex(accountId: string): void { this.writable(); this.statement("DELETE FROM chunks WHERE account_id=?").run(accountId); }
  chunkCount(): number { return (this.statement("SELECT count(*) AS total FROM chunks").get() as { total: number }).total; }
  keywordCandidates(query: string, accountId?: string, limit = 200): IndexChunk[] {
    return this.statement(`SELECT ${selectChunk} FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid ${eligible()}
      AND chunks_fts MATCH ? ${accountId !== undefined ? "AND c.account_id=?" : ""} ORDER BY bm25(chunks_fts,3,1) LIMIT ?`)
      .all(...[query, ...(accountId !== undefined ? [accountId] : []), limit]) as IndexChunk[];
  }
  documentChunks(documentId: string, offset = 0, limit = 6): IndexChunk[] {
    return this.statement(`SELECT ${selectChunk} FROM chunks c ${eligible(true)}
      AND c.document_id=? AND json_extract(a.value,'$.aiEnabled')=1 ORDER BY c.rowid LIMIT ? OFFSET ?`)
      .all(documentId, Math.max(1, Math.min(6, Math.floor(limit))), Math.max(0, Math.floor(offset))) as IndexChunk[];
  }
  localDocumentChunks(documentId: string, offset = 0, limit = 6): IndexChunk[] {
    return this.statement(`SELECT ${selectChunk} FROM chunks c ${eligible()}
      AND c.document_id=? ORDER BY c.rowid LIMIT ? OFFSET ?`)
      .all(documentId, Math.max(1, Math.min(6, Math.floor(limit))), Math.max(0, Math.floor(offset))) as IndexChunk[];
  }
  semanticCandidates(model: string, buckets: number[], accountId?: string): VectorChunk[] {
    return this.statement(`SELECT ${selectChunk},e.vector,e.model FROM embeddings e JOIN chunks c ON c.id=e.chunk_id ${eligible()}
      AND e.model=? AND e.bucket IN (${buckets.map(() => "?").join(",")}) ${accountId !== undefined ? "AND c.account_id=?" : ""}
      ORDER BY c.rowid DESC LIMIT 2048`).all(model, ...buckets, ...(accountId !== undefined ? [accountId] : [])) as VectorChunk[];
  }
  vector(id: string, model: string): Buffer | undefined {
    return (this.statement(`SELECT e.vector FROM embeddings e JOIN chunks c ON c.id=e.chunk_id ${eligible()}
      AND e.chunk_id=? AND e.model=?`).get(id, model) as { vector: Buffer } | undefined)?.vector;
  }
  saveVector(id: string, model: string, bucket: number, vector: Buffer): void {
    this.writable();
    this.statement("INSERT INTO embeddings(chunk_id,model,bucket,vector) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM chunks WHERE id=?) ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model,bucket=excluded.bucket,vector=excluded.vector")
      .run(id, model, bucket, vector, id);
  }
  clearVectors(): void { this.writable(); this.statement("DELETE FROM embeddings").run(); }
  chunkPage(after: number, limit = 100): (IndexChunk & { rowNumber: number })[] {
    return this.statement(`SELECT ${selectChunk},c.rowid AS rowNumber FROM chunks c ${eligible()} AND c.rowid>? ORDER BY c.rowid LIMIT ?`).all(after, limit) as (IndexChunk & { rowNumber: number })[];
  }
  messagePage(after: number, limit = 100): { rowNumber: number; message: Message }[] {
    return (this.statement("SELECT rowid AS rowNumber,value FROM records WHERE collection='messages' AND rowid>? ORDER BY rowid LIMIT ?").all(after, limit) as { rowNumber: number; value: string }[])
      .map(row => ({ rowNumber: row.rowNumber, message: JSON.parse(row.value) as Message }));
  }

  private blobPath(id: string): string { return join(this.active, "blobs", createHash("sha256").update(id).digest("hex") + ".blob"); }
  private checkSpace(bytes: number, path = this.active): void {
    const disk = statfsSync(path);
    if (disk.bavail * disk.bsize < bytes + 64 * 1024 * 1024) throw new Error("Insufficient free disk space; keep at least 64 MB available.");
  }
  async writeBlob(id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<{ hash: string; size: number }> {
    this.writable();
    if (this.writing.has(id)) throw new Error("This attachment is already being written.");
    const reader = stream.getReader();
    this.writing.add(id);
    const path = this.blobPath(id), staging = `${path}.${randomUUID()}.part`;
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.blobKey, iv);
    cipher.setAAD(Buffer.concat([BLOB_MAGIC, createHash("sha256").update(id).digest()]));
    const hash = createHash("sha256");
    let size = 0;
    const aborted = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      const file = await open(staging, "wx", 0o600);
      try {
        await writeAll(file, Buffer.concat([BLOB_MAGIC, iv]));
        while (true) {
          signal?.throwIfAborted();
          const next = await reader.read();
          signal?.throwIfAborted();
          if (next.done) break;
          this.checkSpace(next.value.byteLength + 64);
          size += next.value.byteLength;
          if (!Number.isSafeInteger(size)) throw new Error("Attachment exceeds supported size.");
          hash.update(next.value);
          await writeAll(file, cipher.update(next.value));
        }
        await writeAll(file, Buffer.concat([cipher.final(), cipher.getAuthTag()]));
        await file.sync();
      } finally { await file.close(); }
      signal?.throwIfAborted();
      const previousSize = existsSync(path) ? statSync(path).size : 0;
      await rename(staging, path);
      this.blobBytes += size + BLOB_MAGIC.length + 12 + 16 - previousSize;
      return { hash: hash.digest("hex"), size };
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { signal?.removeEventListener("abort", aborted); reader.releaseLock(); this.writing.delete(id); await rm(staging, { force: true }); }
  }
  async readBlob(id: string, maxBytes = 512 * 1024 * 1024): Promise<Buffer> {
    const file = await open(this.blobPath(id), "r");
    let data: Buffer;
    try {
      const limit = Math.min(maxBytes + 36, 512 * 1024 * 1024, freemem() / 4);
      if ((await file.stat()).size > limit) throw new Error("Attachment is too large for the current in-memory extraction budget; original remains encrypted.");
      data = await file.readFile();
      if (data.length > limit) throw new Error("Attachment exceeds the current in-memory extraction budget.");
    } finally { await file.close(); }
    if (data.length < 36 || !data.subarray(0, 8).equals(BLOB_MAGIC)) throw new Error("Invalid encrypted attachment.");
    const decipher = createDecipheriv("aes-256-gcm", this.blobKey, data.subarray(8, 20));
    decipher.setAAD(Buffer.concat([BLOB_MAGIC, createHash("sha256").update(id).digest()])); decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(20, -16)), decipher.final()]);
  }
  deleteBlob(id: string): void {
    this.writable();
    if (this.writing.has(id)) throw new Error("Cancel the attachment download before deleting it.");
    const path = this.blobPath(id);
    const size = existsSync(path) ? statSync(path).size : 0;
    rmSync(path, { force: true });
    this.blobBytes -= size;
  }

  async backup(destination: string): Promise<void> {
    this.writable();
    if (this.writing.size) throw new Error("Wait for attachment downloads before backing up.");
    if (insidePath(this.active, destination)) throw new Error("Choose a backup destination outside the active archive.");
    this.busy = true;
    const snapshot = join(this.directory, `backup-${randomUUID()}.sqlite`);
    const staging = destination + "." + randomUUID() + ".part";
    try {
      // SQLite's generic backup API may open an unkeyed destination. Copy only
      // encrypted pages after checkpointing while all archive mutations are locked.
      const checkpoint = this.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
      if (checkpoint.some(row => row.busy)) throw new Error("Archive is busy; retry the backup.");
      await copyFile(join(this.active, "vault.sqlite"), snapshot);
      const files = [{ name: "vault.sqlite", path: snapshot }, ...readdirSync(join(this.active, "blobs")).filter(name => /^[a-f0-9]{64}\.blob$/.test(name)).map(name => ({ name, path: join(this.active, "blobs", name) }))];
      const manifest = Buffer.from(JSON.stringify(files.map(file => ({ name: file.name, size: statSync(file.path).size }))));
      if (manifest.length > 16 * 1024 * 1024) throw new Error("Archive exceeds this backup format's manifest resource budget.");
      const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.backupKey, iv);
      cipher.setAAD(BACKUP_MAGIC);
      const header = Buffer.concat([BACKUP_MAGIC, iv]);
      async function* payload() {
        yield length; yield manifest;
        for (const file of files) for await (const data of createReadStream(file.path)) yield data;
      }
      const handle = await open(staging, "wx", 0o600);
      try { await writeAll(handle, header); } finally { await handle.close(); }
      await pipeline(Readable.from(payload()), cipher, createWriteStream(staging, { flags: "a" }));
      const end = await open(staging, "a");
      try { await writeAll(end, cipher.getAuthTag()); await end.sync(); } finally { await end.close(); }
      await rename(staging, destination);
    } finally { this.busy = false; await rm(snapshot, { force: true }); await rm(staging, { force: true }); }
  }

  async restore(source: string): Promise<void> {
    this.writable();
    if (this.writing.size) throw new Error("Wait for attachment downloads before restoring.");
    this.busy = true;
    const stage = join(this.directory, `restore-${randomUUID()}`);
    const rollback = this.active + ".rollback";
    mkdirSync(join(stage, "blobs"), { recursive: true });
    try {
      const input = await open(source, "r");
      let header: Buffer, tag: Buffer, size: number;
      try {
        size = (await input.stat()).size;
        if (size < 40) throw new Error("Invalid backup.");
        header = Buffer.alloc(20); tag = Buffer.alloc(16);
        await input.read(header, 0, 20, 0); await input.read(tag, 0, 16, size - 16);
      } finally { await input.close(); }
      if (!header.subarray(0, 8).equals(BACKUP_MAGIC)) throw new Error("Unsupported backup format.");
      this.checkSpace(size, this.directory);
      const decipher = createDecipheriv("aes-256-gcm", this.backupKey, header.subarray(8));
      decipher.setAAD(BACKUP_MAGIC); decipher.setAuthTag(tag);
      const encrypted = createReadStream(source, { start: 20, end: size - 17 });
      encrypted.on("error", error => decipher.destroy(error));
      const decrypted = encrypted.pipe(decipher);
      const iterator = decrypted[Symbol.asyncIterator]();
      let pending: Buffer = Buffer.alloc(0);
      const take = async (count: number): Promise<Buffer> => {
        const pieces: Buffer[] = [];
        while (count > 0) {
          if (!pending.length) { const next = await iterator.next(); if (next.done) throw new Error("Truncated backup."); pending = Buffer.from(next.value); }
          const length = Math.min(count, pending.length);
          pieces.push(pending.subarray(0, length)); pending = pending.subarray(length); count -= length;
        }
        return Buffer.concat(pieces);
      };
      try {
        const length = (await take(4)).readUInt32BE();
        if (length > 16 * 1024 * 1024) throw new Error("Backup manifest exceeds safety limit.");
        const files = JSON.parse((await take(length)).toString()) as { name: string; size: number }[];
        if (!Array.isArray(files) || !files.length || files[0].name !== "vault.sqlite") throw new Error("Invalid backup manifest.");
        const names = new Set<string>();
        for (const file of files) {
          if (!(file.name === "vault.sqlite" || /^[a-f0-9]{64}\.blob$/.test(file.name)) || names.has(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > size) throw new Error("Unsafe backup entry.");
          names.add(file.name);
          const target = await open(file.name === "vault.sqlite" ? join(stage, file.name) : join(stage, "blobs", file.name), "wx", 0o600);
          try { let left = file.size; while (left) { const data = await take(Math.min(left, 64 * 1024)); await writeAll(target, data); left -= data.length; } await target.sync(); }
          finally { await target.close(); }
        }
        if (pending.length || !(await iterator.next()).done) throw new Error("Unexpected backup content.");
      } finally { encrypted.destroy(); decrypted.destroy(); }
      const verification = this.connect(join(stage, "vault.sqlite"));
      try {
        if (verification.pragma("integrity_check", { simple: true }) !== "ok" || verification.pragma("user_version", { simple: true }) !== 1) throw new Error("Backup database validation failed.");
        verification.pragma("wal_checkpoint(TRUNCATE)");
      } finally { verification.close(); }
      await rm(rollback, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.close(); this.statements.clear();
      let moved = false;
      try {
        await moveArchiveDirectory(this.active, rollback);
        moved = true;
        await moveArchiveDirectory(stage, this.active);
        this.db = this.connect(join(this.active, "vault.sqlite"));
        this.repairMailboxDates();
        this.refreshBlobBytes();
      } catch (error) {
        if (this.db.open) this.db.close();
        if (moved) {
          await rm(this.active, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          await moveArchiveDirectory(rollback, this.active);
        }
        this.db = this.connect(join(this.active, "vault.sqlite"));
        this.refreshBlobBytes();
        throw error;
      }
      await rm(rollback, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      this.busy = false;
      await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
