import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Account, Attachment, Message, Source } from "../src/shared/contracts";
import { Vault } from "../src/main/storage/vault";
import { Retrieval, keywordQuery } from "../src/main/retrieval";
import { BrowserArchive } from "../src/main/browser/archive";
import type { BrowserCapture } from "../src/shared/browser";

const resources: { root: string; vault: Vault }[] = [];
function setup() {
  const root = resolve(".test-data", randomUUID()); mkdirSync(root, { recursive: true });
  const vault = new Vault(root, randomBytes(32)), retrieval = new Retrieval(vault, join(root, "models"));
  resources.push({ root, vault });
  for (const id of ["a", "ab"]) {
    vault.put<Account>("accounts", id, { id, provider: "gmail", name: id, email: `${id}@example.test`, status: "connected", consent: true, aiEnabled: true });
    vault.put<Source>("sources", `${id}:inbox`, { id: `${id}:inbox`, accountId: id, providerId: "inbox", name: "Inbox", kind: "mail", selected: true });
  }
  return { vault, retrieval };
}
const message = (id: string, accountId = "a", body = "The zephyr project deadline is Friday"): Message => ({
  id, accountId, sourceId: `${accountId}:inbox`, providerId: id, threadId: id, subject: "Project planning",
  sender: "person@example.test", recipients: [], body, receivedAt: "2026-01-01", url: "", unread: false, revision: "1", historical: true
});
afterEach(() => { for (const { root, vault } of resources.splice(0)) { vault.close(); rmSync(root, { recursive: true, force: true }); } });

describe("local retrieval", () => {
  it("indexes actual downloaded browser bodies with AI off, preserves preview references and never indexes HTML", async () => {
    const { vault, retrieval } = setup();
    const archive = new BrowserArchive(vault, value => retrieval.indexMessage(value), () => {}, () => false);
    const capture: BrowserCapture = { accountEmail: "synthetic@example.test", accountName: "Synthetic",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox", kind: "mail", meetings: [],
      messages: [{ id: "thread:legacy", threadId: "legacy", subject: "Zephyr", sender: "sender@example.test",
        recipients: [], body: "zephyr snippet", dateText: "", url: "https://mail.google.com/mail/u/0/#inbox/legacy",
        unread: true, completeness: "preview" }] };
    const { accountId } = archive.discover(capture);
    const source = vault.get<Source>("sources", `${accountId}:mail`)!;
    vault.put("sources", source.id, { ...source, selected: true });
    const [preview] = await archive.capture(capture);
    expect(vault.get<Account>("accounts", accountId)?.aiEnabled).toBe(false);
    expect((await retrieval.search("zephyr", accountId))[0]).toMatchObject({
      messageId: preview.id, location: expect.stringContaining("Browser Inbox preview (incomplete)")
    });
    vault.put("drafts", "bound-draft", { id: "bound-draft", messageId: preview.id, sourceRevision: preview.revision, status: "local" });
    const fullCapture: BrowserCapture = { ...capture, messages: [{ ...capture.messages[0], id: "actual-message",
      completeness: "full", body: "zephyr complete evidence with distantbodyphrase",
      html: "<div>htmlonlysecret</div>" }] };
    const [full] = await archive.capture(fullCapture);
    expect((await retrieval.search("distantbodyphrase", accountId))[0]).toMatchObject({
      messageId: full.id, location: `Full message body · captured ${full.browser!.capturedAt}`
    });
    expect(await retrieval.search("htmlonlysecret", accountId)).toEqual([]);
    expect((await retrieval.search("zephyr", accountId)).map(hit => hit.messageId)).toEqual([full.id]);
    expect(vault.localDocumentChunks(`message:${preview.id}`)).toEqual([]);
    expect(vault.get<Message>("messages", preview.id)?.revision).toBe(preview.revision);
    expect(vault.get("drafts", "bound-draft")).toMatchObject({ sourceRevision: preview.revision, status: "local" });
    await archive.capture({ ...capture, messages: [{ ...capture.messages[0], body: "newer Inbox snippet" }] });
    await retrieval.reindex();
    expect(vault.localDocumentChunks(`message:${preview.id}`)).toEqual([]);
    expect((await retrieval.search("distantbodyphrase", accountId))[0]?.messageId).toBe(full.id);
    vault.put("sources", source.id, { ...source, selected: false });
    expect(await retrieval.search("distantbodyphrase", accountId)).toEqual([]);
  });
  it("keeps preview evidence until a same-account/source/thread full document indexes successfully", async () => {
    const { vault, retrieval } = setup();
    const preview: Message = { ...message("preview"), providerId: "thread:legacy", threadId: "a:thread:legacy",
      browser: { completeness: "preview", capturedAt: "", dateText: "" } };
    vault.put("messages", preview.id, preview);
    await retrieval.indexMessage(preview);
    for (const [id, accountId, sourceId, threadId] of [
      ["foreign-account", "ab", "ab:inbox", preview.threadId],
      ["foreign-source", "a", "a:other", preview.threadId],
      ["foreign-thread", "a", "a:inbox", "a:thread:other"]
    ]) {
      vault.put("sources", sourceId, { id: sourceId, accountId, providerId: "inbox", selected: true, kind: "mail", name: "Inbox" });
      const full: Message = { ...message(id, accountId), sourceId, threadId,
        browser: { completeness: "full", capturedAt: "", dateText: "" } };
      vault.put("messages", id, full); await retrieval.indexMessage(full);
    }
    expect((await retrieval.search("zephyr", "a")).some(hit => hit.messageId === preview.id)).toBe(true);
    const full: Message = { ...preview, id: "actual", providerId: "actual",
      browser: { ...preview.browser!, completeness: "full" } };
    vault.put("messages", full.id, full);
    const failure = vi.spyOn(vault, "appendDocumentChunks").mockImplementationOnce(() => { throw new Error("Synthetic index failure"); });
    await expect(retrieval.indexMessage(full)).rejects.toThrow("Synthetic index failure");
    expect((await retrieval.search("zephyr", "a")).some(hit => hit.messageId === preview.id)).toBe(true);
    failure.mockRestore();
    await retrieval.indexMessage(full);
    expect((await retrieval.search("zephyr", "a")).some(hit => hit.messageId === preview.id)).toBe(false);
    await retrieval.indexMessage(preview);
    expect(vault.localDocumentChunks(`message:${preview.id}`)).toEqual([]);
  });
  it("quotes untrusted FTS input and enforces exact account and live source permission filters", async () => {
    const { vault, retrieval } = setup();
    for (const value of [message("1"), message("2", "ab")]) { vault.put("messages", value.id, value); await retrieval.indexMessage(value); }
    expect((await retrieval.search("zephyr", "a")).map(item => item.messageId)).toEqual(["1"]);
    expect(await retrieval.search("zephyr", "")).toEqual([]);
    expect(await retrieval.search('") OR zephyr NEAR(*):--')).toHaveLength(2);
    expect(keywordQuery('":*()"')).toBe("");
    const source = vault.get<Source>("sources", "a:inbox")!;
    vault.put("sources", source.id, { ...source, selected: false });
    expect(await retrieval.search("zephyr", "a")).toEqual([]);
    const account = vault.get<Account>("accounts", "ab")!;
    vault.put("accounts", account.id, { ...account, consent: false });
    expect(await retrieval.search("zephyr")).toEqual([]);
  });
  it("indexes past the 64th chunk in bounded batches and preserves attachment provenance", async () => {
    const { vault, retrieval } = setup();
    const value = message("1"); vault.put("messages", value.id, value); await retrieval.indexMessage(value);
    const attachment: Attachment = { id: "doc", accountId: "a", messageId: value.id, providerId: "doc", name: "Report.pdf", mimeType: "application/pdf", status: "indexed" };
    vault.put("attachments", attachment.id, attachment);
    await retrieval.indexAttachment(attachment, [{ text: "The sapphire results are excellent", location: "Page 7" }]);
    const result = await retrieval.search("sapphire");
    expect(result[0]).toMatchObject({ attachmentId: "doc", messageId: "1", location: "Page 7", title: "Report.pdf" });
    const batches = vi.spyOn(vault, "appendDocumentChunks");
    await retrieval.indexMessage({ ...value, body: "longword ".repeat(20000) + " distantmessageevidence" });
    expect(retrieval.stats().indexed).toBeGreaterThan(64);
    expect((await retrieval.search("distantmessageevidence"))[0]?.messageId).toBe("1");
    expect(batches.mock.calls.length).toBeGreaterThan(1);
    expect(batches.mock.calls.every(([, chunks]) => chunks.length <= 64)).toBe(true);
    await retrieval.indexAttachment(attachment, Array.from({ length: 90 }, (_, page) => ({
      text: page === 89 ? "sapphire distantattachmentevidence" : `Earlier report content page ${page + 1}`,
      location: `Page ${page + 1}`
    })));
    expect((await retrieval.search("distantattachmentevidence"))[0]).toMatchObject({ attachmentId: "doc", location: "Page 90" });
    await retrieval.reindex();
    expect((await retrieval.search("sapphire"))[0]?.attachmentId).toBe("doc");
    vault.delete("messages", "1");
    expect(await retrieval.search("sapphire")).toEqual([]);
    expect(retrieval.stats().indexed).toBe(0);
  });
  it("rejects failed batches and removes partial indexing rather than silently succeeding", async () => {
    const { vault, retrieval } = setup();
    const value = message("failure", "a", "largeword ".repeat(20000));
    vault.put("messages", value.id, value);
    const append = vault.appendDocumentChunks.bind(vault);
    vi.spyOn(vault, "appendDocumentChunks").mockImplementationOnce(append).mockImplementationOnce(() => { throw new Error("Disk resource limit"); });
    await expect(retrieval.indexMessage(value)).rejects.toThrow("Disk resource limit");
    expect(retrieval.stats().indexed).toBe(0);
    expect(await retrieval.search("largeword")).toEqual([]);
  });
  it("works without downloading a model, persists vectors only in encrypted storage and forgets accounts", async () => {
    const { vault, retrieval } = setup();
    const account = vault.get<Account>("accounts", "a")!;
    vault.put("accounts", "a", { ...account, aiEnabled: false });
    await retrieval.configure(false, "not/a-model");
    const value = message("1"); vault.put("messages", value.id, value); await retrieval.indexMessage(value);
    expect((await retrieval.search("zephyr", "a"))[0]?.messageId).toBe("1");
    const chunk = vault.chunkPage(0)[0];
    vault.saveVector(chunk.id, "fixture-v1", 42, Buffer.from(new Float32Array([1, 0]).buffer));
    expect(vault.vector(chunk.id, "fixture-v1")?.length).toBe(8);
    expect(retrieval.stats().mode).toBe("keyword");
    retrieval.forgetAccount("a");
    expect(await retrieval.search("zephyr")).toEqual([]);
    expect(vault.vector(chunk.id, "fixture-v1")).toBeUndefined();
  });
  it.runIf(process.env.RELAY_BENCHMARK === "1")("100k encrypted synthetic archive warm search p95 below two seconds", async () => {
    const { vault, retrieval } = setup();
    const started = performance.now();
    vault.transaction(() => {
      for (let i = 0; i < 100000; i++) {
        const value = message(`m${i}`, "a", `Budget discussion department${i % 200} project${i % 500} planning`);
        vault.put("messages", value.id, value);
        vault.replaceDocument(`message:${value.id}`, [{ id: `c${i}`, documentId: `message:${value.id}`, accountId: "a", sourceId: "a:inbox", messageId: value.id, title: value.subject, text: value.body, location: "Message body" }]);
      }
    });
    const times: number[] = [];
    await retrieval.search("project123", "a");
    for (let i = 0; i < 30; i++) { const start = performance.now(); expect((await retrieval.search(`project${i}`, "a")).length).toBeGreaterThan(0); times.push(performance.now() - start); }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ corpus: 100000, indexingMs: performance.now() - started, warmP95Ms: times[Math.floor(times.length * .95)], mode: retrieval.stats().mode }));
    expect(times[Math.floor(times.length * .95)]).toBeLessThan(2000);
  }, 180000);
});
