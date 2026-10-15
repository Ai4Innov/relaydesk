import type { AiProviderId, AiProviderInfo, Citation, ModelInfo, Snapshot } from "../../shared/contracts";
import type { AgentResponse, AiProvider, ChatAgentRequest } from "./agent";

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ["copilot", "claude", "codex"];

/** Routes AI work to the provider selected in Settings; each provider keeps its own connection and model list. */
export class AiRouter {
  constructor(readonly providers: Record<AiProviderId, AiProvider>, private selected: () => AiProviderId,
    private hasKey: (id: AiProviderId) => boolean = () => false) {}

  get active(): AiProvider { return this.providers[this.selected()] ?? this.providers.copilot; }
  get status(): Snapshot["copilot"] { return this.active.status; }
  get models(): ModelInfo[] { return this.active.models; }
  info(): AiProviderInfo[] {
    return AI_PROVIDER_IDS.map(id => {
      const provider = this.providers[id];
      return { id, name: provider.name, auth: provider.auth, status: provider.status.status, message: provider.status.message,
        ...(provider.auth === "api-key" ? { hasKey: this.hasKey(id) } : {}) };
    });
  }
  connect(): Promise<void> { return this.active.connect(); }
  generate(task: string, citations: Citation[], model: string): Promise<AgentResponse> { return this.active.generate(task, citations, model); }
  chat(request: ChatAgentRequest): Promise<AgentResponse> { return this.active.chat(request); }
  async stop(): Promise<void> {
    const results = await Promise.allSettled(AI_PROVIDER_IDS.map(id => this.providers[id].stop()));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
}
