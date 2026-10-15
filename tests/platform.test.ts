import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import { absoluteFolder, insidePath, openTerminal, platformProfile, terminalLaunchers } from "../src/main/platform";
import { chatSessionConfig, subscriptionClientOptions } from "../src/main/copilot";
import { MemorySessionFs } from "../src/main/copilot/memory-fs";

const windows = platformProfile("win32"), mac = platformProfile("darwin"), linux = platformProfile("linux");

describe("platform profiles", () => {
  it("maps every desktop OS to its own conventions", () => {
    expect([windows.id, mac.id, linux.id]).toEqual(["win32", "darwin", "linux"]);
    expect(platformProfile("freebsd").id).toBe("linux");
    expect(windows.sessionConventions).toBe("windows");
    expect(mac.sessionConventions).toBe("posix");
    expect(windows.shell.tools).toContain("powershell");
    expect(linux.shell.tools).toEqual(["bash", "read_bash", "write_bash", "stop_bash", "list_bash"]);
  });

  it("confines Windows paths case-insensitively and POSIX paths exactly", () => {
    expect(insidePath("C:\\Users\\A\\Relay", "c:\\users\\a\\relay\\report.docx", windows)).toBe(true);
    expect(insidePath("C:\\Users\\A\\Relay", "C:\\Users\\A\\Relay2\\x", windows)).toBe(false);
    expect(insidePath("C:\\Users\\A\\Relay", "C:\\Users\\A\\Relay\\..\\secret", windows)).toBe(false);
    expect(insidePath("C:\\", "C:\\anything", windows)).toBe(true);
    expect(insidePath("/home/a/Relay", "/home/a/Relay/report.docx", linux)).toBe(true);
    expect(insidePath("/home/a/Relay", "/home/a/relay/report.docx", linux)).toBe(false);
    expect(insidePath("/home/a/Relay", "/home/a/Relay-old/x", mac)).toBe(false);
    expect(insidePath("/home/a/Relay", "/home/a/Relay/../.ssh/id_ed25519", mac)).toBe(false);
    expect(insidePath("/", "/etc/passwd", linux)).toBe(true);
  });

  it("validates absolute workspace folders per OS", () => {
    expect(absoluteFolder("C:\\Users\\A\\Relay", windows)).toBe(true);
    expect(absoluteFolder("/Users/a/Relay", windows)).toBe(false);
    expect(absoluteFolder("/Users/a/Relay", mac)).toBe(true);
    expect(absoluteFolder("relative/Relay", linux)).toBe(false);
    expect(absoluteFolder("C:\\Users\\A", linux)).toBe(false);
  });
});

describe("Copilot runtime per OS", () => {
  it.each([windows, mac, linux])("uses $name session conventions and its native shell tools", profile => {
    const options = subscriptionClientOptions(profile.path.join(profile.sessionRoot, "..", "work"), {}, profile);
    expect(options.sessionFs).toMatchObject({ sessionStatePath: profile.sessionRoot, conventions: profile.sessionConventions });
    const workspace = { directory: profile.id === "win32" ? "C:\\Relay" : "/Users/a/Relay", shell: true, web: false,
      permission: async () => "deny" as const, readApproved: () => false };
    const config = chatSessionConfig("model", workspace.directory, new MemorySessionFs(profile), [], workspace, profile);
    for (const tool of profile.shell.tools) expect(config.availableTools).toContain(`builtin:${tool}`);
    const other = profile.id === "win32" ? "builtin:bash" : "builtin:powershell";
    expect(config.availableTools).not.toContain(other);
    expect(String((config.systemMessage as { content: string }).content)).toContain(profile.name);
    const noShell = chatSessionConfig("model", workspace.directory, new MemorySessionFs(profile), [], { ...workspace, shell: false }, profile);
    for (const tool of profile.shell.tools) expect(noShell.availableTools).not.toContain(`builtin:${tool}`);
  });

  it.each([windows, mac, linux])("keeps $name session state in memory under its virtual root", async profile => {
    const fs = new MemorySessionFs(profile);
    const nested = profile.path.join(profile.sessionRoot, "files", "plan.md");
    await fs.writeFile(nested, "plan");
    expect(await fs.readdir(profile.path.join(profile.sessionRoot, "files"))).toEqual(["plan.md"]);
    await fs.rename(profile.path.join(profile.sessionRoot, "files"), profile.path.join(profile.sessionRoot, "moved"));
    expect(await fs.readFile(profile.path.join(profile.sessionRoot, "moved", "plan.md"))).toBe("plan");
    await fs.rm(profile.path.join(profile.sessionRoot, "moved"), true, false);
    expect(await fs.exists(profile.path.join(profile.sessionRoot, "moved", "plan.md"))).toBe(false);
  });
});

describe("terminal launch for Copilot sign-in", () => {
  it("uses the native terminal of each OS and rejects unsafe programs", () => {
    expect(terminalLaunchers("copilot", windows)[0].command).toBe("cmd.exe");
    expect(terminalLaunchers("copilot", mac)[0]).toMatchObject({ command: "osascript" });
    expect(terminalLaunchers("copilot", linux).map(item => item.command)).toContain("gnome-terminal");
    expect(() => terminalLaunchers("copilot; rm -rf ~", linux)).toThrow();
    expect(terminalLaunchers("C:\\Program Files\\codex\\codex.exe", windows, ["login"])[0].args).toEqual(["/c", "start", '""', "C:\\Program Files\\codex\\codex.exe", "login"]);
    expect(terminalLaunchers("/usr/local/bin/codex", linux, ["login"])[0].args).toEqual(["-e", "/usr/local/bin/codex", "login"]);
    expect(() => terminalLaunchers("C:\\x\\codex.exe & calc", windows, ["login"])).toThrow();
    expect(() => terminalLaunchers("/usr/bin/codex", mac, ["login; rm"])).toThrow();
    expect(() => terminalLaunchers("relative/codex", linux, ["login"])).toThrow();
  });

  function fakeSpawn(behaviour: Record<string, "missing" | "spawn" | "exit0" | "exit1">) {
    const calls: string[] = [];
    const spawner = vi.fn((command: string) => {
      calls.push(command);
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setImmediate(() => {
        const mode = behaviour[command] ?? "missing";
        if (mode === "missing") child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        else if (mode === "spawn") child.emit("spawn");
        else child.emit("exit", mode === "exit0" ? 0 : 1);
      });
      return child;
    }) as unknown as typeof spawn;
    return { spawner, calls };
  }

  it("falls back across Linux terminals until one starts", async () => {
    const { spawner, calls } = fakeSpawn({ konsole: "spawn" });
    await openTerminal("copilot", linux, spawner);
    expect(calls).toEqual(["x-terminal-emulator", "gnome-terminal", "konsole"]);
  });

  it("reports a clear error when no terminal is available", async () => {
    const { spawner } = fakeSpawn({ osascript: "exit1" });
    await expect(openTerminal("copilot", mac, spawner)).rejects.toThrow(/Run "copilot" in a terminal/);
  });

  it("waits for cmd.exe to open the Windows terminal", async () => {
    const { spawner, calls } = fakeSpawn({ "cmd.exe": "exit0" });
    await openTerminal("copilot", windows, spawner);
    expect(calls).toEqual(["cmd.exe"]);
  });
});
