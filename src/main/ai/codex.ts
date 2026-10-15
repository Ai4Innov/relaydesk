import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { Citation, ModelInfo, Snapshot } from "../../shared/contracts";
import { CHAT_PROMPT_MAX, ChatLimitError, ChatTimeoutError } from "../../shared/chat";
import { host, type PlatformProfile } from "../platform";
import { CHAT_CORE_INSTRUCTIONS, ChatTimers, GENERATE_INSTRUCTIONS, generationPrompt, parseAgentResponse, responseJsonSchema,
  type AgentResponse, type AiProvider, type AppTool, type ChatAgentRequest } from "./agent";
import { McpToolBridge } from "./mcp-bridge";
import { WORKSPACE_TOOL_PROGRESS, appWorkspacePrompt, workspaceTools } from "./workspace-tools";

const TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl"
};
const MCP_TOKEN_ENV = "RELAY_DESK_MCP_TOKEN";
/** Codex features that would give the model capabilities outside Relay Desk's tool and approval model. */
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "view_image", "apps", "plugins", "browser_use", "browser_use_external",
  "computer_use", "image_generation", "multi_agent", "memories", "hooks", "in_app_browser", "tool_suggest", "skill_search",
  "skill_mcp_dependency_install", "goals", "realtime_conversation"];

const isFile = async (path: string) => stat(path).then(info => info.isFile(), () => false);

/** Finds the native binary inside an npm-installed `@openai/codex` package (bundled vendor or platform package). */
async function nativeFromPackage(packageRoot: string, profile: PlatformProfile, arch = process.arch): Promise<string | undefined> {
  const key = `${profile.id}-${arch}`;
  const triple = TRIPLES[key];
  if (!triple) return undefined;
  const binary = profile.id === "win32" ? "codex.exe" : "codex";
  const bases = [profile.path.join(packageRoot, "node_modules", "@openai", `codex-${key}`), profile.path.join(profile.path.dirname(packageRoot), `codex-${key}`), packageRoot];
  for (const base of bases)
    for (const candidate of [profile.path.join(base, "vendor", triple, "bin", binary), profile.path.join(base, "vendor", triple, "codex", binary)])
      if (await isFile(candidate)) return candidate;
  return undefined;
}

/** Resolves a `codex` launcher (native binary, npm shim, or symlink to codex.js) to the native executable. */
export async function resolveCodexLauncher(path: string, profile: PlatformProfile = host): Promise<string | undefined> {
  if (!await isFile(path)) return undefined;
  const real = await realpath(path).catch(() => path);
  if (/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(real))
    return nativeFromPackage(profile.path.dirname(profile.path.dirname(real)), profile);
  if (profile.id === "win32" && /\.exe$/i.test(real)) return real;
  const head = await readFile(real).then(bytes => bytes.subarray(0, 4096).toString("utf8"), () => "");
  const shim = /(?:%dp0%|\$basedir)[\\/]((?:[^"\s]*?[\\/])?node_modules[\\/]@openai[\\/]codex)[\\/]bin[\\/]codex\.js/.exec(head);
  if (shim) return nativeFromPackage(profile.path.resolve(profile.path.dirname(path), shim[1].replace(/[\\/]/g, profile.path.sep)), profile);
  if (profile.id !== "win32" && !head.startsWith("#!")) return real;
  return undefined;
}

/** Locates the user's installed Codex CLI. GUI apps on macOS/Linux do not inherit the shell PATH, so common install folders are checked too. */
export async function locateCodex(configured: string, env: NodeJS.ProcessEnv = process.env, profile: PlatformProfile = host,
  home = homedir()): Promise<string | undefined> {
  if (configured) return resolveCodexLauncher(configured, profile);
  const dirs = (env.PATH ?? env.Path ?? "").split(profile.id === "win32" ? ";" : ":").filter(Boolean);
  if (profile.id === "win32") dirs.push(...[env.APPDATA && profile.path.join(env.APPDATA, "npm"), env.LOCALAPPDATA && profile.path.join(env.LOCALAPPDATA, "Programs", "codex")].filter((dir): dir is string => !!dir));
  else dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", profile.path.join(home, ".local", "bin"), profile.path.join(home, ".npm-global", "bin"),
    profile.path.join(home, ".volta", "bin"), profile.path.join(home, ".bun", "bin"), profile.path.join(home, ".codex", "bin"));
  const names = profile.id === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of [...new Set(dirs)])
    for (const name of names) {
      const found = await resolveCodexLauncher(profile.path.join(dir, name), profile).catch(() => undefined);
      if (found) return found;
    }
  return undefined;
}

/** Environment for the Codex CLI: no ambient API keys, so the CLI's own sign-in (ChatGPT plan) is used. */
export function codexEnvironment(environment: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "ELECTRON_RUN_AS_NODE", MCP_TOKEN_ENV]) delete env[name];
  return { ...env, ...extra };
}

/** `codex exec` arguments that isolate a run from the user's Codex config, rules, history, plugins and built-in local tools. */
export function codexExecArgs(options: { directory: string; schemaFile: string; model?: string; mcpUrl?: string }): string[] {
  const config = [
    `approval_policy="never"`, `web_search="disabled"`, "project_doc_max_bytes=0", `history.persistence="none"`,
    ...DISABLED_FEATURES.map(feature => `features.${feature}=false`),
    ...(options.mcpUrl ? [`mcp_servers.relay.url=${JSON.stringify(options.mcpUrl)}`, `mcp_servers.relay.bearer_token_env_var="${MCP_TOKEN_ENV}"`,
      "mcp_servers.relay.startup_timeout_sec=30", "mcp_servers.relay.tool_timeout_sec=900"] : [])
  ];
  return ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--cd", options.directory, "--output-schema", options.schemaFile,
    ...(options.model ? ["--model", options.model] : []), ...config.flatMap(item => ["-c", item]), "-"];
}

export function codexChatInstructions(request: Pick<ChatAgentRequest, "workspace">): string {
  return (request.workspace
    ? "You are Relay Desk, a chat-first personal assistant powered by Codex. Use the supplied relay app tools and the local workspace tools described below; you have no other tools. "
    : "You are Relay Desk, a chat-first personal assistant powered by Codex. Use only the supplied relay app tools; you have no shell, files, internet, or other tools. ") +
    CHAT_CORE_INSTRUCTIONS + (request.workspace ? appWorkspacePrompt(request.workspace) : "");
}

interface CodexEvent { type: string; item?: { type: string; text?: string; tool?: string; server?: string; message?: string }; error?: { message?: string }; message?: string }
type Spawner = typeof nodeSpawn;

/** OpenAI Codex through the user's installed Codex CLI and its own sign-in (`codex login`); no API key is used. */
export class CodexAdapter implements AiProvider {
  readonly id = "codex" as const;
  readonly name = "OpenAI Codex";
  readonly auth = "subscription" as const;
  status: Snapshot["copilot"] = { status: "disconnected", message: "Connect your signed-in Codex CLI (ChatGPT plan). No API key is used." };
  models: ModelInfo[] = [];
  private binary?: string;
  private busy = false;
  private children = new Set<ReturnType<Spawner>>();
  constructor(private workingDirectory: string, private configuredPath: () => string, private changed: () => void,
    private spawner: Spawner = nodeSpawn) {}

  /** Path of the resolved native binary, for opening a login terminal. */
  get executable(): string | undefined { return this.binary; }

  private run(args: string[], options: { input?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (!this.binary) throw new Error("Codex CLI not found.");
    const child = this.spawner(this.binary, args, { env: options.env ?? codexEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child);
    return new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout?.on("data", chunk => { if (stdout.length < 8_000_000) stdout += chunk; });
      child.stderr?.on("data", chunk => { if (stderr.length < 100_000) stderr += chunk; });
      const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
      const abort = () => child.kill();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", error => { clearTimeout(timer); this.children.delete(child); reject(error); });
      child.once("close", code => { clearTimeout(timer); this.children.delete(child); options.signal?.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
      child.stdin?.end(options.input ?? "");
    });
  }
  async connect(): Promise<void> {
    this.status = { status: "connecting", message: "Looking for the Codex CLI and checking its sign-in..." };
    this.changed();
    try {
      this.binary = await locateCodex(this.configuredPath());
      if (!this.binary) throw new Error("Codex CLI not found. Install it (npm install -g @openai/codex, or brew install --cask codex), run codex login, then reconnect. You can also set its path in Settings.");
      const login = await this.run(["login", "status"], { timeoutMs: 30_000 });
      const said = `${login.stdout}\n${login.stderr}`.trim();
      if (login.code !== 0 || /not logged in/i.test(said)) throw new Error("Codex is not signed in. Click Sign in (or run codex login in a terminal), then reconnect.");
      this.models = await this.listModels();
      if (!this.models.length) throw new Error("Codex reported no available models.");
      const plan = /chatgpt/i.test(said) ? "your ChatGPT plan" : "your Codex sign-in";
      this.status = { status: "ready", message: `Signed in to Codex. Requests count against ${plan}'s Codex usage limits.` };
    } catch (error) {
      this.models = [];
      this.status = { status: "error", message: error instanceof Error ? error.message : "Codex connection failed." };
      throw error;
    } finally { this.changed(); }
  }
  private async listModels(): Promise<ModelInfo[]> {
    for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
      const result = await this.run(args, { timeoutMs: 45_000 }).catch(() => undefined);
      if (!result || result.code !== 0) continue;
      try {
        const parsed = JSON.parse(result.stdout) as { models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[] };
        const models = (parsed.models ?? []).filter(model => typeof model.slug === "string" && model.visibility !== "hide")
          .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
          .map(model => ({ id: model.slug!, name: model.display_name || model.slug! }));
        if (models.length) return models;
      } catch { /* try the bundled catalog */ }
    }
    return [];
  }
  private async ready(model: string): Promise<void> {
    if (!model) throw new Error("Choose a Codex model first.");
    if (this.status.status !== "ready" || !this.binary) await this.connect();
    if (!this.models.some(item => item.id === model)) throw new Error("The selected model is not available. Choose another explicitly.");
  }
  /** Runs one isolated `codex exec` turn in a private empty folder and returns its final structured message. */
  private async exec(prompt: string, model: string, options: { signal: AbortSignal; mcpUrl?: string; mcpToken?: string; progress?(text: string): void; activity?(): void }): Promise<string> {
    await mkdir(this.workingDirectory, { recursive: true });
    const scratch = await mkdtemp(host.path.join(this.workingDirectory, "run-"));
    const schemaFile = host.path.join(scratch, "..", `${host.path.basename(scratch)}.schema.json`);
    try {
      await writeFile(schemaFile, JSON.stringify(responseJsonSchema), "utf8");
      const env = codexEnvironment(process.env, options.mcpToken ? { [MCP_TOKEN_ENV]: options.mcpToken } : {});
      const child = this.spawner(this.binary!, codexExecArgs({ directory: scratch, schemaFile, model, mcpUrl: options.mcpUrl }),
        { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      const abort = () => child.kill();
      options.signal.addEventListener("abort", abort, { once: true });
      let stderr = "";
      child.stderr?.on("data", chunk => { if (stderr.length < 20_000) stderr += chunk; });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve(code));
      });
      child.stdin?.end(prompt);
      let final = "", failure = "", lastError = "";
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          options.activity?.();
          let event: CodexEvent;
          try { event = JSON.parse(line) as CodexEvent; } catch { continue; }
          if (event.type === "item.completed" && event.item?.type === "agent_message") final = event.item.text ?? "";
          else if (event.type === "item.started" && event.item?.type === "mcp_tool_call") options.progress?.(WORKSPACE_TOOL_PROGRESS[event.item.tool ?? ""] ?? "Codex is reading your workspace…");
          else if (event.type === "item.started" && event.item?.type === "reasoning") options.progress?.("Codex is thinking…");
          else if (event.type === "turn.failed") failure = event.error?.message ?? "Codex turn failed.";
          // Top-level errors include transient "Reconnecting..." notices; only a failed turn or missing answer is fatal.
          else if (event.type === "error") {
            lastError = event.message ?? "";
            if (/^Reconnecting/i.test(lastError)) options.progress?.("Codex is reconnecting…");
          }
        }
      } finally {
        options.signal.removeEventListener("abort", abort);
        this.children.delete(child);
      }
      const code = await closed;
      options.signal.throwIfAborted();
      failure ||= final.trim() ? "" : lastError;
      if (failure) throw new Error(/401|unauthori[sz]ed|not logged in/i.test(failure) ? "Codex is not signed in. Run codex login, then reconnect." : `Codex: ${failure.slice(0, 500)}`);
      if (code !== 0) throw new Error(/not logged in|login/i.test(stderr) ? "Codex is not signed in. Run codex login, then reconnect." : `Codex exited with code ${code}. ${stderr.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? ""}`);
      if (!final.trim()) throw new Error("Codex returned no answer.");
      return final;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await rm(schemaFile, { force: true }).catch(() => undefined);
    }
  }
  async generate(task: string, citations: Citation[], model: string): Promise<AgentResponse> {
    if (this.busy) throw new Error("Another Codex request is running. Wait for it to finish.");
    this.busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Codex timed out.")), 180_000);
    try {
      await this.ready(model);
      const { prompt, allowed } = generationPrompt(task, citations);
      const parsed = parseAgentResponse(await this.exec(`${GENERATE_INSTRUCTIONS}\n\n${prompt}`, model, { signal: controller.signal }));
      if (parsed.citationIds.some(id => !allowed.has(id))) throw new Error("Codex cited evidence outside this request. Regenerate the response.");
      return parsed;
    } finally { clearTimeout(timer); this.busy = false; }
  }
  async chat(request: ChatAgentRequest): Promise<AgentResponse> {
    if (request.prompt.length > CHAT_PROMPT_MAX) throw new Error("Conversation is too long. Start a new chat; no message was truncated.");
    if (this.busy) throw new Error("Another Codex request is running. Wait for it to finish.");
    request.signal.throwIfAborted();
    this.busy = true;
    const controller = new AbortController();
    let timeoutError: ChatTimeoutError | undefined;
    const timers = new ChatTimers(reason => { timeoutError = new ChatTimeoutError(reason); controller.abort(timeoutError); });
    const forward = () => controller.abort(new Error("Chat cancelled."));
    request.signal.addEventListener("abort", forward, { once: true });
    const unsubscribe = request.onToolActivity?.(() => timers.activity());
    let bridge: McpToolBridge | undefined;
    let calls = 0;
    const maxCalls = request.workspace ? 48 : 24;
    try {
      await this.ready(request.model);
      const tools: AppTool[] = [...request.tools, ...(request.workspace ? workspaceTools(request.workspace) : [])];
      bridge = await McpToolBridge.start(tools, {
        run: (name, work) => {
          if (++calls > maxCalls) {
            controller.abort(new ChatLimitError(`Chat tool-call limit (${maxCalls}) reached. Ask a narrower question.`));
            throw new Error("Tool-call limit reached.");
          }
          if (WORKSPACE_TOOL_PROGRESS[name]) request.progress(WORKSPACE_TOOL_PROGRESS[name]);
          return timers.hold(work);
        }
      });
      request.progress("Codex is thinking…");
      const prompt = `<relay_desk_instructions>\n${codexChatInstructions(request)}\n</relay_desk_instructions>\n\n${request.prompt}`;
      const final = await this.exec(prompt, request.model, { signal: controller.signal, mcpUrl: bridge.url, mcpToken: bridge.token,
        progress: text => request.progress(text), activity: () => timers.activity() });
      let parsed: AgentResponse;
      try { parsed = parseAgentResponse(final); }
      catch { parsed = { answer: final.slice(0, 20000), citationIds: [] }; }
      if (parsed.answer.length > 20000) throw new Error("Codex response exceeded the chat limit.");
      return parsed;
    } catch (error) {
      if (request.signal.aborted) throw new Error("Chat cancelled.");
      if (controller.signal.reason instanceof ChatLimitError) throw controller.signal.reason;
      throw timeoutError ?? error;
    } finally {
      timers.clear();
      unsubscribe?.();
      request.signal.removeEventListener("abort", forward);
      await bridge?.close();
      this.busy = false;
    }
  }
  async stop(): Promise<void> {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
