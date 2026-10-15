import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySessionFs } from "../src/main/copilot/memory-fs";
import { CopilotAdapter, isolatedSessionConfig, responseSchema, subscriptionClientOptions } from "../src/main/copilot";

const runtime = vi.hoisted(() => ({
  send: vi.fn(), abort: vi.fn(), disconnect: vi.fn(), update: vi.fn(), deleteSession: vi.fn()
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue([]);
    getAuthStatus = vi.fn().mockResolvedValue({ isAuthenticated: true });
    listModels = vi.fn().mockResolvedValue([{ id: "test-model", name: "Test" }]);
    deleteSession = runtime.deleteSession;
    createSession = vi.fn(async () => ({
      sessionId: "memory-only", sendAndWait: runtime.send, abort: runtime.abort,
      disconnect: runtime.disconnect, rpc: { options: { update: runtime.update } }
    }));
  }
}));

describe("memory-only Copilot generation lifecycle", () => {
  beforeEach(() => {
    runtime.send.mockReset().mockResolvedValue({ data: { content: JSON.stringify({ answer: "A reviewable response.", citationIds: [] }) } });
    runtime.abort.mockReset().mockResolvedValue(undefined);
    runtime.disconnect.mockReset().mockResolvedValue(undefined);
    runtime.update.mockReset().mockResolvedValue(undefined);
    runtime.deleteSession.mockReset().mockRejectedValue(new Error("Session file not found"));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  it("returns a generated answer without attempting to delete a nonexistent disk session", async () => {
    const clear = vi.spyOn(MemorySessionFs.prototype, "clear");
    const adapter = new CopilotAdapter(".", vi.fn());
    await expect(adapter.generate("Draft a reply", [], "test-model")).resolves.toMatchObject({ answer: "A reviewable response." });
    expect(runtime.update).toHaveBeenCalledWith({ installedPlugins: [] });
    expect(runtime.abort).toHaveBeenCalledOnce();
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(runtime.deleteSession).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
    await adapter.stop();
  });
  it("clears memory and releases the busy state even if session cleanup fails", async () => {
    const clear = vi.spyOn(MemorySessionFs.prototype, "clear");
    const adapter = new CopilotAdapter(".", vi.fn());
    runtime.abort.mockRejectedValueOnce(new Error("Abort failed"));
    await expect(adapter.generate("Draft", [], "test-model")).rejects.toThrow("Abort failed");
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    await expect(adapter.generate("Draft again", [], "test-model")).resolves.toHaveProperty("answer");
    expect(clear).toHaveBeenCalledTimes(2);
    await adapter.stop();
  });
  it("preserves generation errors while still clearing the private session data", async () => {
    const clear = vi.spyOn(MemorySessionFs.prototype, "clear");
    runtime.send.mockRejectedValueOnce(new Error("Model request failed"));
    const adapter = new CopilotAdapter(".", vi.fn());
    await expect(adapter.generate("Draft", [], "test-model")).rejects.toThrow("Model request failed");
    expect(clear).toHaveBeenCalledOnce();
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    await adapter.stop();
  });
});

describe("isolated subscription adapter", () => {
  it("uses desktop credential discovery without token overrides or disabling the keychain", () => {
    const environment = {
      USERPROFILE: "C:\\Users\\test", COPILOT_HOME: "C:\\Users\\test\\.copilot",
      GITHUB_TOKEN: "fake", GH_TOKEN: "fake", COPILOT_GITHUB_TOKEN: "fake", COPILOT_SDK_AUTH_TOKEN: "fake",
      COPILOT_DISABLE_KEYTAR: "1", COPILOT_CLI_PATH: "untrusted", COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "untrusted"
    };
    const config = subscriptionClientOptions("C:\\relay", environment);
    expect(config.mode).toBe("copilot-cli");
    expect(config.useLoggedInUser).toBe(true);
    expect(config.enableRemoteSessions).toBe(false);
    expect(config.env).toMatchObject({ USERPROFILE: environment.USERPROFILE, COPILOT_HOME: environment.COPILOT_HOME });
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_SDK_AUTH_TOKEN",
      "COPILOT_DISABLE_KEYTAR", "COPILOT_CLI_PATH", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"])
      expect(config.env).not.toHaveProperty(name);
    expect(environment.COPILOT_DISABLE_KEYTAR).toBe("1");
    expect(config.sessionFs?.capabilities?.sqlite).toBe(false);
  });
  it("disables tools, discovery, memory and plaintext session persistence", () => {
    const config = isolatedSessionConfig("model-id", "C:\\relay", new MemorySessionFs());
    expect(config.availableTools).toEqual([]);
    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.skipCustomInstructions).toBe(true);
    expect(config.enableSessionStore).toBe(false);
    expect(config.createSessionFsProvider).toBeTypeOf("function");
    expect(config.memory?.enabled).toBe(false);
    expect(config.enableSkills).toBe(false);
    expect(config.customAgentsLocalOnly).toBe(true);
    expect(config.manageScheduleEnabled).toBe(false);
    expect(config.coauthorEnabled).toBe(false);
    expect(config.enableExperimentalMode).toBe(false);
    expect(config.mcpOAuthTokenStorage).toBe("in-memory");
  });
  it("stores virtual artifacts only in memory and supports cleanup", async () => {
    const fs = new MemorySessionFs();
    await fs.writeFile("C:\\relay-session\\events.jsonl", "secret\n");
    await fs.appendFile("C:\\relay-session\\events.jsonl", "next\n");
    expect(await fs.readFile("C:\\relay-session\\events.jsonl")).toBe("secret\nnext\n");
    expect(await fs.readdir("C:\\relay-session")).toContain("events.jsonl");
    fs.clear();
    expect(await fs.exists("C:\\relay-session\\events.jsonl")).toBe(false);
  });
  it("rejects success-shaped malformed AI output", () => {
    expect(responseSchema.safeParse({ answer: "Sent it", tool: "send", citationIds: [] }).success).toBe(false);
    expect(responseSchema.safeParse({ answer: "", citationIds: [] }).success).toBe(false);
  });
});
