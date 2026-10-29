import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_IDLE_TIMEOUT_MS, CHAT_UNBOUNDED_WAIT_MS, ChatAgentRequest, CopilotAdapter, chatSessionConfig } from "../src/main/copilot";
import { MemorySessionFs } from "../src/main/copilot/memory-fs";

const runtime = vi.hoisted(() => ({
  create: vi.fn(), send: vi.fn(), abort: vi.fn(), disconnect: vi.fn(), update: vi.fn(), on: vi.fn()
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue([]);
    getAuthStatus = vi.fn().mockResolvedValue({ isAuthenticated: true });
    listModels = vi.fn().mockResolvedValue([{ id: "selected-model", name: "Selected" }]);
    createSession = runtime.create;
  }
}));
const request = (signal = new AbortController().signal): ChatAgentRequest => ({
  prompt: '{"userMessage":"Hello"}', model: "selected-model", signal, progress: vi.fn(),
  tools: [{ name: "read_message", parameters: { type: "object", properties: {} }, skipPermission: true, handler: vi.fn() }]
});
beforeEach(() => {
  runtime.send.mockReset().mockResolvedValue({ data: { content: '{"answer":"Hello","citationIds":[]}' } });
  runtime.abort.mockReset().mockResolvedValue(undefined);
  runtime.disconnect.mockReset().mockResolvedValue(undefined);
  runtime.update.mockReset().mockResolvedValue(undefined);
  runtime.on.mockReset().mockReturnValue(vi.fn());
  runtime.create.mockReset().mockResolvedValue({
    sendAndWait: runtime.send, abort: runtime.abort, disconnect: runtime.disconnect, on: runtime.on,
    rpc: { options: { update: runtime.update } }
  });
  afterEach(() => vi.useRealTimers());
});
describe("isolated SDK chat agent (offline)", () => {
  it("exposes only app tools and retains every no-files/no-shell/no-MCP privacy restriction", () => {
    const config = chatSessionConfig("selected-model", ".", new MemorySessionFs(), request().tools);
    expect(config.availableTools).toEqual(["read_message"]);
    expect(config.excludedTools).toEqual(["builtin:*", "mcp:*"]);
    expect(config.mcpServers).toEqual({});
    expect(config.pluginDirectories).toEqual([]);
    expect(config.skillDirectories).toEqual([]);
    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.enableSessionStore).toBe(false);
    expect(config.enableSessionTelemetry).toBe(false);
    expect(config.enableFileHooks).toBe(false);
    expect(config.enableHostGitOperations).toBe(false);
    expect(config.memory?.enabled).toBe(false);
    expect(config.model).toBe("selected-model");
    expect(config.streaming).toBe(true);
    expect(config.systemMessage).toMatchObject({ mode: "replace" });
    expect(config.systemMessage?.content).toContain("refresh_inbox");
    expect(config.systemMessage?.content).toContain("Missing choice means local");
    expect(config.systemMessage?.content).toContain("A local choice is NOT a failed refresh");
    expect(config.systemMessage?.content).toContain("never call it exhaustive");
    expect(config.createSessionFsProvider).toBeTypeOf("function");
  });
  it("creates a real tool-capable SDK session using the selected model and cleans it up", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    const input = request();
    await expect(adapter.chat(input)).resolves.toMatchObject({ answer: "Hello" });
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({ model: "selected-model", tools: input.tools }));
    expect(runtime.update).toHaveBeenCalledWith({ installedPlugins: [] });
    expect(runtime.send).toHaveBeenCalledWith({ prompt: input.prompt }, CHAT_UNBOUNDED_WAIT_MS);
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    await adapter.stop();
  });
  it("cancels only its captured SDK session and releases its busy gate", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    const controller = new AbortController();
    runtime.send.mockImplementationOnce(() => new Promise(() => {}));
    const running = adapter.chat(request(controller.signal));
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalled());
    await expect(adapter.chat(request())).rejects.toThrow("Another");
    const outcome = expect(running).rejects.toThrow("cancelled");
    controller.abort(); await outcome;
    expect(runtime.abort).toHaveBeenCalled(); expect(runtime.disconnect).toHaveBeenCalledOnce();
    await expect(adapter.chat(request())).resolves.toHaveProperty("answer");
    await adapter.stop();
  });
  it("rejects unavailable models and oversized prompts without sending a request", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    await expect(adapter.chat({ ...request(), model: "not-entitled" })).rejects.toThrow("not available");
    await expect(adapter.chat({ ...request(), prompt: "x".repeat(100001) })).rejects.toThrow("too long");
    expect(runtime.send).not.toHaveBeenCalled();
    await adapter.stop();
  });
  it("does not cap agent rounds; many tool rounds still return the final answer", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    let listener!: (event: { type: string }) => void;
    runtime.on.mockImplementation(callback => { listener = callback; return vi.fn(); });
    runtime.send.mockImplementation(async () => {
      for (let i = 0; i < 60; i++) listener({ type: "assistant.turn_start" });
      return { data: { content: JSON.stringify({ answer: "Done after many rounds", citationIds: [] }) } };
    });
    await expect(adapter.chat(request())).resolves.toMatchObject({ answer: "Done after many rounds" });
    await adapter.stop();
  });
  it("lets a progressing response continue past three minutes without exposing reasoning text", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    await adapter.connect();
    vi.useFakeTimers();
    let listener!: (event: { type: string; data?: { deltaContent: string } }) => void;
    let finish!: (value: unknown) => void;
    runtime.on.mockImplementation(callback => { listener = callback; return vi.fn(); });
    runtime.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = request(), running = adapter.chat(input);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120000);
    listener({ type: "assistant.reasoning_delta", data: { deltaContent: "PRIVATE_REASONING" } });
    await vi.advanceTimersByTimeAsync(120000);
    listener({ type: "assistant.message_delta", data: { deltaContent: "PARTIAL_JSON" } });
    expect(runtime.abort).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.progress).mock.calls)).not.toMatch(/PRIVATE_REASONING|PARTIAL_JSON/);
    finish({ data: { content: '{"answer":"Completed overview","citationIds":[]}' } });
    await expect(running).resolves.toMatchObject({ answer: "Completed overview" });
    expect(vi.getTimerCount()).toBe(0);
    await adapter.stop();
  });
  it("times out a stalled response, ignores unrelated events and releases the busy gate", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    await adapter.connect(); vi.useFakeTimers();
    let listener!: (event: { type: string }) => void;
    runtime.on.mockImplementation(callback => { listener = callback; return vi.fn(); });
    runtime.send.mockImplementationOnce(() => new Promise(() => {}));
    const running = adapter.chat(request());
    const outcome = expect(running).rejects.toMatchObject({ reason: "idle" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_TIMEOUT_MS - 1);
    listener({ type: "session.usage_info" });
    await vi.advanceTimersByTimeAsync(1); await outcome;
    expect(runtime.abort).toHaveBeenCalled();
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(adapter.chat(request())).resolves.toHaveProperty("answer");
    await adapter.stop();
  });
  it("counts completed inbox/download phases as activity while a local tool awaits fresh evidence", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    await adapter.connect(); vi.useFakeTimers();
    let activity!: () => void;
    const unsubscribe = vi.fn();
    let finish!: (value: { data: { content: string } }) => void;
    runtime.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = { ...request(), onToolActivity: (listener: () => void) => { activity = listener; return unsubscribe; } };
    const running = adapter.chat(input);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120000);
    activity();
    await vi.advanceTimersByTimeAsync(120000);
    expect(runtime.abort).not.toHaveBeenCalled();
    finish({ data: { content: '{"answer":"Fresh inbox evidence downloaded.","citationIds":[]}' } });
    await expect(running).resolves.toMatchObject({ answer: "Fresh inbox evidence downloaded." });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await adapter.stop();
  });
  it("has no overall deadline and never treats a long-running tool as a stall", async () => {
    const adapter = new CopilotAdapter(".", vi.fn());
    await adapter.connect(); vi.useFakeTimers();
    let listener!: (event: { type: string; data?: unknown }) => void;
    runtime.on.mockImplementation(callback => { listener = callback; return vi.fn(); });
    let finish!: (value: { data: { content: string } }) => void;
    runtime.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = adapter.chat(request());
    await vi.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 120000) {
      await vi.advanceTimersByTimeAsync(120000);
      listener({ type: "assistant.message_delta" });
    }
    listener({ type: "tool.execution_start", data: { toolCallId: "build" } });
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_TIMEOUT_MS * 5);
    expect(runtime.abort).not.toHaveBeenCalled();
    listener({ type: "tool.execution_complete", data: { toolCallId: "build" } });
    finish({ data: { content: '{"answer":"Long task done","citationIds":[]}' } });
    await expect(running).resolves.toMatchObject({ answer: "Long task done" });
    expect(vi.getTimerCount()).toBe(0);
    await adapter.stop();
  });
});
