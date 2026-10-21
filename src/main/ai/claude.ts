import type Anthropic from "@anthropic-ai/sdk";
import type { Citation, ModelInfo, Snapshot } from "../../shared/contracts";
import { CHAT_PROMPT_MAX, ChatTimeoutError } from "../../shared/chat";
import { CHAT_CORE_INSTRUCTIONS, ChatTimers, GENERATE_INSTRUCTIONS, generationPrompt, parseAgentResponse, toolResultText,
  type AgentResponse, type AiProvider, type AppTool, type ChatAgentRequest } from "./agent";
import { WORKSPACE_TOOL_PROGRESS, appWorkspacePrompt, workspaceTools } from "./workspace-tools";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OUTPUT_TOKENS = 16_000;

type ClaudeClient = Pick<Anthropic, "messages" | "models">;
type ClientFactory = (apiKey: string) => ClaudeClient | Promise<ClaudeClient>;

const defaultFactory: ClientFactory = async apiKey => {
  const { default: Client } = await import("@anthropic-ai/sdk");
  // Explicit key and base URL: ambient ANTHROPIC_* variables must not redirect requests or swap accounts.
  return new Client({ apiKey, authToken: null, baseURL: ANTHROPIC_BASE_URL, maxRetries: 2, timeout: 180_000 });
};

export function claudeChatSystemPrompt(request: Pick<ChatAgentRequest, "workspace">): string {
  return (request.workspace
    ? "You are Relay Desk, a chat-first personal assistant powered by Claude. Use the supplied app tools and the local workspace tools described below; you have no other tools. "
    : "You are Relay Desk, a chat-first personal assistant powered by Claude. Use only the supplied app tools; you have no shell, files, internet, or other tools. ") +
    CHAT_CORE_INSTRUCTIONS + (request.workspace ? appWorkspacePrompt(request.workspace) : "");
}

/** Claude through the Anthropic Messages API, authenticated with the user's own API key stored encrypted in the archive. */
export class ClaudeAdapter implements AiProvider {
  readonly id = "claude" as const;
  readonly name = "Claude";
  readonly auth = "api-key" as const;
  status: Snapshot["copilot"] = { status: "disconnected", message: "Add your Anthropic API key in Settings to use Claude models." };
  models: ModelInfo[] = [];
  private client?: ClaudeClient;
  private clientKey?: string;
  private busy = false;
  private controllers = new Set<AbortController>();
  constructor(private apiKey: () => string | undefined, private changed: () => void, private factory: ClientFactory = defaultFactory) {}

  private async api(): Promise<ClaudeClient> {
    const key = this.apiKey();
    if (!key) throw new Error("Add your Anthropic API key in Settings → AI & assistant to use Claude.");
    if (!this.client || this.clientKey !== key) { this.client = await this.factory(key); this.clientKey = key; }
    return this.client;
  }
  /** Forgets the cached client after the key changes or is removed. */
  reset(): void {
    this.client = undefined; this.clientKey = undefined; this.models = [];
    this.status = { status: "disconnected", message: this.apiKey() ? "API key saved. Connect to load Claude models." : "Add your Anthropic API key in Settings to use Claude models." };
    this.changed();
  }
  async connect(): Promise<void> {
    this.status = { status: "connecting", message: "Checking the Anthropic API key and available Claude models..." };
    this.changed();
    try {
      const models: ModelInfo[] = [];
      for await (const model of (await this.api()).models.list({ limit: 100 })) models.push({ id: model.id, name: model.display_name || model.id });
      if (!models.length) throw new Error("No Claude models are available for this API key.");
      this.models = models;
      this.status = { status: "ready", message: "Connected with your Anthropic API key. Usage is billed to your Anthropic account." };
    } catch (error) {
      this.models = [];
      const status = (error as { status?: number }).status;
      this.status = { status: "error", message: status === 401 ? "Anthropic rejected the API key. Replace it in Settings."
        : error instanceof Error ? error.message : "Claude connection failed." };
      throw new Error(this.status.message);
    } finally { this.changed(); }
  }
  private async ready(model: string): Promise<void> {
    if (!model) throw new Error("Choose a Claude model first.");
    if (this.status.status !== "ready") await this.connect();
    if (!this.models.some(item => item.id === model)) throw new Error("The selected model is not available. Choose another explicitly.");
  }
  async generate(task: string, citations: Citation[], model: string): Promise<AgentResponse> {
    if (this.busy) throw new Error("Another Claude request is running. Wait for it to finish.");
    this.busy = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      await this.ready(model);
      const { prompt, allowed } = generationPrompt(task, citations);
      const response = await (await this.api()).messages.create({ model, max_tokens: 4096, system: GENERATE_INSTRUCTIONS,
        messages: [{ role: "user", content: prompt }] }, { signal: controller.signal, timeout: 120_000 });
      const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
      if (!text.trim()) throw new Error("Claude returned no answer.");
      const parsed = parseAgentResponse(text);
      if (parsed.citationIds.some(id => !allowed.has(id))) throw new Error("Claude cited evidence outside this request. Regenerate the response.");
      return parsed;
    } finally { this.controllers.delete(controller); this.busy = false; }
  }
  async chat(request: ChatAgentRequest): Promise<AgentResponse> {
    if (request.prompt.length > CHAT_PROMPT_MAX) throw new Error("Conversation is too long. Start a new chat; no message was truncated.");
    if (this.busy) throw new Error("Another Claude request is running. Wait for it to finish.");
    request.signal.throwIfAborted();
    this.busy = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timeoutError: ChatTimeoutError | undefined;
    const timers = new ChatTimers(reason => { timeoutError = new ChatTimeoutError(reason); controller.abort(timeoutError); });
    const forward = () => controller.abort(new Error("Chat cancelled."));
    request.signal.addEventListener("abort", forward, { once: true });
    const unsubscribe = request.onToolActivity?.(() => timers.activity());
    try {
      await this.ready(request.model);
      const tools: AppTool[] = [...request.tools, ...(request.workspace ? workspaceTools(request.workspace) : [])];
      const byName = new Map(tools.map(tool => [tool.name, tool]));
      const definitions = tools.map(tool => ({ name: tool.name, description: tool.description ?? tool.name,
        input_schema: { type: "object" as const, ...(tool.parameters ?? {}) } }));
      const system = [{ type: "text" as const, text: claudeChatSystemPrompt(request), cache_control: { type: "ephemeral" as const } }];
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: request.prompt }];
      // No round cap: the idle timeout and overall deadline bound the loop.
      for (;;) {
        request.progress("Claude is thinking…");
        const response = await (await this.api()).messages.create({ model: request.model, max_tokens: OUTPUT_TOKENS, system, tools: definitions, messages },
          { signal: controller.signal });
        timers.activity();
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason === "tool_use") {
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const tool = byName.get(block.name);
            if (WORKSPACE_TOOL_PROGRESS[block.name]) request.progress(WORKSPACE_TOOL_PROGRESS[block.name]);
            const result = tool ? await timers.hold(async () => tool.handler(block.input)) : { error: `Unknown tool ${block.name}.` };
            controller.signal.throwIfAborted();
            results.push({ type: "tool_result", tool_use_id: block.id, content: toolResultText(result) });
          }
          messages.push({ role: "user", content: results });
          continue;
        }
        if (response.stop_reason === "max_tokens") throw new Error("Claude's answer exceeded the output limit. Ask a narrower question.");
        const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").trim();
        if (!text) throw new Error("Claude returned no answer.");
        let parsed: AgentResponse;
        try { parsed = parseAgentResponse(text); }
        // A plain-prose final answer is still useful; it just carries no citations.
        catch { parsed = { answer: text.slice(0, 20000), citationIds: [] }; }
        if (parsed.answer.length > 20000) throw new Error("Claude response exceeded the chat limit.");
        return parsed;
      }
    } catch (error) {
      if (request.signal.aborted) throw new Error("Chat cancelled.");
      throw timeoutError ?? error;
    } finally {
      timers.clear();
      unsubscribe?.();
      request.signal.removeEventListener("abort", forward);
      this.controllers.delete(controller);
      this.busy = false;
    }
  }
  async stop(): Promise<void> {
    for (const controller of this.controllers) controller.abort(new Error("Relay Desk is shutting down."));
  }
}
