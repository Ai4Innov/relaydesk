import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";

export type HostPlatform = "win32" | "darwin" | "linux";

export interface PlatformProfile {
  id: HostPlatform;
  /** Human name used in UI text. */
  name: "Windows" | "macOS" | "Linux";
  path: typeof win32 | typeof posix;
  /** NTFS is case-insensitive; macOS/Linux comparisons stay exact so a sibling folder differing in case is never trusted. */
  caseInsensitive: boolean;
  /** Virtual root for in-memory Copilot session state; never touches the real disk. */
  sessionRoot: string;
  sessionConventions: "windows" | "posix";
  shell: { name: "PowerShell" | "bash"; tools: readonly string[]; hint: string };
  credentialStore: string;
}

const WINDOWS: PlatformProfile = {
  id: "win32", name: "Windows", path: win32, caseInsensitive: true,
  sessionRoot: "C:\\relay-session", sessionConventions: "windows",
  shell: { name: "PowerShell", tools: ["powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell"],
    hint: "powershell (Windows PowerShell 5: no && or ||)" },
  credentialStore: "Windows protected storage (DPAPI)"
};
const POSIX_SHELL = { name: "bash", tools: ["bash", "read_bash", "write_bash", "stop_bash", "list_bash"], hint: "bash" } as const;
const MACOS: PlatformProfile = {
  id: "darwin", name: "macOS", path: posix, caseInsensitive: false,
  sessionRoot: "/relay-session", sessionConventions: "posix", shell: POSIX_SHELL, credentialStore: "the macOS Keychain"
};
const LINUX: PlatformProfile = { ...MACOS, id: "linux", name: "Linux", credentialStore: "the desktop keyring (Secret Service or KWallet)" };

export function platformProfile(platform: NodeJS.Platform = process.platform): PlatformProfile {
  return platform === "win32" ? WINDOWS : platform === "darwin" ? MACOS : LINUX;
}

export const host = platformProfile();

/** True when `path` is `root` or a descendant of it, using the platform's separator and case rules. */
export function insidePath(root: string, path: string, profile: PlatformProfile = host): boolean {
  const fold = (value: string) => profile.caseInsensitive ? value.toLowerCase() : value;
  const base = fold(profile.path.resolve(root));
  const target = fold(profile.path.resolve(path));
  if (target === base) return true;
  return target.startsWith(base.endsWith(profile.path.sep) ? base : base + profile.path.sep);
}

/** Validates a user-chosen absolute folder for the current OS. */
export function absoluteFolder(value: string, profile: PlatformProfile = host): boolean {
  return profile.id === "win32" ? /^[A-Za-z]:\\/.test(value) : value.startsWith("/") && !value.includes("\0");
}

export interface TerminalLaunch { command: string; args: string[] }

/** Opens a visible terminal running `program` (a PATH name or absolute executable) with simple arguments, trying each launcher until one starts. */
export async function openTerminal(program: string, profile: PlatformProfile = host,
  spawner: typeof spawn = spawn, args: string[] = []): Promise<void> {
  let last: unknown;
  for (const launcher of terminalLaunchers(program, profile, args)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawner(launcher.command, launcher.args, { windowsHide: false, stdio: "ignore", detached: profile.id === "linux" });
        child.once("error", reject);
        // cmd/osascript exit as soon as the terminal opens; Linux terminals keep running, so their start is enough.
        if (profile.id === "linux") child.once("spawn", () => { child.unref(); resolve(); });
        else child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${launcher.command} exited with ${code}`)));
      });
      return;
    } catch (error) { last = error; }
  }
  throw Object.assign(new Error(`No terminal could be opened. Run "${program}" in a terminal yourself, then reconnect here.`), { cause: last });
}

/** Ways to open a visible terminal that runs `program`, in preference order. */
export function terminalLaunchers(program: string, profile: PlatformProfile = host, args: string[] = []): TerminalLaunch[] {
  const simple = /^[A-Za-z0-9._-]+$/;
  // Absolute paths may contain spaces but never quoting or shell metacharacters.
  const absolute = profile.path.isAbsolute(program) && !/["'`$;&|<>%!^\r\n\0]/.test(program);
  if (!(simple.test(program) || absolute) || !args.every(arg => simple.test(arg))) throw new Error("Unsupported terminal program.");
  if (profile.id === "win32") return [{ command: "cmd.exe", args: ["/c", "start", '""', program, ...args] }];
  if (profile.id === "darwin") {
    const line = [program.includes(" ") ? `'${program}'` : program, ...args].join(" ");
    return [{ command: "osascript", args: ["-e", `tell application "Terminal" to do script "${line}"`, "-e", 'tell application "Terminal" to activate'] }];
  }
  return [
    { command: "x-terminal-emulator", args: ["-e", program, ...args] },
    { command: "gnome-terminal", args: ["--", program, ...args] },
    { command: "konsole", args: ["-e", program, ...args] },
    { command: "xfce4-terminal", args: ["-x", program, ...args] },
    { command: "kitty", args: [program, ...args] },
    { command: "alacritty", args: ["-e", program, ...args] },
    { command: "xterm", args: ["-e", program, ...args] }
  ];
}
