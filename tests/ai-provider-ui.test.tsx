import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/renderer/SettingsPage";
import { SetupGuide, setupSteps } from "../src/renderer/SetupGuide";
import type { AiProviderId, Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

function snapshot(provider: AiProviderId, hasKey = false): Snapshot {
  return {
    accounts: [], sources: [], messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
    settings: { ...defaultSettings, model: "", aiProvider: provider }, models: [], copilot: { status: "disconnected", message: "" },
    archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false,
    chat: { busy: false, conversations: [] },
    ai: { provider, providers: [
      { id: "copilot", name: "GitHub Copilot", auth: "subscription", status: "ready", message: "" },
      { id: "claude", name: "Claude", auth: "api-key", status: "disconnected", message: "Add your key.", hasKey },
      { id: "codex", name: "OpenAI Codex", auth: "subscription", status: "disconnected", message: "" }
    ] }
  };
}
const settings = (data: Snapshot) => {
  // Render the AI tab directly: SettingsPage keeps the active tab in state, so swap the default for this render.
  const html = renderToStaticMarkup(<SettingsPage data={data} run={vi.fn()} busy={false}/>);
  return html;
};

describe("AI provider UI", () => {
  it("names the AI tab and lists all three providers", () => {
    const html = settings(snapshot("copilot"));
    expect(html).toContain("AI &amp; assistant");
  });

  it("guides Claude users to their own API key without Claude Code branding", () => {
    const data = snapshot("claude");
    const steps = setupSteps(data);
    const html = renderToStaticMarkup(<SetupGuide data={data} guide={{ steps, visible: true, dismiss: vi.fn() }} run={vi.fn()} openSettings={vi.fn()} ask={vi.fn()}/>);
    expect(html).toContain("Add your Anthropic API key");
    expect(html).toContain("Connect Claude");
    expect(html).toContain("Add API key");
    expect(html).not.toContain("Sign in to");
    expect(html).not.toContain("Claude Code");
  });

  it("guides Codex users to codex login with no API key", () => {
    const data = snapshot("codex");
    const steps = setupSteps(data);
    const html = renderToStaticMarkup(<SetupGuide data={data} guide={{ steps, visible: true, dismiss: vi.fn() }} run={vi.fn()} openSettings={vi.fn()} ask={vi.fn()}/>);
    expect(html).toContain("codex login");
    expect(html).toContain("No API key");
    expect(html).toContain("Sign in to Codex");
  });
});
