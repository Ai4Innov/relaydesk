import type { AiProviderId, Snapshot } from "../shared/contracts";

export const AI_SHORT_NAMES: Record<AiProviderId, string> = { copilot: "Copilot", claude: "Claude", codex: "Codex" };

/** The active AI provider and its short UI name ("Copilot", "Claude", "Codex"). */
export function activeAi(data: Pick<Snapshot, "ai">): { id: AiProviderId; name: string } {
  const id = data.ai?.provider ?? "copilot";
  return { id, name: AI_SHORT_NAMES[id] };
}

/** One-line description of what the provider needs: subscription sign-in or the user's own API key. */
export const AI_PROVIDER_HELP: Record<AiProviderId, { title: string; detail: string; billing: string }> = {
  copilot: { title: "GitHub Copilot", detail: "Uses your GitHub Copilot subscription via the Copilot CLI sign-in. No API key.",
    billing: "Counts against your Copilot plan's premium requests." },
  claude: { title: "Claude (Anthropic API)", detail: "Uses Claude models with your own Anthropic API key, stored encrypted on this device. Anthropic does not allow third-party apps to use Claude.ai subscription sign-in.",
    billing: "Billed per token to your Anthropic Console account." },
  codex: { title: "OpenAI Codex", detail: "Uses your installed Codex CLI and its ChatGPT sign-in (codex login). No API key.",
    billing: "Counts against your ChatGPT plan's Codex usage limits." }
};
