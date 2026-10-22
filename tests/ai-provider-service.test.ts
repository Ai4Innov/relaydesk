import { afterEach, describe, expect, it, vi } from "vitest";
import type { Collection, Settings } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";
import type { Vault } from "../src/main/storage/vault";
import { commandSchema } from "../src/main/ipc/schema";

vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/connectors", () => ({ ConnectorHub: class {} }));
vi.mock("../src/main/attachments", () => ({ AttachmentProcessor: class {} }));
vi.mock("../src/main/retrieval", () => ({ Retrieval: class {
  stats = () => ({ indexed: 0, mode: "keyword" });
  configure = vi.fn().mockResolvedValue(undefined);
} }));
vi.mock("../src/main/browser/bridge", () => ({ BrowserBridge: class {
  constructor() { throw new Error("No browser bridge in provider tests."); }
} }));
vi.mock("../src/main/copilot", () => ({ CopilotAdapter: class {
  id = "copilot"; name = "GitHub Copilot"; auth = "subscription";
  status = { status: "ready", message: "Copilot ready." };
  models = [{ id: "gpt-copilot", name: "Copilot model" }];
  connect = vi.fn(async () => {}); stop = vi.fn(async () => {});
} }));
vi.mock("../src/main/ai/claude", () => ({ ClaudeAdapter: class {
  id = "claude"; name = "Claude"; auth = "api-key";
  status = { status: "disconnected", message: "Add your Anthropic API key." };
  models: { id: string; name: string }[] = [];
  constructor(private key: () => string | undefined) {}
  connect = vi.fn(async () => {
    if (!this.key()) { this.status = { status: "error", message: "Add your Anthropic API key." }; throw new Error("no key"); }
    this.models = [{ id: "claude-x", name: "Claude X" }];
    this.status = { status: "ready", message: "Claude ready." };
  });
  reset = vi.fn(() => { this.status = { status: "disconnected", message: "reset" }; this.models = []; });
  stop = vi.fn(async () => {});
} }));
vi.mock("../src/main/ai/codex", () => ({ CodexAdapter: class {
  id = "codex"; name = "OpenAI Codex"; auth = "subscription"; executable = "/opt/codex";
  status = { status: "disconnected", message: "Not connected." };
  models: { id: string; name: string }[] = [];
  connect = vi.fn(async () => { this.models = [{ id: "gpt-codex", name: "Codex model" }]; this.status = { status: "ready", message: "Codex ready." }; });
  stop = vi.fn(async () => {});
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
  all<T>(collection: Collection): T[] { return [...(this.records.get(collection)?.values() ?? [])].map(value => structuredClone(value) as T); }
  delete(collection: Collection, id: string): void { this.records.get(collection)?.delete(id); }
  count(collection: Collection): number { return this.records.get(collection)?.size ?? 0; }
  bytes(): number { return 0; }
  transaction<T>(work: () => T): T { return work(); }
  listMessages(): never[] { return []; }
}

const services: RelayService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });
function fixture() {
  const vault = new MemoryVault();
  vault.put("settings", "preferences", { ...defaultSettings, model: "gpt-copilot" });
  const host = { changed: vi.fn(), openExternal: vi.fn(), copy: vi.fn(), loginCopilot: vi.fn(), loginCodex: vi.fn(async () => {}),
    backupPath: vi.fn(), restorePath: vi.fn(), settingsChanged: vi.fn(), notify: vi.fn() };
  const service = new RelayService(vault as unknown as Vault, ".", host);
  services.push(service);
  return { vault, service, host, settings: () => vault.get<Settings>("settings", "preferences")! };
}

describe("AI provider selection", () => {
  it("migrates old 'off' tool defaults to approval cards once, then respects the user's choice", async () => {
    const vault = new MemoryVault();
    vault.put("settings", "preferences", { ...defaultSettings, toolAccessRevision: undefined, assistantShell: "off", assistantWeb: "off", assistantTools: false });
    const host = { changed: vi.fn(), openExternal: vi.fn(), copy: vi.fn(), loginCopilot: vi.fn(), loginCodex: vi.fn(async () => {}),
      backupPath: vi.fn(), restorePath: vi.fn(), settingsChanged: vi.fn(), notify: vi.fn() };
    services.push(new RelayService(vault as unknown as Vault, ".", host));
    expect(vault.get<Settings>("settings", "preferences")).toMatchObject({ assistantTools: true, assistantShell: "ask", assistantWeb: "ask", toolAccessRevision: 1 });
    vault.put("settings", "preferences", { ...vault.get<Settings>("settings", "preferences")!, assistantShell: "off" });
    services.push(new RelayService(vault as unknown as Vault, ".", host));
    expect(vault.get<Settings>("settings", "preferences")!.assistantShell).toBe("off");
  });
  it("switches providers, remembers each provider's model and reports per-provider status", async () => {
    const { service, settings } = fixture();
    await service.command({ type: "ai.provider", provider: "codex" });
    expect(settings()).toMatchObject({ aiProvider: "codex", model: "", providerModels: { copilot: "gpt-copilot" } });
    await service.command({ type: "settings.update", patch: { model: "gpt-codex" } });
    expect(service.snapshot().models.map(model => model.id)).toEqual(["gpt-codex"]);
    await expect(service.command({ type: "settings.update", patch: { model: "gpt-copilot" } })).rejects.toThrow();
    await service.command({ type: "ai.provider", provider: "copilot" });
    expect(settings()).toMatchObject({ aiProvider: "copilot", model: "gpt-copilot", providerModels: { codex: "gpt-codex" } });
    const snapshot = service.snapshot();
    expect(snapshot.ai?.provider).toBe("copilot");
    expect(snapshot.ai?.providers.map(item => item.id)).toEqual(["copilot", "claude", "codex"]);
  });

  it("stores the Claude key encrypted, never exposes it, and opens the Codex login through the host", async () => {
    const { service, vault, host } = fixture();
    const key = "sk-ant-api03-" + "a".repeat(40);
    await service.command({ type: "ai.provider", provider: "claude" });
    expect(service.snapshot().ai?.providers.find(item => item.id === "claude")).toMatchObject({ hasKey: false });
    await service.command({ type: "ai.claudeKey", key });
    expect(vault.get("secrets", "ai:anthropic")).toEqual({ key });
    const snapshot = service.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(key);
    expect(snapshot.ai?.providers.find(item => item.id === "claude")).toMatchObject({ hasKey: true, status: "ready" });
    await expect(service.command({ type: "copilot.login" })).rejects.toThrow(/API key/);
    await service.command({ type: "ai.claudeKey.clear" });
    expect(vault.get("secrets", "ai:anthropic")).toBeUndefined();
    await service.command({ type: "ai.provider", provider: "codex" });
    await service.command({ type: "copilot.login" });
    expect(host.loginCodex).toHaveBeenCalledWith("/opt/codex");
  });

  it("validates provider commands at the IPC boundary", () => {
    expect(commandSchema.safeParse({ type: "ai.provider", provider: "claude" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "ai.provider", provider: "other" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "ai.claudeKey", key: "not-a-key" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "settings.update", patch: { codexPath: "relative/codex" } }).success).toBe(false);
  });
});
