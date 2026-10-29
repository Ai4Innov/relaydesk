import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { ChatService } from "../src/main/chat";
import { host } from "../src/main/platform";
import type { ChatAgentRequest } from "../src/main/copilot";
import type { Collection, Snapshot } from "../src/shared/contracts";
import { chatFileOpenable } from "../src/shared/chat";
import { defaultSettings } from "../src/shared/defaults";
import type { Vault } from "../src/main/storage/vault";

class MemoryVault {
  records = new Map<string, unknown>();
  get<T>(collection: Collection, id: string): T | undefined {
    const item = this.records.get(`${collection}|${id}`);
    return item === undefined ? undefined : structuredClone(item) as T;
  }
  put(collection: Collection, id: string, item: unknown): void { this.records.set(`${collection}|${id}`, structuredClone(item)); }
  all<T>(collection: Collection): T[] {
    return [...this.records].filter(([key]) => key.startsWith(`${collection}|`)).map(([, value]) => structuredClone(value) as T);
  }
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(mode: "auto" | "ask" = "ask") {
  const directory = mkdtempSync(join(tmpdir(), "relay-chat-security-"));
  directories.push(directory);
  const settings = { ...defaultSettings, model: "user-selected", assistantTools: true, assistantShell: mode, assistantWeb: mode };
  const hooks = {
    changed: vi.fn(), settings: () => settings, workspace: () => ({ tasks: [], settings } as unknown as Snapshot),
    search: vi.fn(async () => []), execute: vi.fn(async () => ({})),
    refreshMail: vi.fn(), workspaceDirectory: () => directory,
    openPath: vi.fn(async (_path: string, _reveal: boolean) => undefined),
    generate: vi.fn(async (_request: ChatAgentRequest) => ({ answer: "Done.", citationIds: [] as string[] }))
  };
  const chat = new ChatService(new MemoryVault() as unknown as Vault, hooks as never);
  const send = async (text: string, conversationId?: string) => {
    const result = await chat.command({ type: "chat.send", text, conversationId, mailRefresh: "local" });
    await chat.settled(); return result.conversationId!;
  };
  const last = () => chat.snapshot().conversations[0].turns.at(-1)!;
  return { directory, hooks, chat, send, last };
}

describe("chat workspace security", () => {
  it("only allows launching passive document formats", () => {
    for (const name of ["report.docx", "Q3.XLSX", "deck.pptx", "notes.md", "data.csv", "scan.pdf", "image.png"])
      expect(chatFileOpenable(name)).toBe(true);
    for (const name of ["summary.hta", "run.bat", "x.cmd", "a.vbs", "b.js", "c.wsf", "d.url", "e.lnk", "f.ps1", "g.exe",
      "h.library-ms", "i.settingcontent-ms", "j.docm", "k.html", "l.svg", "report.docx.hta", "noextension", "report.docx:evil.hta"])
      expect(chatFileOpenable(name)).toBe(false);
  });

  it("never launches a model-written script file but still allows showing it in its folder", async () => {
    const f = fixture();
    f.hooks.generate.mockImplementation(async () => {
      writeFileSync(join(f.directory, "Q3-summary.hta"), "<script>synthetic</script>");
      writeFileSync(join(f.directory, "Q3-summary.docx"), "synthetic");
      return { answer: "Saved.", citationIds: [] };
    });
    const conversationId = await f.send("Summarize this email and save it");
    const turn = f.last();
    const script = turn.files!.find(file => file.name === "Q3-summary.hta")!;
    const document = turn.files!.find(file => file.name === "Q3-summary.docx")!;
    await expect(f.chat.command({ type: "chat.openFile", conversationId, turnId: turn.id, path: script.path }))
      .rejects.toThrow(/can run code/);
    expect(f.hooks.openPath).not.toHaveBeenCalled();
    await f.chat.command({ type: "chat.openFile", conversationId, turnId: turn.id, path: script.path, reveal: true });
    expect(f.hooks.openPath).toHaveBeenLastCalledWith(script.path, true);
    await f.chat.command({ type: "chat.openFile", conversationId, turnId: turn.id, path: document.path });
    expect(f.hooks.openPath).toHaveBeenLastCalledWith(document.path, false);
  });

  it("does not carry a shell approval over to the next request in the same conversation", async () => {
    const f = fixture();
    const shell = { kind: "shell", fullCommandText: "Get-Date", intention: "Check the date" } as unknown as PermissionRequest;
    let decision: Promise<"approve" | "deny"> | undefined;
    f.hooks.generate.mockImplementationOnce(async request => {
      decision = request.workspace!.permission(shell);
      await vi.waitFor(() => expect(f.chat.snapshot().conversations[0].turns.at(-1)!.permissions?.[0]?.status).toBe("pending"));
      const conversation = f.chat.snapshot().conversations[0];
      const turn = conversation.turns.at(-1)!;
      await f.chat.command({ type: "chat.permission", conversationId: conversation.id, turnId: turn.id, requestId: turn.permissions![0].id, decision: "chat" });
      expect(await decision).toBe("approve");
      // Within the same response the grant applies without asking again.
      expect(await request.workspace!.permission(shell)).toBe("approve");
      return { answer: "It is today.", citationIds: [] };
    });
    const conversationId = await f.send("What is the date?");
    expect(f.last().permissions?.[0].status).toBe("approved-chat");

    let nextPending = false;
    f.hooks.generate.mockImplementationOnce(async request => {
      const next = request.workspace!.permission(shell);
      await vi.waitFor(() => expect(f.chat.snapshot().conversations[0].turns.at(-1)!.permissions?.[0]?.status).toBe("pending"));
      nextPending = true;
      const turn = f.chat.snapshot().conversations[0].turns.at(-1)!;
      await f.chat.command({ type: "chat.permission", conversationId, turnId: turn.id, requestId: turn.permissions![0].id, decision: "deny" });
      expect(await next).toBe("deny");
      return { answer: "Skipped.", citationIds: [] };
    });
    await f.send("Summarize the newest email", conversationId);
    expect(nextPending).toBe(true);
    expect(f.chat.snapshot().conversations[0].grants ?? []).toEqual([]);
  });
it("runs ordinary actions automatically but stops sensitive ones for an individual decision", async () => {
    const f = fixture("auto");
    const safe = { kind: "shell", fullCommandText: "Get-ChildItem | Select-Object Name" } as unknown as PermissionRequest;
    const destructive = { kind: "shell", fullCommandText: host.id === "win32" ? "Remove-Item -Recurse C:\\Windows\\System32" : "rm -rf /usr/lib" } as unknown as PermissionRequest;
    const page = { kind: "url", url: "https://example.org/docs" } as unknown as PermissionRequest;
    const internal = { kind: "url", url: "http://127.0.0.1:9339/json" } as unknown as PermissionRequest;
    f.hooks.generate.mockImplementationOnce(async request => {
      expect(await request.workspace!.permission(safe)).toBe("approve");
      expect(await request.workspace!.permission(page)).toBe("approve");
      const ordinaryFile = join(tmpdir(), "relay-outside", "notes.md");
      expect(await request.workspace!.permission({ kind: "write", fileName: ordinaryFile } as unknown as PermissionRequest)).toBe("approve");
      expect(request.workspace!.writeApproved?.(ordinaryFile)).toBe(true);
      expect(request.workspace!.writeApproved?.(join(tmpdir(), "relay-outside", "other.md"))).toBe(false);
      const pending = request.workspace!.permission(destructive);
      await vi.waitFor(() => expect(f.chat.snapshot().conversations[0].turns.at(-1)!.permissions?.some(item => item.status === "pending")).toBe(true));
      const conversation = f.chat.snapshot().conversations[0];
      const turn = conversation.turns.at(-1)!;
      const card = turn.permissions!.find(item => item.status === "pending")!;
      expect(card.risk).toMatch(/deletes or replaces files where it is a system/);
      expect(card.title).toMatch(/^Sensitive:/);
      // "Allow for this response" never becomes a blanket grant for sensitive actions.
      await f.chat.command({ type: "chat.permission", conversationId: conversation.id, turnId: turn.id, requestId: card.id, decision: "chat" });
      expect(await pending).toBe("approve");
      const again = request.workspace!.permission(destructive);
      const internalFetch = request.workspace!.permission(internal);
      await vi.waitFor(() => expect(f.chat.snapshot().conversations[0].turns.at(-1)!.permissions?.filter(item => item.status === "pending")).toHaveLength(2));
      for (const item of f.chat.snapshot().conversations[0].turns.at(-1)!.permissions!.filter(item => item.status === "pending"))
        await f.chat.command({ type: "chat.permission", conversationId: conversation.id, turnId: turn.id, requestId: item.id, decision: "deny" });
      expect(await again).toBe("deny");
      expect(await internalFetch).toBe("deny");
      return { answer: "Done.", citationIds: [] };
    });
    await f.send("Tidy my project");
    const permissions = f.last().permissions!;
    expect(permissions.filter(item => item.status === "auto").map(item => item.detail)).toEqual(["Get-ChildItem | Select-Object Name", "https://example.org/docs", join(tmpdir(), "relay-outside", "notes.md")]);
    expect(permissions.find(item => item.risk)?.status).toBe("approved");
    expect(f.chat.snapshot().conversations[0].grants ?? []).toEqual([]);
  });
  it("runs every action, destructive ones included, without asking when the user turns on full access", async () => {
    const f = fixture("ask");
    Object.assign(f.hooks.settings(), { bypassSafety: true });
    const destructive = { kind: "shell", fullCommandText: host.id === "win32" ? "Remove-Item -Recurse C:\\Windows\\System32" : "rm -rf /usr/lib" } as unknown as PermissionRequest;
    const outside = join(tmpdir(), "relay-outside", "plan.md");
    f.hooks.generate.mockImplementationOnce(async request => {
      expect(await request.workspace!.permission(destructive)).toBe("approve");
      expect(await request.workspace!.permission({ kind: "url", url: "http://127.0.0.1:9339/json" } as unknown as PermissionRequest)).toBe("approve");
      expect(await request.workspace!.permission({ kind: "write", fileName: outside } as unknown as PermissionRequest)).toBe("approve");
      expect(request.workspace!.writeApproved?.(outside)).toBe(true);
      return { answer: "Done.", citationIds: [] };
    });
    await f.send("Clean everything");
    const permissions = f.last().permissions!;
    expect(permissions.map(item => item.status)).toEqual(["auto", "auto", "auto"]);
    expect(permissions[0].title).toMatch(/full access/);
  });
});