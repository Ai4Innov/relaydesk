import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentResponse, type AiProvider, type AppTool, type ChatAgentRequest, type ChatWorkspace } from "../src/main/ai/agent";
import { ClaudeAdapter } from "../src/main/ai/claude";
import { CodexAdapter, codexEnvironment, codexExecArgs, resolveCodexLauncher } from "../src/main/ai/codex";
import { McpToolBridge } from "../src/main/ai/mcp-bridge";
import { AiRouter } from "../src/main/ai/router";
import { workspaceTools } from "../src/main/ai/workspace-tools";
import { host } from "../src/main/platform";

const temps: string[] = [];
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), "relay-ai-")); temps.push(dir); return dir; };
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const echo: AppTool = { name: "echo_tool", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } } },
  handler: async args => ({ echoed: (args as { text?: string }).text ?? "" }) };
const chatRequest = (overrides: Partial<ChatAgentRequest> = {}): ChatAgentRequest =>
  ({ prompt: "Hello", model: "m1", tools: [echo], signal: new AbortController().signal, progress: () => {}, ...overrides });

describe("parseAgentResponse", () => {
  it("accepts fenced JSON and drops null optional fields", () => {
    expect(parseAgentResponse("```json\n{\"answer\":\"Hi\",\"priority\":null,\"reason\":null,\"needsReply\":null,\"citationIds\":[]}\n```"))
      .toEqual({ answer: "Hi", citationIds: [] });
  });
  it("rejects unexpected keys", () => {
    expect(() => parseAgentResponse("{\"answer\":\"Hi\",\"citationIds\":[],\"run\":\"rm\"}")).toThrow();
  });
});

describe("AiRouter", () => {
  const fake = (id: "copilot" | "claude" | "codex", auth: AiProvider["auth"]): AiProvider => ({
    id, name: id, auth, status: { status: "ready", message: `${id} ready` }, models: [{ id: `${id}-model`, name: id }],
    connect: vi.fn(async () => {}), generate: vi.fn(async () => ({ answer: id, citationIds: [] })),
    chat: vi.fn(async () => ({ answer: id, citationIds: [] })), stop: vi.fn(async () => {})
  });
  it("routes to the selected provider and stops all of them", async () => {
    const providers = { copilot: fake("copilot", "subscription"), claude: fake("claude", "api-key"), codex: fake("codex", "subscription") };
    let selected: "copilot" | "claude" | "codex" = "claude";
    const router = new AiRouter(providers, () => selected, id => id === "claude");
    expect((await router.generate("t", [], "m")).answer).toBe("claude");
    selected = "codex";
    expect(router.models[0].id).toBe("codex-model");
    expect((await router.chat(chatRequest())).answer).toBe("codex");
    expect(router.info().find(item => item.id === "claude")).toMatchObject({ auth: "api-key", hasKey: true });
    expect(router.info().find(item => item.id === "codex")).not.toHaveProperty("hasKey");
    await router.stop();
    for (const provider of Object.values(providers)) expect(provider.stop).toHaveBeenCalled();
  });
});

describe("ClaudeAdapter", () => {
  const client = (responses: unknown[]) => {
    const create = vi.fn(async () => responses.shift());
    return { create, client: {
      models: { list: () => (async function* () { yield { id: "claude-test", display_name: "Claude Test" }; })() },
      messages: { create }
    } };
  };
  it("requires the user's API key", async () => {
    const adapter = new ClaudeAdapter(() => undefined, () => {}, () => { throw new Error("no client expected"); });
    await expect(adapter.connect()).rejects.toThrow(/Anthropic API key/);
  });
  it("lists models and runs an app-tool loop", async () => {
    const fakeClient = client([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo_tool", input: { text: "ping" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "{\"answer\":\"Done\",\"citationIds\":[]}" }] }
    ]);
    const keys: string[] = [];
    const adapter = new ClaudeAdapter(() => "sk-ant-test-key-1234567890abcdef", () => {}, key => { keys.push(key); return fakeClient.client as never; });
    await adapter.connect();
    expect(adapter.models).toEqual([{ id: "claude-test", name: "Claude Test" }]);
    const result = await adapter.chat(chatRequest({ model: "claude-test" }));
    expect(result).toEqual({ answer: "Done", citationIds: [] });
    expect(keys).toEqual(["sk-ant-test-key-1234567890abcdef"]);
    const second = fakeClient.create.mock.calls[1] as unknown as [{ messages: { role: string; content: unknown }[]; tools: { name: string }[] }];
    expect(second[0].tools.map(tool => tool.name)).toEqual(["echo_tool"]);
    expect(JSON.stringify(second[0].messages[2].content)).toContain("ping");
  });
  it("adds workspace tools only when a workspace is enabled", async () => {
    const fakeClient = client([{ stop_reason: "end_turn", content: [{ type: "text", text: "Plain prose answer" }] }]);
    const adapter = new ClaudeAdapter(() => "sk-ant-test-key-1234567890abcdef", () => {}, () => fakeClient.client as never);
    const workspace: ChatWorkspace = { directory: await tempDir(), shell: false, web: false, permission: async () => "deny", readApproved: () => false };
    const result = await adapter.chat(chatRequest({ model: "claude-test", workspace }));
    expect(result).toEqual({ answer: "Plain prose answer", citationIds: [] });
    const names = (fakeClient.create.mock.calls[0] as unknown as [{ tools: { name: string }[] }])[0].tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["echo_tool", "read_file", "write_file"]));
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("web_fetch");
  });
  it("rejects an unknown model without silent substitution", async () => {
    const adapter = new ClaudeAdapter(() => "sk-ant-test-key-1234567890abcdef", () => {}, () => client([]).client as never);
    await expect(adapter.generate("task", [], "other-model")).rejects.toThrow(/not available/);
  });
});

describe("workspace tools", () => {
  const tools = (workspace: ChatWorkspace) => new Map(workspaceTools(workspace).map(tool => [tool.name, tool]));
  it("writes inside the workspace and refuses writes outside it", async () => {
    const directory = await tempDir();
    const map = tools({ directory, shell: false, web: false, permission: async () => "deny", readApproved: () => false });
    expect(await map.get("write_file")!.handler({ path: "notes/report.md", content: "# Report" })).not.toHaveProperty("error");
    expect(await readFile(join(directory, "notes", "report.md"), "utf8")).toBe("# Report");
    const outside = await map.get("write_file")!.handler({ path: join(await tempDir(), "x.txt"), content: "x" }) as { error?: string };
    expect(outside.error).toMatch(/inside the workspace/);
  });
  it("asks before reading outside files and honours a denial", async () => {
    const directory = await tempDir(), other = await tempDir();
    await writeFile(join(other, "secret.txt"), "secret");
    const permission = vi.fn(async () => "deny" as const);
    const map = tools({ directory, shell: false, web: false, permission, readApproved: () => false });
    const result = await map.get("read_file")!.handler({ path: join(other, "secret.txt") }) as { error?: string };
    expect(permission).toHaveBeenCalledWith({ kind: "read", path: join(other, "secret.txt") });
    expect(result.error).toMatch(/denied/);
  });
  it("treats a symlink escaping the workspace as outside", async () => {
    const directory = await tempDir(), other = await tempDir();
    try { await symlink(other, join(directory, "link"), "junction"); } catch { return; }
    const map = tools({ directory, shell: false, web: false, permission: async () => "deny", readApproved: () => false });
    const result = await map.get("write_file")!.handler({ path: "link/escape.txt", content: "x" }) as { error?: string };
    expect(result.error).toMatch(/inside the workspace/);
  });
  it("only offers shell and web tools when enabled, gated by approval", async () => {
    const directory = await tempDir();
    expect([...tools({ directory, shell: false, web: false, permission: async () => "deny", readApproved: () => false }).keys()])
      .not.toEqual(expect.arrayContaining(["run_shell"]));
    const permission = vi.fn(async () => "deny" as const);
    const map = tools({ directory, shell: true, web: true, permission, readApproved: () => false });
    expect(await map.get("run_shell")!.handler({ command: "echo hi", intention: "test" })).toHaveProperty("error");
    expect(await map.get("web_fetch")!.handler({ url: "https://example.com" })).toHaveProperty("error");
    expect(permission.mock.calls.map(call => (call as unknown as [{ kind: string }])[0].kind)).toEqual(["shell", "url"]);
  });
});

describe("McpToolBridge", () => {
  it("serves app tools to a standard MCP client with the bearer token", async () => {
    const ran: string[] = [];
    const bridge = await McpToolBridge.start([echo], { run: (name, work) => { ran.push(name); return work(); } });
    try {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["echo_tool"]);
      const result = await client.callTool({ name: "echo_tool", arguments: { text: "hi" } });
      expect(JSON.stringify(result.content)).toContain("hi");
      expect(ran).toEqual(["echo_tool"]);
      await client.close();
    } finally { await bridge.close(); }
  });
  it("rejects missing tokens and browser origins", async () => {
    const bridge = await McpToolBridge.start([echo], { run: (_name, work) => work() });
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      expect((await fetch(bridge.url, { method: "POST", headers, body })).status).toBe(401);
      expect((await fetch(bridge.url, { method: "POST", headers: { ...headers, Authorization: "Bearer wrong" }, body })).status).toBe(401);
      expect((await fetch(bridge.url, { method: "POST", headers: { ...headers, Authorization: `Bearer ${bridge.token}`, Origin: "https://evil.example" }, body })).status).toBe(401);
    } finally { await bridge.close(); }
  });
});

describe("Codex CLI integration", () => {
  it("isolates codex exec from user config, rules, built-in tools and ambient API keys", () => {
    const args = codexExecArgs({ directory: "/scratch", schemaFile: "/s.json", model: "gpt-x", mcpUrl: "http://127.0.0.1:1/mcp" });
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--json"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    for (const setting of ['approval_policy="never"', 'web_search="disabled"', "features.shell_tool=false", "features.unified_exec=false",
      'mcp_servers.relay.bearer_token_env_var="RELAY_DESK_MCP_TOKEN"']) expect(args).toContain(setting);
    expect(args.join(" ")).not.toContain("RELAY_DESK_MCP_TOKEN=");
    expect(args.at(-1)).toBe("-");
    const env = codexEnvironment({ PATH: "p", OPENAI_API_KEY: "k", CODEX_API_KEY: "k", OPENAI_BASE_URL: "u", ELECTRON_RUN_AS_NODE: "1" }, { RELAY_DESK_MCP_TOKEN: "t" });
    expect(env).toEqual({ PATH: "p", RELAY_DESK_MCP_TOKEN: "t" });
  });

  it("resolves an npm shim to the native platform binary", async () => {
    const triples: Record<string, string> = { "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
      "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl" };
    const key = `${process.platform}-${process.arch}`;
    if (!triples[key]) return;
    const prefix = await tempDir();
    const pkg = join(prefix, "lib", "node_modules", "@openai", "codex");
    const binDir = join(pkg, "node_modules", "@openai", `codex-${key}`, "vendor", triples[key], "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(pkg, "bin"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    const native = join(binDir, process.platform === "win32" ? "codex.exe" : "codex");
    await writeFile(native, "native");
    await writeFile(join(pkg, "bin", "codex.js"), "// launcher");
    const shim = process.platform === "win32"
      ? [join(prefix, "bin", "codex.cmd"), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\lib\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n']
      : [join(prefix, "bin", "codex"), '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../lib/node_modules/@openai/codex/bin/codex.js" "$@"\n'];
    await writeFile(shim[0], shim[1]);
    expect(await resolveCodexLauncher(shim[0], host)).toBe(native);
  });

  const fakeSpawner = (handle: (args: string[], env: Record<string, string>, input: string, child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => Promise<number>) =>
    vi.fn((_command: string, args: string[], options: { env: Record<string, string> }) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
      let input = "";
      child.stdin.on("data", chunk => { input += chunk; });
      child.stdin.on("finish", () => {
        void handle(args, options.env, input, child).then(code => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", code)); });
      });
      return child;
    });

  it("connects through the CLI sign-in and runs chat tools over the loopback MCP bridge", async () => {
    const dir = await tempDir();
    const binary = join(dir, "codex.exe");
    await writeFile(binary, "native");
    const execArgs: string[][] = [];
    const spawner = fakeSpawner(async (args, env, input, child) => {
      if (args[0] === "login") { child.stderr.write("Logged in using ChatGPT\n"); return 0; }
      if (args[0] === "debug") {
        child.stdout.write(JSON.stringify({ models: [{ slug: "hidden", visibility: "hide", priority: 0 }, { slug: "gpt-b", display_name: "B", visibility: "list", priority: 2 }, { slug: "gpt-a", display_name: "A", visibility: "list", priority: 1 }] }));
        return 0;
      }
      execArgs.push(args);
      expect(input).toContain("<relay_desk_instructions>");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      const url = args.find(arg => arg.startsWith("mcp_servers.relay.url="))!.split("=")[1].replaceAll('"', "");
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${env.RELAY_DESK_MCP_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_tool", arguments: { text: "via-mcp" } } }) });
      const called = await response.json() as { result: { content: { text: string }[] } };
      child.stdout.write(`${JSON.stringify({ type: "error", message: "Reconnecting... 1/5" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ answer: called.result.content[0].text, priority: null, reason: null, needsReply: null, citationIds: [] }) } })}\n`);
      return 0;
    });
    process.env.OPENAI_API_KEY = "should-not-leak";
    try {
      const adapter = new CodexAdapter(join(dir, "work"), () => binary, () => {}, spawner as never);
      await adapter.connect();
      expect(adapter.models.map(model => model.id)).toEqual(["gpt-a", "gpt-b"]);
      expect(adapter.status.message).toMatch(/ChatGPT plan/);
      const result = await adapter.chat(chatRequest({ model: "gpt-a" }));
      expect(result.answer).toContain("via-mcp");
      expect(execArgs[0]).toContain("--ephemeral");
    } finally { delete process.env.OPENAI_API_KEY; }
  });

  it("reports a missing sign-in instead of falling back to an API key", async () => {
    const dir = await tempDir();
    const binary = join(dir, "codex.exe");
    await writeFile(binary, "native");
    const spawner = fakeSpawner(async (_args, _env, _input, child) => { child.stderr.write("Not logged in\n"); return 1; });
    const adapter = new CodexAdapter(join(dir, "work"), () => binary, () => {}, spawner as never);
    await expect(adapter.connect()).rejects.toThrow(/not signed in/);
    expect(adapter.status.status).toBe("error");
  });
});
