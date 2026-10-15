import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Account, Message, Source } from "../src/shared/contracts";
import { Vault } from "../src/main/storage/vault";
import { Retrieval } from "../src/main/retrieval";

const mock = vi.hoisted(() => ({
  texts: [] as string[], options: [] as unknown[],
  extractor: vi.fn(async (text: string) => ({ data: new Float32Array(/automobile|car/i.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0]) }))
}));
vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: vi.fn(async (_task: string, _model: string, options: unknown) => {
    mock.options.push(options);
    return Object.assign(async (text: string) => { mock.texts.push(text); return mock.extractor(text); }, { dispose: async () => {} });
  })
}));
const roots: { root: string; vault: Vault }[] = [];
function setup() {
  const root = resolve(".test-data", randomUUID()); mkdirSync(root, { recursive: true });
  const vault = new Vault(root, randomBytes(32)); roots.push({ root, vault });
  vault.put<Account>("accounts", "a", { id: "a", provider: "gmail", name: "A", email: "", status: "connected", consent: true, aiEnabled: true });
  vault.put<Source>("sources", "s", { id: "s", accountId: "a", providerId: "s", name: "Inbox", kind: "mail", selected: true });
  const message: Message = { id: "m", accountId: "a", sourceId: "s", providerId: "m", threadId: "m", subject: "Vehicle purchase", sender: "", recipients: [], body: "An automobile for the team", receivedAt: "", url: "", unread: false, revision: "1", historical: false };
  vault.put("messages", "m", message);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sha: "a".repeat(40) }) })));
  return { vault, message, retrieval: new Retrieval(vault, join(root, "models")) };
}
afterEach(() => {
  for (const { root, vault } of roots.splice(0)) { vault.close(); rmSync(root, { recursive: true, force: true }); }
  mock.texts.length = 0; mock.options.length = 0; vi.unstubAllGlobals();
});
describe("hybrid local embeddings", () => {
  it("pins model revision, uses E5 prefixes and retrieves semantic-only evidence", async () => {
    const { vault, retrieval, message } = setup();
    await retrieval.configure(true, "Xenova/multilingual-e5-small");
    await retrieval.indexMessage(message);
    expect((await retrieval.search("car"))[0]?.messageId).toBe("m");
    expect(mock.texts.some(text => text.startsWith("passage: "))).toBe(true);
    expect(mock.texts.some(text => text.startsWith("query: "))).toBe(true);
    expect(mock.options[0]).toMatchObject({ revision: "a".repeat(40), device: "cpu" });
    expect(vault.get<{ revision: string }>("settings", "retrieval-index")?.revision).toBe("a".repeat(40));
    expect(retrieval.stats().mode).toBe("hybrid");
    await retrieval.configure(false, "");
    expect(await retrieval.search("car")).toEqual([]);
    await retrieval.configure(true, "Xenova/multilingual-e5-small");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await retrieval.search("car"))[0]?.messageId).toBe("m");
  });
  it("rechecks permissions after asynchronous inference", async () => {
    const { vault, retrieval, message } = setup();
    await retrieval.configure(true, "Xenova/multilingual-e5-small");
    await retrieval.indexMessage(message);
    mock.extractor.mockImplementationOnce(async () => {
      const account = vault.get<Account>("accounts", "a")!;
      vault.put("accounts", "a", { ...account, consent: false });
      return { data: new Float32Array([1, 0, 0, 0]) };
    });
    expect(await retrieval.search("automobile")).toEqual([]);
  });
});
