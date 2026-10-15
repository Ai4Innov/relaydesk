import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Chat, shouldSendChat } from "../src/renderer/Chat";
import type { Snapshot } from "../src/shared/contracts";
import { defaultSettings } from "../src/shared/defaults";

function snapshot(): Snapshot {
  return {
    accounts: [], sources: [], messages: [], drafts: [], attachments: [], events: [], actions: [], jobs: [], approvals: [],
    settings: defaultSettings, models: [], copilot: { status: "disconnected", message: "Sign in with your Copilot subscription." },
    archive: { messages: 0, attachments: 0, indexed: 0, searchMode: "keyword", bytes: 0 }, demo: false,
    chat: { busy: false, conversations: [] },
  };
}
const render = (data: Snapshot) => renderToStaticMarkup(<Chat data={data} run={vi.fn()} navigate={vi.fn()}/>);

describe("chat presentation", () => {
  it.each(["fresh", "partial", "unavailable"] as const)("shows verified freshness separately from model prose (%s)", status => {
    const data = snapshot();
    data.chat = { busy: false, conversations: [{ id: "chat", title: "Latest email", updatedAt: "2026-09-25T14:00:00Z",
      turns: [{ id: "turn", role: "assistant", status: "complete", createdAt: "2026-09-25T14:00:00Z",
        text: "An answer.", citations: [], actions: [], mailFreshness: [{ status, checkedAt: "2026-09-25T14:00:00Z",
          sources: [{ accountId: "a", sourceId: "s", status, downloaded: 2, pending: status === "fresh" ? 0 : 1,
            checkedAt: status === "fresh" ? "2026-09-25T14:00:00Z" : undefined,
            reason: status === "fresh" ? undefined : "Keep the paired browser signed in." }], limitation: "Limited inbox view" }] }] }] };
    const html = render(data);
    expect(html).toContain('aria-label="Inbox freshness"');
    expect(html).toContain(status === "fresh" ? "Inbox refreshed before this answer" : "cached evidence may be stale");
    expect(html).toContain("2 conversations downloaded");
    if (status !== "fresh") expect(html).toContain("Keep the paired browser signed in.");
    expect(html).not.toContain("Confirm action");
  });
  it("starts with honest connection, consent, coverage, and draft-only guidance", () => {
    const html = render(snapshot());
    expect(html).toContain("What can we take off your mind?");
    expect(html).toContain("Connect Copilot");
    expect(html).toContain("Sign in");
    expect(html).toContain("No connected, opted-in sources");
    expect(html).toContain("browser captures may be partial");
    expect(html).toContain("Nothing is sent.");
    expect(html).toContain('aria-label="Chat messages"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Send message" class="chat-send" disabled=""');
  });

  it("shows exact escaped previews, evidence, and explicit action confirmation", () => {
    const data = snapshot();
    data.chat = {
      busy: false, activeConversationId: "conversation", conversations: [{
        id: "conversation", title: "Plan the review", updatedAt: "2026-09-23T08:00:00Z",
        turns: [{
          id: "turn", role: "assistant", createdAt: "2026-09-23T08:00:00Z", status: "complete",
          text: "<img src=x onerror=alert(1)>", citations: [{ id: "evidence", messageId: "message", title: "Review brief", excerpt: "<script>not executed</script>" }],
          actions: [{ id: "action", title: "Create task", description: "A local task.", preview: "task.create\nTitle: <b>Review</b>", status: "pending" }],
        }],
      }],
    };
    const html = render(data);
    expect(html).not.toContain("onerror");
    expect(html).toContain("task.create\nTitle: &lt;b&gt;Review&lt;/b&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("Confirm action");
    expect(html).toContain("Native writes still use their existing approval flow");
    expect(html).toContain("Open original");
    expect(html).toContain("inspect evidence");
  });

  it("uses the authoritative run state for Stop response and shows entitled models only", () => {
    const data = snapshot();
    data.copilot = { status: "ready", message: "Connected" };
    data.models = [{ id: "entitled", name: "My available model" }];
    data.chat!.busy = true;
    const html = render(data);
    expect(html).toContain("Stop response");
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).toContain("My available model");
    expect(html).not.toContain("Connect Copilot");
  });

  it("counts only connected, opted-in accounts with selected sources", () => {
    const data = snapshot();
    data.accounts = [
      { id: "allowed", email: "allowed@example.org", name: "Allowed", provider: "gmail", consent: true, aiEnabled: true, status: "connected" },
      { id: "excluded", email: "private@example.org", name: "Private", provider: "gmail", consent: false, aiEnabled: true, status: "connected" },
    ];
    data.sources = data.accounts.map(account => ({ id: account.id, accountId: account.id, providerId: account.id, name: "Inbox", kind: "mail", selected: true }));
    const html = render(data);
    expect(html).toContain("1 opted-in account · 1 selected source");
    expect(html).toContain("allowed@example.org");
    expect(html).not.toContain("private@example.org");
  });

  it("preserves Shift+Enter and IME composition", () => {
    const key = (shiftKey = false, isComposing = false, keyCode = 13) => ({
      key: "Enter", shiftKey, nativeEvent: { isComposing, keyCode } as KeyboardEvent,
    });
    expect(shouldSendChat(key())).toBe(true);
    expect(shouldSendChat(key(true))).toBe(false);
    expect(shouldSendChat(key(false, true))).toBe(false);
    expect(shouldSendChat(key(false, false, 229))).toBe(false);
    expect(shouldSendChat({ ...key(), key: "a" })).toBe(false);
  });

  it("offers AI access review only for connected browser accounts with selected calendars and AI off", () => {
    const data = snapshot();
    data.accounts = [
      { id: "gated", name: "Gated calendar", email: "calendar@example.org", provider: "gmail", connection: "browser", consent: true, aiEnabled: false, status: "connected" },
      { id: "api", name: "API calendar", email: "api@example.org", provider: "gmail", connection: "api", consent: true, aiEnabled: false, status: "connected" },
      { id: "disconnected", name: "Disconnected", email: "disconnected@example.org", provider: "gmail", connection: "browser", consent: true, aiEnabled: false, status: "disconnected" },
      { id: "allowed", name: "AI allowed", email: "allowed@example.org", provider: "gmail", connection: "browser", consent: true, aiEnabled: true, status: "connected" },
      { id: "unselected", name: "Unselected", email: "unselected@example.org", provider: "gmail", connection: "browser", consent: true, aiEnabled: false, status: "connected" },
    ];
    data.sources = data.accounts.map(account => ({ id: account.id, accountId: account.id, providerId: account.id, name: "Calendar", kind: "calendar", selected: account.id !== "unselected" }));
    const run = vi.fn();
    const html = renderToStaticMarkup(<Chat data={data} run={run} navigate={vi.fn()}/>);
    expect(html).toContain('aria-label="Calendar access for calendar@example.org"');
    expect(html.match(/class="chat-calendar-access"/g)).toHaveLength(1);
    expect(html).toContain("Review AI access");
    expect(html).not.toContain("Enable AI for this account");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["needs-user", "uncertain"] as const)("shows a distinct %s browser outcome without offering another confirmation", status => {
    const data = snapshot();
    data.chat = {
      busy: false, activeConversationId: "conversation", conversations: [{
        id: "conversation", title: "Reschedule", updatedAt: "2026-09-23T08:00:00Z",
        turns: [{
          id: "turn", role: "assistant", createdAt: "2026-09-23T08:00:00Z", status: "complete", text: "", citations: [],
          actions: [{ id: "action", title: "Move calendar event", description: "Browser calendar change", preview: "{}", status, result: "<browser result> No verified save." }],
        }],
      }],
    };
    const html = render(data);
    expect(html).not.toContain("Confirm action");
    expect(html).not.toContain("chat-action-completed");
    expect(html).toContain("&lt;browser result&gt; No verified save.");
    expect(html).toContain(`chat-action-${status}`);
    if (status === "uncertain") {
      expect(html).toContain("Save not verified");
      expect(html).toContain("Save attempted · outcome unknown");
      expect(html).toContain("Do not retry this action.");
      expect(html).toContain("lucide-triangle-alert");
    } else {
      expect(html).toContain("Browser review required");
      expect(html).toContain("Continue in the original browser");
      expect(html).toContain("Relay Desk has not confirmed a save.");
      expect(html).toContain("lucide-circle-alert");
    }
  });
});
