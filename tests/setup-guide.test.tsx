import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SetupGuide, setupSteps } from "../src/renderer/SetupGuide";
import { Chat } from "../src/renderer/Chat";
import type { Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

function snapshot(): Snapshot {
  return {
    accounts: [], sources: [], messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
    settings: { ...defaultSettings, model: "" }, models: [], copilot: { status: "disconnected", message: "" },
    archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false,
    chat: { busy: false, conversations: [] },
  };
}
const render = (data: Snapshot) => {
  const steps = setupSteps(data);
  return renderToStaticMarkup(<SetupGuide data={data} guide={{ steps, visible: steps.some(step => !step.done), dismiss: vi.fn() }} run={vi.fn()} openSettings={vi.fn()} ask={vi.fn()}/>);
};
const done = (data: Snapshot) => setupSteps(data).filter(step => step.done).map(step => step.id);

describe("getting-started guide", () => {
  it("starts at the Copilot step with sign-in actions and an accessible progress bar", () => {
    const html = render(snapshot());
    expect(html).toContain("GETTING STARTED · 0 OF 5");
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Connect Copilot");
    expect(html).toContain("Sign in to Copilot");
    expect(html).toContain("No API key");
  });

  it("leads the empty chat with the guide instead of a duplicate connect banner", () => {
    const html = renderToStaticMarkup(<Chat data={snapshot()} run={vi.fn()} navigate={vi.fn()}/>);
    expect(html).toContain('aria-label="Getting started"');
    expect(html).not.toContain("Bring your Copilot subscription.");
  });

  it("derives progress from real state and ignores demo accounts", () => {
    const data = snapshot();
    data.copilot.status = "ready";
    data.models = [{ id: "gpt-5.4", name: "GPT-5.4" }] as Snapshot["models"];
    data.settings.model = "gpt-5.4";
    data.accounts = [{ id: "demo", provider: "gmail", name: "Demo", email: "demo@example.com", status: "connected", demo: true, aiEnabled: true }] as Snapshot["accounts"];
    data.sources = [{ id: "s", accountId: "demo", name: "Inbox", selected: true }] as Snapshot["sources"];
    expect(done(data)).toEqual(["copilot", "model"]);
    expect(render(data)).toContain("Connect an inbox");

    data.accounts = [{ ...data.accounts[0], id: "real", demo: false, aiEnabled: false }];
    data.sources = [{ ...data.sources[0], accountId: "real" }];
    expect(done(data)).toEqual(["copilot", "model", "inbox"]);
    expect(render(data)).toContain("Choose AI sources");
  });

  it("disappears once every step is complete", () => {
    const data = snapshot();
    data.copilot.status = "ready";
    data.models = [{ id: "m", name: "M" }] as Snapshot["models"];
    data.settings.model = "m";
    data.accounts = [{ id: "a", provider: "gmail", name: "A", email: "a@example.com", status: "connected", aiEnabled: true }] as Snapshot["accounts"];
    data.sources = [{ id: "s", accountId: "a", name: "Inbox", selected: true }] as Snapshot["sources"];
    data.chat = { busy: false, conversations: [{ id: "c", title: "Hi", updatedAt: "2026-09-25T14:00:00Z",
      turns: [{ id: "t", role: "user", status: "complete", createdAt: "2026-09-25T14:00:00Z", text: "Hi", citations: [], actions: [] }] }] } as Snapshot["chat"];
    expect(render(data)).toBe("");
  });
});
