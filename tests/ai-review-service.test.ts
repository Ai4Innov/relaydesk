import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Citation, Collection, Message, Settings, Source } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import type { Vault } from "../src/main/storage/vault";

vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({ ConnectorHub: class {
  downloadAttachment = vi.fn();
} }));
vi.mock("../src/main/attachments", () => ({ AttachmentProcessor: class {} }));
vi.mock("../src/main/retrieval", () => ({ Retrieval: class {
  stats = () => ({ indexed: 0, mode: "keyword" });
  configure = vi.fn().mockResolvedValue(undefined);
} }));
vi.mock("../src/main/browser/bridge", () => ({ BrowserBridge: class {
  constructor() { throw new Error("Synthetic archive review must not construct a browser bridge."); }
} }));
vi.mock("../src/main/copilot", () => ({ CopilotAdapter: class {
  status = { status: "ready", message: "Offline test double." };
  models = [{ id: "gpt-6-astra", name: "Synthetic selected model" }];
  stop = vi.fn().mockResolvedValue(undefined);
  generate = vi.fn(async (_prompt: string, citations: Citation[]) => ({
    citationIds: citations.map(citation => citation.id),
    answer: JSON.stringify({
      reviewedCitationIds: citations.map(citation => citation.id), summary: "Synthetic reviewed batch.",
      suggestions: citations.map(citation => ({
        citationId: citation.id, quote: citation.excerpt,
        title: `Review ${citation.messageId}`, reason: "Explicit request; confirm whether still needed.", priority: "normal"
      }))
    })
  }));
} }));
import { RelayService } from "../src/main/service";

class MemoryVault {
  records = new Map<Collection, Map<string, unknown>>();
  get<T>(collection: Collection, id: string): T | undefined {
    const value = this.records.get(collection)?.get(id);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put(collection: Collection, id: string, value: unknown): void {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(id, structuredClone(value));
  }
  all<T>(collection: Collection): T[] {
    return [...(this.records.get(collection)?.values() ?? [])].map(value => structuredClone(value) as T);
  }
  delete(collection: Collection, id: string): void { this.records.get(collection)?.delete(id); }
  count(collection: Collection): number { return this.records.get(collection)?.size ?? 0; }
  bytes(): number { return 0; }
  transaction<T>(work: () => T): T { return work(); }
  listMessages(limit = 500): Message[] {
    return this.all<Message>("messages").sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  }
  restore = vi.fn(async () => {
    this.put("checkpoints", "archive-review:state", {
      status: "running", updatedAt: new Date().toISOString(), failures: 0, failedEvidence: [],
      batchesCompleted: 1, batchLimit: 5
    });
  });
}
const services: RelayService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});
function fixture(count = 9) {
  const vault = new MemoryVault();
  const account: Account = { id: "consented", provider: "gmail", email: "test@example.com", name: "Synthetic", status: "connected", consent: true, aiEnabled: true };
  const source: Source = { id: "mail", accountId: account.id, providerId: "INBOX", name: "Inbox", kind: "mail", selected: true };
  vault.put("accounts", account.id, account);
  vault.put("accounts", "no-ai", { ...account, id: "no-ai", email: "other@example.com", aiEnabled: false, connection: "browser" });
  vault.put("sources", source.id, source);
  vault.put("sources", "other-mail", { ...source, id: "other-mail", accountId: "no-ai" });
  for (let index = 0; index <= count; index++) vault.put("messages", `m${index}`, {
    id: `m${index}`, accountId: index === count ? "no-ai" : account.id, sourceId: index === count ? "other-mail" : source.id,
    providerId: `${index}`, threadId: `${index}`, subject: `Request ${index}`, sender: "sender@example.com", recipients: [],
    body: `Please review document ${index}.`, receivedAt: new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
    url: "https://mail.google.com", unread: false, historical: true, revision: "r1"
  } satisfies Message);
  vault.put("settings", "preferences", {
    ...defaultSettings, model: "gpt-6-astra", aiRunsToday: 1, dailyAiLimit: 2, aiUsageDate: new Date().toISOString().slice(0, 10)
  });
  const host = {
    changed: vi.fn(), openExternal: vi.fn(), copy: vi.fn(), loginCopilot: vi.fn(), backupPath: vi.fn(),
    restorePath: vi.fn().mockResolvedValue("synthetic-encrypted-backup"), settingsChanged: vi.fn(), notify: vi.fn()
  };
  const service = new RelayService(vault as unknown as Vault, ".", host);
  services.push(service);
  return { vault, service, host };
}
function updateSettings(vault: MemoryVault, patch: Partial<Settings>) {
  vault.put("settings", "preferences", { ...vault.get<Settings>("settings", "preferences")!, ...patch });
}

describe("archive review service wiring (offline, no production bridge or AI)", () => {
  it("uses current model and runAi budget, excludes non-consented accounts, and exposes real dashboard output", async () => {
    const { service, vault } = fixture();
    await service.command({ type: "review.start", maxBatches: 20 });
    await service.productivity.review.settled();
    const data = service.snapshot();
    expect(vi.mocked(service.copilot.generate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(service.copilot.generate).mock.calls[0][2]).toBe("gpt-6-astra");
    expect(data.aiReview).toMatchObject({ status: "paused", totalEligible: 9, excluded: 1, reviewed: 4, remaining: 5 });
    expect(data.aiReview?.detail).toContain("budget is exhausted");
    expect(data.settings.aiRunsToday).toBe(2);
    expect(data.settings.model).toBe("gpt-6-astra");
    expect(vault.get<Account>("accounts", "no-ai")?.aiEnabled).toBe(false);
    expect(data.tasks).toHaveLength(4);
    expect(data.actions).toHaveLength(4);
    expect(data.aiReview?.reports).toHaveLength(1);
    expect(data.focusReport?.metrics.totalTasks).toBe(4);
  });

  it("reviews old messages outside the renderer snapshot and keeps dashboard edits/completion synchronized", async () => {
    const { service } = fixture(501);
    expect(service.snapshot().messages.some(message => message.id === "m0")).toBe(false);
    await service.command({ type: "review.start", maxBatches: 1 });
    await service.productivity.review.settled();
    const task = service.snapshot().tasks!.find(task => task.sourceMessageId === "m0")!;
    expect(task).toBeDefined();
    await service.command({ type: "task.edit", taskId: task.id, title: "My edited dashboard task", notes: "Keep this", status: "done" });
    expect(service.snapshot().actions.find(action => action.id === task.sourceActionId)).toMatchObject({ title: "My edited dashboard task", status: "done" });
    await service.command({ type: "action.update", actionId: task.sourceActionId!, status: "open" });
    expect(service.snapshot().tasks!.find(item => item.id === task.id)).toMatchObject({ title: "My edited dashboard task", notes: "Keep this", status: "open" });
    await service.command({ type: "action.update", actionId: task.sourceActionId!, status: "snoozed", snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
    const action = service.vault.get("actions", task.sourceActionId!) as { snoozedUntil?: string };
    service.vault.put("actions", task.sourceActionId!, { ...action, snoozedUntil: new Date(Date.now() - 1).toISOString() });
    expect(service.snapshot().tasks!.find(item => item.id === task.id)?.status).toBe("open");
  });

  it("honors automation pause before starting and discards cancelled in-flight output", async () => {
    const { service, vault } = fixture();
    updateSettings(vault, { syncPaused: true });
    await expect(service.command({ type: "review.start", maxBatches: 1 })).rejects.toThrow("Automation is paused");
    expect(service.copilot.generate).not.toHaveBeenCalled();
    updateSettings(vault, { syncPaused: false });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(service.copilot.generate).mockImplementation(async (_prompt, citations) => {
      await wait;
      return { answer: "Discard this result.", citationIds: citations.map(citation => citation.id) };
    });
    await service.command({ type: "review.start", maxBatches: 1 });
    await service.command({ type: "review.cancel" });
    release(); await service.productivity.review.settled();
    expect(service.snapshot().aiReview).toMatchObject({ status: "cancelled", reviewed: 0, reports: [] });
    expect(vault.count("actions")).toBe(0);
  });

  it("never resumes a running checkpoint restored from a backup", async () => {
    const { service, vault } = fixture();
    await service.command({ type: "archive.restore" });
    expect(vault.restore).toHaveBeenCalledOnce();
    expect(service.snapshot().aiReview?.status).toBe("paused");
    expect(service.snapshot().settings.syncPaused).toBe(true);
    expect(service.copilot.generate).not.toHaveBeenCalled();
  });
});
