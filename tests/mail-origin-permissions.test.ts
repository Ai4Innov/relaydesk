import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "@github/copilot-sdk";
import type { Account, ActionItem, Attachment, Citation, Message, Snapshot, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import { Vault } from "../src/main/storage/vault";
import { Retrieval } from "../src/main/retrieval";
import { ChatService } from "../src/main/chat";
import type { ChatAgentRequest } from "../src/main/copilot";
import { ProductivityService } from "../src/main/productivity";
import { attachmentViewGuard, viewAttachment } from "../src/main/attachments/viewing";
import { browserAttachmentGuard } from "../src/main/attachments/browser-import";
import { browserAttachmentId } from "../src/main/browser/archive";

const resources: { root: string; vault: Vault }[] = [];
afterEach(() => {
  for (const { root, vault } of resources.splice(0)) {
    vault.close(); rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = resolve(".test-data", `origin-${randomUUID()}`);
  const vault = new Vault(root, randomBytes(32));
  resources.push({ root, vault });
  const account: Account = { id: "browser", provider: "gmail", connection: "browser", name: "Browser",
    email: "same@example.test", status: "connected", consent: true, aiEnabled: true };
  const api: Account = { ...account, id: "api", connection: undefined, name: "API" };
  const source: Source = { id: "browser:mail", accountId: account.id, providerId: "mail", name: "Mail", kind: "mail", selected: true };
  const apiSource: Source = { ...source, id: "api:mail", accountId: api.id };
  const gmailApi = { accountId: api.id, sourceId: apiSource.id };
  const message: Message = { id: "message", accountId: account.id, sourceId: source.id, providerId: "provider-message",
    threadId: "thread", subject: "Zephyr confidential", sender: "sender@example.test", recipients: [], body: "Please review the zephyr contract.",
    receivedAt: "2026-09-01T00:00:00Z", url: "", unread: true, revision: "1", historical: false, gmailApi };
  const attachment: Attachment = { id: "file", accountId: account.id, messageId: message.id, providerId: "provider-file",
    name: "secret.txt", mimeType: "text/plain", status: "indexed", gmailApi };
  for (const value of [account, api]) vault.put("accounts", value.id, value);
  for (const value of [source, apiSource]) vault.put("sources", value.id, value);
  vault.put("messages", message.id, message); vault.put("attachments", attachment.id, attachment);
  const retrieval = new Retrieval(vault, resolve(root, "models"));
  const citation: Citation = { id: "cite", messageId: message.id, title: message.subject, excerpt: message.body };
  const action: ActionItem = { id: "action", accountId: account.id, messageId: message.id, title: "Review zephyr",
    reason: "Requested review", status: "open", priority: "important", confidence: 1, citations: [citation] };
  vault.put("actions", action.id, action);
  const workspace = (): Snapshot => ({ accounts: vault.all("accounts"), sources: vault.all("sources"), messages: vault.all("messages"),
    actions: [action], attachments: [attachment], tasks: [], events: [], browserItems: [], settings: { ...defaultSettings, model: "test" },
    aiReview: { status: "idle" } } as unknown as Snapshot);
  const hooks = { changed: vi.fn(), settings: () => workspace().settings, workspace,
    search: vi.fn(async () => [citation]),
    generate: vi.fn(async (_request: ChatAgentRequest) => ({ answer: "Allowed evidence", citationIds: [] as string[] })),
    execute: vi.fn(async () => ({ message: "Done" })) };
  const chat = new ChatService(vault, hooks);
  const send = async () => { await chat.command({ type: "chat.send", text: "Read the evidence" }); await chat.settled(); };
  return { vault, retrieval, message, attachment, account, api, source, apiSource, gmailApi, citation, action, workspace, hooks, chat, send };
}
async function call(tools: Tool[], name: string, args: unknown) {
  const tool = tools.find(item => item.name === name)!;
  return tool.handler!(args, { sessionId: "test", toolCallId: "test", toolName: name, arguments: args }) as Promise<any>;
}

describe("API-origin browser alias permissions", () => {
  it.each(["message", "attachment"] as const)("guards browser import against revoked %s provenance without requiring AI", target => {
    const f = fixture();
    f.vault.put("accounts", f.account.id, { ...f.account, aiEnabled: false });
    f.vault.put("accounts", f.api.id, { ...f.api, aiEnabled: false });
    f.vault.put("messages", f.message.id, { ...f.message, gmailApi: target === "message" ? f.gmailApi : undefined,
      browser: { completeness: "full", capturedAt: "", dateText: "" } });
    const id = browserAttachmentId(f.account.id, f.message.id,
      { id: f.attachment.providerId, name: f.attachment.name, mimeType: f.attachment.mimeType });
    f.vault.put("attachments", id, { ...f.attachment, id, gmailApi: target === "attachment" ? f.gmailApi : undefined,
      browser: { source: "browser_gmail", metadataId: f.attachment.providerId } });
    const validate = browserAttachmentGuard(f.vault, id, () => false);
    expect(validate().id).toBe(id);
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(validate).toThrow("permitted account");
  });

  it.each(["message", "attachment"] as const)("rejects %s origin changes during an already-selected import", target => {
    const f = fixture();
    f.vault.put("messages", f.message.id, { ...f.message, browser: { completeness: "full", capturedAt: "", dateText: "" } });
    const id = browserAttachmentId(f.account.id, f.message.id,
      { id: f.attachment.providerId, name: f.attachment.name, mimeType: f.attachment.mimeType });
    f.vault.put("attachments", id, { ...f.attachment, id, browser: { source: "browser_gmail", metadataId: f.attachment.providerId } });
    const validate = browserAttachmentGuard(f.vault, id, () => false);
    validate();
    if (target === "message") f.vault.put("messages", f.message.id, { ...f.vault.get<Message>("messages", f.message.id)!, gmailApi: undefined });
    else f.vault.put("attachments", id, { ...f.vault.get<Attachment>("attachments", id)!, gmailApi: undefined });
    expect(validate).toThrow("metadata changed");
  });

  it.each(["consent", "status", "selected", "email", "missing"] as const)("blocks retained search and chunks after API %s revocation", async field => {
    const f = fixture();
    await f.retrieval.indexMessage(f.message);
    await f.retrieval.indexAttachment(f.attachment, [{ text: "zephyr attachment", location: "Page 1" }]);
    const chunk = f.vault.localDocumentChunks("message:message")[0];
    f.vault.saveVector(chunk.id, "test", 1, Buffer.alloc(8));
    expect(await f.retrieval.search("zephyr")).toHaveLength(2);
    if (field === "selected") f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    else if (field === "missing") f.vault.delete("accounts", f.api.id);
    else f.vault.put("accounts", f.api.id, { ...f.api, [field]: field === "consent" ? false : field === "status" ? "disconnected" : "other@example.test" });
    expect(await f.retrieval.search("zephyr")).toEqual([]);
    expect(f.vault.keywordCandidates('"zephyr"')).toEqual([]);
    expect(f.vault.semanticCandidates("test", [1])).toEqual([]);
    expect(f.vault.vector(chunk.id, "test")).toBeUndefined();
    expect(f.vault.localDocumentChunks("message:message")).toEqual([]);
    expect(f.vault.documentChunks("message:message")).toEqual([]);
    expect(f.vault.chunkPage(0)).toEqual([]);
    expect(f.vault.localDocumentChunks("attachment:file")).toEqual([]);
    await f.retrieval.indexMessage(f.message);
    expect(f.vault.chunkCount()).toBe(1);
  });

  it.each(["api", "browser"])("separates local permission from %s AI consent", async id => {
    const f = fixture();
    await f.retrieval.indexMessage(f.message);
    await f.retrieval.indexAttachment(f.attachment, [{ text: "zephyr attachment", location: "Page 1" }]);
    f.vault.put("accounts", id, { ...f.vault.get<Account>("accounts", id)!, aiEnabled: false });
    expect(f.vault.localDocumentChunks("message:message")).toHaveLength(1);
    expect(await f.retrieval.search("zephyr")).toHaveLength(2);
    expect(f.vault.documentChunks("message:message")).toEqual([]);
    expect(f.vault.documentChunks("attachment:file")).toEqual([]);
    expect(f.vault.localDocumentChunks("attachment:file")).toHaveLength(1);
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "search_archive", { query: "zephyr", accountId: "browser" });
      expect(result.excerpts).toEqual([]);
      return { answer: "No permitted evidence", citationIds: [] };
    });
    await f.send();
    expect(f.chat.snapshot().conversations[0].turns.at(-1)?.citations).toEqual([]);
  });

  it("rechecks search candidates and indexing after asynchronous inference", async () => {
    const f = fixture();
    await f.retrieval.indexMessage(f.message);
    const extractor = vi.fn(async () => {
      f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
      return { data: [1, 0] };
    });
    Object.assign(f.retrieval, { extractor, model: "test" });
    expect(await f.retrieval.search("zephyr")).toEqual([]);
    f.vault.put("sources", f.apiSource.id, f.apiSource);
    await expect(f.retrieval.indexMessage(f.message)).rejects.toThrow("eligibility changed");
    expect(f.vault.chunkCount()).toBe(0);
  });

  it("keeps attachment provenance after the parent becomes a genuine browser capture", async () => {
    const f = fixture();
    await f.retrieval.indexAttachment(f.attachment, [{ text: "zephyr attachment", location: "Page 1" }]);
    f.vault.put("messages", f.message.id, { ...f.message, gmailApi: undefined });
    expect(await viewAttachment(f.vault, attachmentViewGuard(f.vault, "file", () => false))).toMatchObject({ kind: "text" });
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(f.vault.localDocumentChunks("attachment:file")).toEqual([]);
    expect(await f.retrieval.search("zephyr")).toEqual([]);
    await expect(viewAttachment(f.vault, attachmentViewGuard(f.vault, "file", () => false))).rejects.toThrow("revoked");
    f.hooks.generate.mockImplementation(async request => {
      const read = await call(request.tools, "read_message", { messageId: f.message.id });
      expect(read.attachments).toEqual([]);
      const result = await call(request.tools, "read_attachment", { attachmentId: "file" });
      expect(JSON.stringify(result)).not.toContain("zephyr attachment");
      return { answer: "No attachment", citationIds: [] };
    });
    await f.send();
    expect(f.chat.snapshot().conversations[0].turns.at(-1)?.citations.every(c => !c.attachmentId)).toBe(true);
  });

  it.each(["account", "source"])("persists API %s dependencies and redacts prior conversations after revoke", async revoke => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "read_message", { messageId: f.message.id });
      return { answer: "Zephyr confidential answer", citationIds: [result.citation.id] };
    });
    await f.send();
    expect(JSON.stringify(f.chat.snapshot())).toContain("Zephyr confidential answer");
    const stored = JSON.stringify(f.vault.get("checkpoints", "chat:v1"));
    expect(stored).toContain('"id":"api"');
    expect(stored).toContain('"id":"api:mail"');
    f.vault.put("messages", f.message.id, { ...f.message, gmailApi: undefined });
    if (revoke === "account") f.vault.put("accounts", f.api.id, { ...f.api, aiEnabled: false });
    else f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(f.chat.snapshot().conversations[0].title).toBe("Conversation unavailable");
    expect(JSON.stringify(f.vault.get("checkpoints", "chat:v1"))).not.toContain("Zephyr confidential answer");
  });

  it("redacts chat attachment citations even when only the attachment retains API origin", async () => {
    const f = fixture();
    f.vault.put("messages", f.message.id, { ...f.message, gmailApi: undefined });
    await f.retrieval.indexAttachment(f.attachment, [{ text: "zephyr attachment", location: "Page 1" }]);
    f.hooks.generate.mockImplementation(async request => {
      const result = await call(request.tools, "read_attachment", { attachmentId: "file" });
      return { answer: "Private attachment answer", citationIds: [result.excerpts[0].id] };
    });
    await f.send();
    expect(f.chat.snapshot().conversations[0].turns.at(-1)?.citations[0]?.attachmentId).toBe("file");
    f.vault.put("accounts", f.api.id, { ...f.api, consent: false });
    expect(f.chat.snapshot().conversations[0].title).toBe("Conversation unavailable");
  });

  it("discards an in-flight focus narrative when origin AI consent is revoked", async () => {
    const f = fixture();
    const generate = vi.fn(async () => {
      f.vault.put("accounts", f.api.id, { ...f.api, aiEnabled: false });
      return { answer: "Private focus narrative", citationIds: [f.citation.id] };
    });
    const productivity = new ProductivityService(f.vault, { changed: vi.fn(), generate, schedule: vi.fn() });
    await productivity.command({ type: "report.generate" }, f.workspace());
    expect(generate).toHaveBeenCalledOnce();
    expect(productivity.snapshot(f.workspace()).focusReport?.narrative).toBeUndefined();
    expect(JSON.stringify(f.vault.all("reports"))).not.toContain("Private focus narrative");
  });

  it("retains report origin dependencies after a genuine browser recapture", async () => {
    const f = fixture();
    const productivity = new ProductivityService(f.vault, { changed: vi.fn(),
      generate: vi.fn(async () => ({ answer: "Private retained narrative", citationIds: [f.citation.id] })), schedule: vi.fn() });
    await productivity.command({ type: "report.generate" }, f.workspace());
    expect(productivity.snapshot(f.workspace()).focusReport?.narrative).toBe("Private retained narrative");
    f.vault.put("messages", f.message.id, { ...f.message, gmailApi: undefined });
    f.vault.put("accounts", f.api.id, { ...f.api, aiEnabled: false });
    expect(productivity.snapshot(f.workspace()).focusReport?.narrative).toBeUndefined();
  });

  it("filters attention, review status and productivity after API-source revocation", async () => {
    const f = fixture();
    const productivity = new ProductivityService(f.vault, { changed: vi.fn(), generate: vi.fn(), schedule: vi.fn() });
    expect(productivity.snapshot(f.workspace()).tasks).toHaveLength(1);
    f.vault.put("sources", f.apiSource.id, { ...f.apiSource, selected: false });
    expect(productivity.snapshot(f.workspace()).tasks).toEqual([]);
    expect(productivity.snapshot(f.workspace()).actions).toEqual([]);
    f.hooks.generate.mockImplementation(async request => {
      const recent = await call(request.tools, "list_recent_messages", { accountId: "browser" });
      const attention = await call(request.tools, "attention_overview", { accountId: "browser" });
      expect(recent.messages).toEqual([]);
      expect(attention.shortlist).toEqual([]);
      return { answer: "No evidence", citationIds: [] };
    });
    await f.send();
    expect(f.chat.snapshot().conversations[0].turns.at(-1)?.status).toBe("complete");
  });
});
