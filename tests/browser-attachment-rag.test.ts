import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Vault } from "../src/main/storage/vault";
import { Retrieval } from "../src/main/retrieval";
import { BrowserArchive, browserAccountId } from "../src/main/browser/archive";
import { BrowserAttachmentDownloads } from "../src/main/browser/attachment-download";
import { BrowserMailReader } from "../src/main/browser/mail-reader";
import { BrowserBridge } from "../src/main/browser/bridge";
import { AttachmentProcessor } from "../src/main/attachments";
import type { Account, Attachment, Message, Source } from "../src/shared/contracts";
import type { BrowserCapture } from "../src/shared/browser";
import type { BrowserMailRequest } from "../src/shared/browser-mail";

describe("browser attachment encrypted archive and real local retrieval", () => {
  it("ingests an authenticated capture and leased download attestation into persistent encrypted search with AI off", async () => {
    const root = resolve("tests", `.attachment-rag-${randomUUID()}`), downloadsDirectory = join(root, "downloads");
    await mkdir(downloadsDirectory, { recursive: true });
    const secret = randomBytes(32), archiveDirectory = join(root, "vault");
    let vault = new Vault(archiveDirectory, secret);
    let browser: BrowserBridge | undefined, queue: BrowserAttachmentDownloads | undefined;
    try {
      const retrieval = new Retrieval(vault, join(root, "models"));
      await retrieval.configure(false, "");
      const metadata = { id: "native-tile", name: "decision.txt", mimeType: "text/plain" };
      const text = "Synthetic canary: zephyrquartz milestone accepted after committee deliberation.";
      const bytes = Buffer.from(text);
      const capture: BrowserCapture = { accountEmail: "synthetic@example.org", accountName: "Synthetic",
        kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox/nativeThread", meetings: [],
        messages: [{ id: "nativeMessage", threadId: "nativeThread", subject: "Synthetic fixture", sender: "sender@example.org",
          recipients: [], body: "See the attached decision.", html: "<p>See the attached decision.</p>",
          dateText: "", url: "https://mail.google.com/mail/u/0/#inbox/nativeThread", unread: false, completeness: "full",
          attachments: [{ ...metadata, size: bytes.length }], attachmentManifestVersion: 1 }] };
      const archive = new BrowserArchive(vault, message => retrieval.indexMessage(message), () => {}, () => false);
      const accountId = browserAccountId(capture.accountEmail);
      archive.discover(capture);
      const sourceId = `${accountId}:mail`;
      vault.put("accounts", accountId, { ...vault.get<Account>("accounts", accountId)!, consent: true, aiEnabled: false });
      vault.put("sources", sourceId, { ...vault.get<Source>("sources", sourceId)!, selected: true });
      const extensionId = "abcdefghijklmnopabcdefghijklmnop";
      browser = new BrowserBridge(vault, { extensionId, port: 0, changed: () => {},
        onDiscover: async input => archive.discover(input),
        onCapture: async input => { await archive.capture(input); }
      });
      const post = (path: string, body: unknown, token?: string) => fetch(`http://127.0.0.1:${browser!.status().port}${path}`, {
        method: "POST", headers: { Origin: `chrome-extension://${extensionId}`, "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
      });
      const pairing = await browser.pair();
      const { token } = await (await post("/pair", { code: pairing.code })).json() as { token: string };
      expect(vault.all<Attachment>("attachments")).toHaveLength(0);
      expect((await post("/capture", capture, token)).status).toBe(200);
      expect(vault.all<Attachment>("attachments")).toHaveLength(1);
      const attachment = vault.all<Attachment>("attachments")[0], message = vault.all<Message>("messages")[0];
      const apiDownload = vi.fn(async (): Promise<ReadableStream<Uint8Array>> => { throw new Error("No API download allowed"); });
      const processor = new AttachmentProcessor(vault, retrieval, apiDownload, {
        modelDirectory: join(root, "models"), thresholdMb: () => 25,
        workerPath: resolve("src", "main", "attachments", "attachment-worker.cjs")
      });
      const reader = new BrowserMailReader(vault, browser, input => archive.capture(input), () => false, () => false, () => 0);
      queue = new BrowserAttachmentDownloads(vault, browser, reader, processor, {
        downloadsDirectory, enabled: () => true, unavailable: () => false, revision: () => 0,
        thresholdMb: () => 25, changed: () => {}
      });
      queue.tick();
      const registration = { accountEmail: capture.accountEmail, accountName: capture.accountName,
        kind: "mail", pageUrl: "https://mail.google.com/mail/u/0/#inbox" };
      const source = { protocol: 1, registration, tabId: 10, documentId: "source-document" };
      let job: { requestId: string; lease: string; input: BrowserMailRequest; expiresAt: number } | undefined;
      await vi.waitFor(async () => {
        const response = await post("/mail/poll", source, token);
        expect(response.status).toBe(200);
        job = (await response.json()).job;
        expect(job).toBeTruthy();
      });
      expect(job!.input.attachment).toMatchObject({ metadataId: metadata.id, name: metadata.name, maxBytes: 25 * 1048576, approved: false });
      const binding = { protocol: 1, registration, tabId: 11, documentId: "owned-document", requestId: job!.requestId, lease: job!.lease };
      expect((await post("/mail/poll", { ...binding, sourceTabId: source.tabId, sourceDocumentId: source.documentId }, token)).status).toBe(200);
      expect((await post("/mail/poll", { ...binding, rowProof: {
        threadId: "nativeThread", inboxUrl: registration.pageUrl, targetUrl: capture.pageUrl
      } }, token)).status).toBe(200);
      const conversation = { ...binding, registration: { ...registration, pageUrl: capture.pageUrl } };
      expect((await post("/mail/attachment/authorize", conversation, token)).status).toBe(200);
      await writeFile(join(downloadsDirectory, ...job!.input.attachment!.relativePath.split("/")), bytes);
      expect((await post("/mail/attachment/status", conversation, token)).status).toBe(200);
      expect((await post("/mail/complete", { ...conversation, code: "complete", capture: {
        ...capture, attachmentDownload: { metadataId: metadata.id, name: metadata.name,
          relativePath: job!.input.attachment!.relativePath, bytes: bytes.length, downloadId: 42 }
      } }, token)).status).toBe(200);
      await queue.settled();
      expect(vault.get<Attachment>("attachments", attachment.id)?.status).toBe("indexed");
      expect(await vault.readBlob(attachment.id)).toEqual(bytes);
      const citations = await retrieval.search("zephyrquartz", accountId);
      expect(citations).toHaveLength(1);
      expect(citations[0]).toMatchObject({ attachmentId: attachment.id, messageId: message.id });
      expect(citations[0].excerpt).toContain("zephyrquartz");
      expect(apiDownload).not.toHaveBeenCalled();
      expect(vault.get<Account>("accounts", accountId)?.aiEnabled).toBe(false);
      expect(await readdir(join(downloadsDirectory, "RelayDesk"))).toEqual([]);
      for (const name of await readdir(join(archiveDirectory, "archive", "blobs")))
        expect((await readFile(join(archiveDirectory, "archive", "blobs", name))).includes(Buffer.from("zephyrquartz"))).toBe(false);
      await browser.stop();
      browser = undefined;
      vault.close();
      for (const name of await readdir(join(archiveDirectory, "archive")))
        if (name.startsWith("vault.sqlite"))
          expect((await readFile(join(archiveDirectory, "archive", name))).includes(Buffer.from("zephyrquartz"))).toBe(false);
      vault = new Vault(archiveDirectory, secret);
      const reopened = new Retrieval(vault, join(root, "models"));
      expect(await reopened.search("zephyrquartz", accountId)).toHaveLength(1);
      vault.put("sources", sourceId, { ...vault.get<Source>("sources", sourceId)!, selected: false });
      expect(await reopened.search("zephyrquartz", accountId)).toEqual([]);
    } finally {
      await browser?.stop();
      await queue?.settled();
      vault.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
