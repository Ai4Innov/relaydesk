import { describe, expect, it, vi } from "vitest";
import type { Vault } from "../src/main/storage/vault";
import { defaultSettings } from "../src/shared/defaults";
import { ACCOUNT_LINK_ERROR } from "../src/shared/browser-account-link";

vi.mock("../src/main/storage/vault", () => ({ Vault: class {} }));
vi.mock("../src/main/retrieval", () => ({ Retrieval: class {} }));
vi.mock("../src/main/connectors", () => ({ ConnectorHub: class {} }));
vi.mock("../src/main/attachments", () => ({ AttachmentProcessor: class {} }));
vi.mock("../src/main/copilot", () => ({ CopilotAdapter: class {} }));
vi.mock("../src/main/browser/bridge", () => ({ BrowserBridge: class {
  constructor() { throw new Error("Link opening must not construct a bridge."); }
} }));
import { RelayService } from "../src/main/service";

function fixture() {
  const vault = {
    get: vi.fn((collection: string): unknown => collection === "settings" ? defaultSettings : undefined),
    all: vi.fn(() => []), put: vi.fn()
  };
  const host = {
    changed: vi.fn(), openExternal: vi.fn().mockResolvedValue(undefined), copy: vi.fn(),
    loginCopilot: vi.fn(), backupPath: vi.fn(), restorePath: vi.fn(), settingsChanged: vi.fn(), notify: vi.fn()
  };
  const service = new RelayService(vault as unknown as Vault, ".", host);
  vi.clearAllMocks();
  return { service, vault, host };
}

describe("desktop account link service (offline, no bridge or providers)", () => {
  it("opens WhatsApp Web without credentials, ingestion consent or silent AI changes", async () => {
    const { service, vault, host } = fixture();
    await service.command({ type: "browser.open", kind: "whatsapp" });
    expect(host.openExternal).toHaveBeenCalledExactlyOnceWith("https://web.whatsapp.com/");
    expect(vault.get).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    vault.get.mockReturnValueOnce({ id: "browser:whatsapp:+33612345678", provider: "whatsapp",
      connection: "browser", consent: false, aiEnabled: false, status: "connected" });
    const result = await service.command({ type: "browser.open", kind: "whatsapp", accountId: "browser:whatsapp:+33612345678" });
    expect(result.message).toContain("does not enable ingestion or AI");
    expect(host.openExternal).toHaveBeenLastCalledWith("https://web.whatsapp.com/");
    expect(vault.put).not.toHaveBeenCalled();
    vault.get.mockReturnValueOnce({ provider: "gmail", connection: "browser" });
    await expect(service.command({ type: "browser.open", kind: "whatsapp", accountId: "google" })).rejects.toThrow("WhatsApp");
    expect(host.openExternal).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["https://mail.google.com/mail/u/2/?compose=synthetic#inbox/synthetic", "https://mail.google.com/mail/u/2/#inbox"],
    ["https://calendar.google.com/calendar/r/eventedit/synthetic?authuser=test%40example.com&eid=synthetic", "https://calendar.google.com/calendar/?authuser=test%40example.com"]
  ])("opens only a canonical provider root", async (url, expected) => {
    const { service, vault, host } = fixture();
    const result = await service.command({ type: "browser.open-link", url });
    expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(expected);
    expect(result.message).toContain("default browser, not an account connection");
    expect(result.message).toContain("verify the signed-in Google header");
    expect(vault.get).not.toHaveBeenCalled();
    expect(vault.all).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    expect(host.changed).not.toHaveBeenCalled();
    expect(host.settingsChanged).not.toHaveBeenCalled();
    expect(host.notify).not.toHaveBeenCalled();
  });
  it("validates again even when called without IPC parsing", async () => {
    const { service, host, vault } = fixture();
    await expect(service.command({ type: "browser.open-link", url: "https://example.com/mail/" })).rejects.toThrow(ACCOUNT_LINK_ERROR);
    expect(host.openExternal).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
  });
  it("propagates opener failure rather than reporting connection or changing consent", async () => {
    const { service, host, vault } = fixture();
    host.openExternal.mockRejectedValueOnce(new Error("Default browser could not open."));
    await expect(service.command({ type: "browser.open-link", url: "https://mail.google.com/mail/u/0/" }))
      .rejects.toThrow("Default browser could not open.");
    expect(vault.put).not.toHaveBeenCalled();
    expect(host.changed).not.toHaveBeenCalled();
  });
});
