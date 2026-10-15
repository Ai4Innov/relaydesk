import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function setup(failStatus = false, lastReason = "none") {
  const elements = new Map<string, { textContent: string; disabled: boolean; value: string; listeners: Map<string, () => Promise<void>>;
    addEventListener(type: string, work: () => Promise<void>): void }>();
  const ids = ["status", "pair-state", "tab-state", "tab-reason", "code", "pair-form", "cleanup-agent-tabs", "refresh-tab-state"];
  for (const id of ids) elements.set(id, {
    textContent: "", disabled: false, value: "", listeners: new Map(),
    addEventListener(type, work) { this.listeners.set(type, work); },
  });
  const sendMessage = vi.fn(async (message: { type: string }) => {
    if (message.type === "state") return { ok: true, value: { paired: true } };
    if (message.type === "tab-management") return failStatus ? { ok: false, error: "Tab journal unavailable" }
      : { ok: true, value: { mailOwned: 2, mailIdle: 1, viewOwned: 3, limit: 30,
        debug: { protected: 1, loading: 0, busy: 0, statusUnavailable: 0, lastReason } } };
    if (message.type === "cleanup-agent-tabs") return { ok: true, value: { closed: 1, retained: 1, message: "Closed 1 idle agent tab. Active tabs were retained." } };
    return { ok: true, value: { status: "Connected" } };
  });
  runInNewContext(readFileSync(resolve("browser-extension", "popup.js"), "utf8"), {
    document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [...elements.values()] },
    chrome: { runtime: { sendMessage } },
  });
  return { elements, sendMessage };
}

describe("companion tab controls", () => {
  it("shows bounded ownership counts and explicitly requests safe idle cleanup", async () => {
    const { elements, sendMessage } = setup();
    await vi.waitFor(() => expect(elements.get("tab-state")!.textContent).toContain("Agent tabs: 5 / 30"));
    expect(elements.get("tab-state")!.textContent).toContain("Mail workers: 2 (idle: 1)");
    await elements.get("cleanup-agent-tabs")!.listeners.get("click")!();
    expect(sendMessage).toHaveBeenCalledWith({ type: "cleanup-agent-tabs" });
    expect(elements.get("status")!.textContent).toContain("Closed 1 idle agent tab");
    expect(elements.get("cleanup-agent-tabs")!.disabled).toBe(false);
    await elements.get("refresh-tab-state")!.listeners.get("click")!();
    expect(elements.get("status")!.textContent).toBe("Agent tab status refreshed.");
  });
  it("surfaces ownership status errors without pretending there are zero tabs", async () => {
    const { elements } = setup(true);
    await vi.waitFor(() => expect(elements.get("tab-state")!.textContent).toBe("Tab journal unavailable"));
    expect(elements.get("pair-state")!.textContent).toContain("Paired");
  });
  it("explains capacity limits without implying permission to close protected tabs", async () => {
    const { elements } = setup(false, "readerCapacity");
    await vi.waitFor(() => expect(elements.get("tab-reason")!.textContent).toContain("Last recorded issue: Reader capacity reached"));
    expect(elements.get("tab-reason")!.textContent).toContain("protected tabs require your review");
    expect(elements.get("tab-reason")!.textContent).toContain("Protected: 1");
  });
});
