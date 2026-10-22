import { isIP } from "node:net";
import { homedir } from "node:os";
import { host, insidePath } from "./platform";

/**
 * Deterministic risk checks for assistant shell commands, web requests and file reads in "automatic" mode.
 * Anything returning a reason must be validated by the user; everything else runs without a prompt.
 * This runs in trusted code and never asks the model, so injected email/web content cannot talk its way past it.
 */
interface Rule { pattern: RegExp; reason: string }

const SHELL_RULES: Rule[] = [
  // Deleting, wiping or force-overwriting data
  // Ordinary file deletes/overwrites are checked by target (see pathRisk); these always ask.
  { pattern: /\bClear-RecycleBin\b|\brm\b[^\n]*\s--no-preserve-root\b/i, reason: "permanently deletes files that cannot be recovered" },
  { pattern: /\b(Remove-ItemProperty|Clear-ItemProperty)\b|\b(Remove-Item|Clear-Item|Set-Item|New-Item|Rename-Item|Move-Item|Copy-Item|ri|rm|del)\b[^\n]*(?<![$\w{])(HKLM|HKCU|HKCR|HKU|HKCC|Registry|Env|Cert|WSMan):/i, reason: "deletes or changes registry, environment or certificate settings" },
  { pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart|mkfs(\.\w+)?|wipefs|fdisk|parted|vssadmin|wbadmin|fsutil|bcdedit)\b/i, reason: "modifies disks, volumes, backups or boot settings" },
  { pattern: /(^|[\s;&|])format\s+[a-z]:/i, reason: "formats a drive" },
  { pattern: /\bcipher\s+\/w\b/i, reason: "wipes disk space" },
  { pattern: /\bdd\b[^\n]*\bof=/i, reason: "writes raw data to a device or file" },
  { pattern: /\bgit\s+push\b[^\n]*(--force|-f\b|--mirror|--delete|\s:\S)/i, reason: "force-overwrites or deletes work in a remote Git repository" },
  { pattern: /\b(Stop-Process|kill|pkill|killall|taskkill)\b/i, reason: "terminates running programs" },
  { pattern: /\b(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer|Suspend-Computer)\b/i, reason: "shuts down or restarts the computer" },
  // Privilege, system configuration, persistence
  { pattern: /(^|[\s;&|])(sudo|su|doas|runas|pkexec)(\s|$)|-Verb\s+RunAs/i, reason: "runs with administrator privileges" },
  { pattern: /\b(Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|netsh|New-NetFirewallRule|Set-NetFirewall\w*|ufw|iptables|pfctl)\b/i, reason: "changes security or firewall settings" },
  { pattern: /\breg(\.exe)?\s+(add|delete|import|load|unload|restore)\b|\b(Set|New|Remove)-ItemProperty\b[^\n]*\b(HKLM|HKCU|HKEY_|Registry::)/i, reason: "changes the Windows registry" },
  { pattern: /\b(schtasks|Register-ScheduledTask|New-ScheduledTask\w*|crontab|launchctl|systemctl|New-Service|Set-Service|sc(\.exe)?\s+(create|config|delete|stop))\b/i, reason: "creates or changes scheduled tasks or services" },
  { pattern: /\\Start Menu\\Programs\\Startup|CurrentVersion\\Run|LaunchAgents|LaunchDaemons|autostart|\$PROFILE\b|\.(bashrc|zshrc|bash_profile|profile|zprofile)\b/i, reason: "adds something that runs automatically at login" },
  { pattern: /\b(chmod|chown|chgrp|icacls|takeown|cacls|Set-Acl)\b/i, reason: "changes file permissions or ownership" },
  { pattern: /\b(net\s+(user|localgroup)|useradd|userdel|usermod|passwd|New-LocalUser|Add-LocalGroupMember|dscl)\b/i, reason: "changes user accounts" },
  // Installing or running downloaded code, obfuscation
  { pattern: /\b(winget|choco|scoop|apt(-get)?|yum|dnf|pacman|zypper|brew|snap|flatpak|msiexec)\b[^\n]*?\s(install|upgrade|uninstall|remove|add|\/i|-i)\b|\b(Install-Module|Install-Package|Install-Script|Uninstall-Module|Uninstall-Package)\b/i, reason: "installs or removes software" },
  { pattern: /\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall)\b[^\n]*(-g\b|--global)|\b(pip3?|pipx|gem|cargo|go)\s+(install|uninstall)\b/i, reason: "installs or removes software" },
  { pattern: /\b(Invoke-Expression|iex)\b|\|\s*(sh|bash|zsh|pwsh|powershell|python3?|node)\b|DownloadString|DownloadFile|FromBase64String|-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}|base64\s+(-d|--decode)/i, reason: "runs downloaded or encoded code" },
  // Credentials and private data
  { pattern: /\b(Get-Credential|cmdkey|vaultcmd|ConvertFrom-SecureString|ProtectedData|dpapi|mimikatz|security\s+(find|dump)-\w+|secret-tool|keyring|kwallet|gnome-keyring)\b/i, reason: "accesses saved credentials" },
  { pattern: /\.ssh\b|id_(rsa|ed25519|ecdsa|dsa)\b|\.aws\b|\.azure\b|\.kube\b|\.gnupg\b|\.netrc\b|\.npmrc\b|\.git-credentials\b|\.env\b|Login Data|Cookies\b|Local State\b|key[34]\.db|logins\.json|Keychains?\b/i, reason: "touches keys, tokens, passwords or browser data" },
  { pattern: /(AppData[\\/](Roaming|Local)|\$(env:)?(APPDATA|LOCALAPPDATA)|%(APPDATA|LOCALAPPDATA)%)[\\/]Relay Desk|Application Support[\\/]Relay Desk|\.config[\\/]Relay Desk/i, reason: "touches Relay Desk's private data folder" },
  // Sending data or messages to other systems
  { pattern: /\b(Send-MailMessage|sendmail|mailx?|mutt|swaks)\b/i, reason: "sends email" },
  { pattern: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|http)\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--?(data|data-\w+|form|upload-file|json)\b|\s-[dFT]\s|-Method\s+(Post|Put|Patch|Delete)|-Body\b|-InFile\b)/i, reason: "sends data to a server" },
  { pattern: /(^|[\s;&|])(ssh|scp|sftp|ftp|rsync|nc|ncat|netcat|telnet|socat)\s/i, reason: "connects to or copies files to another machine" },
  { pattern: /\bgit\s+push\b/i, reason: "publishes commits to a remote repository" }
];

const SENSITIVE_PATH = /[\\/]\.ssh([\\/]|$)|[\\/]\.(aws|azure|kube|gnupg|docker|config[\\/]gh)([\\/]|$)|\.(netrc|npmrc|pypirc|git-credentials|env)$|id_(rsa|ed25519|ecdsa|dsa)|[\\/](Login Data|Cookies|Local State|Web Data|key[34]\.db|logins\.json|cookies\.sqlite)$|Keychains?[\\/]|[\\/]Microsoft[\\/](Credentials|Protect|Vault)([\\/]|$)|AppData[\\/](Roaming|Local)[\\/]Relay Desk([\\/]|$)|Application Support[\\/]Relay Desk([\\/]|$)|\.config[\\/]Relay Desk([\\/]|$)|[\\/](etc[\\/](shadow|sudoers)|SAM|SYSTEM|SECURITY)$|\.(pem|key|pfx|p12|kdbx)$/i;

const DELETE_COMMAND = /(^|[\s;&|(`{])(rm|rmdir|del|erase|rd|ri|unlink|shred|srm|wipe)(\s|$)|\b(Remove-Item|Clear-Content|Clear-Item)\b|\bfind\b[^\n|;]*\s-delete\b|\bgit\s+(clean|reset|checkout|restore|rm)\b/i;
const WRITE_COMMAND = /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Expand-Archive|cp|copy|xcopy|robocopy|mv|move|ren|rename|tee|touch|mkdir|md|sed\s+-i|truncate)\b|>{1,2}/i;
const ENV_NAMES = "HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ProgramFiles(?:\\(x86\\))?|ProgramW6432|SystemRoot|windir|SystemDrive|HOMEDRIVE|TEMP|TMP|PUBLIC|ALLUSERSPROFILE|OneDrive";
const PATH_CHARS = "[^\\s\"'`|;&<>]*";
const ABSOLUTE_PATH = new RegExp(
  (host.id === "win32" ? `(?:(?:^|(?<=[\\s"'=(]))[A-Za-z]:[\\\\/]?${PATH_CHARS}|\\\\\\\\[^\\s"'\`|;&<>]+|` : `(?:(?:^|(?<=[\\s"'=(]))\\/${PATH_CHARS}|`) +
  `(?:^|(?<=[\\s"'=(]))~(?:[\\\\/]${PATH_CHARS})?(?=$|[\\s"'\`|;&<>)])|\\$\\{?(?:env:)?(?:${ENV_NAMES})\\}?${PATH_CHARS}|%(?:${ENV_NAMES})%${PATH_CHARS}|` +
  `(?:^|(?<=[\\s"'=(]))\\.\\.(?:[\\\\/]${PATH_CHARS})?)`, "gi");

/** Expands ~ and well-known environment variables so a target path can be classified. */
function expandPath(raw: string): string {
  const home = homedir();
  const lookup = (name: string) => {
    if (/^(HOME|USERPROFILE)$/i.test(name)) return home;
    const key = Object.keys(process.env).find(item => item.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : undefined;
  };
  return raw
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$\{?(?:env:)?([A-Za-z_][\w()]*)\}?/i, (match, name: string) => lookup(name) ?? match)
    .replace(/^%([^%]+)%/, (match, name: string) => lookup(name) ?? match);
}

/** Paths mentioned by a shell command: absolute, home/env-relative and ../ escapes from the workspace. */
function commandPaths(command: string): string[] {
  const quoted = [...command.matchAll(/"([^"]+)"|'([^']+)'/g)].map(match => (match[1] ?? match[2]).trim())
    .filter(value => [...value.matchAll(ABSOLUTE_PATH)].some(match => match.index === 0));
  const bare = [...command.replace(/"[^"]*"|'[^']*'/g, " ").matchAll(ABSOLUTE_PATH)].map(match => match[0]);
  return [...quoted, ...bare].map(path => path.trim().replace(/^["'=(]/, "").replace(/[)]+$/, ""))
    .filter(path => path && !/^\/dev\/null$/.test(path) && !/^\$null$/i.test(path));
}

const WIN_SYSTEM = /^[a-z]:\\(windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|boot|efi|perflogs|msocache|config\.msi|intel|amd|nvidia|drivers)(\\|$)|^[a-z]:\\(pagefile|hiberfil|swapfile)\.sys$|^[a-z]:\\(bootmgr|bootnxt)$|^[a-z]:\\users(\\(public|default|default user|all users)(\\|$)|$)/i;
const UNIX_SYSTEM = /^\/(bin|boot|dev|etc|lib|lib32|lib64|libx32|opt|proc|root|run|sbin|srv|sys|usr|System|Library|Applications|cores|snap)(\/|$)|^\/var(?!\/(tmp|folders)(\/|$))(\/|$)|^\/private(?!\/(tmp|var\/folders)(\/|$))(\/|$)/;
const MAIN_USER_FOLDERS = /^(Documents|Desktop|Downloads|Pictures|Music|Videos|Movies|Public|OneDrive[^\\/]*|Dropbox|Google Drive|iCloud Drive)$/i;

/**
 * Returns why changing or deleting `path` needs validation, or undefined for ordinary user files
 * (anything that is not system/program data, app settings, credentials, or an entire drive/home/main folder).
 */
export function pathRisk(raw: string, workspace: string): string | undefined {
  if (!raw.trim()) return "the path is empty";
  const expanded = expandPath(raw.trim());
  if (/^\$|%[^%]+%/.test(expanded)) return `its target (${raw.slice(0, 80)}) could not be verified`;
  const resolved = host.path.resolve(workspace, expanded);
  // A trailing wildcard (C:\*, ~/*) affects everything in the parent folder.
  const target = resolved.replace(/[\\/]\*+(\.\*)?$/, "").replace(/[\\/]+$/, "") || host.path.parse(resolved).root;
  const win = host.id === "win32";
  const same = (a: string, b: string) => win ? a.toLowerCase() === b.toLowerCase() : a === b;
  const home = homedir().replace(/[\\/]+$/, "");
  if (SENSITIVE_PATH.test(target) || SENSITIVE_PATH.test(resolved)) return "it holds keys, passwords, browser data or Relay Desk's private data";
  if (win ? WIN_SYSTEM.test(target) : UNIX_SYSTEM.test(target)) return "it is a system or program folder the computer needs";
  const parsed = host.path.parse(target);
  if (same(target, parsed.root.replace(/[\\/]+$/, "")) || same(`${target}${host.path.sep}`, parsed.root) || !target) return "it is an entire drive";
  if (same(target, home) || same(target, workspace.replace(/[\\/]+$/, ""))) return "it is your whole home or workspace folder";
  if (/^\/(home|Users)(\/[^/]+)?$/.test(target) || (win && /^[a-z]:\\users\\[^\\]+$/i.test(target))) return "it is a whole user home folder";
  if (insidePath(home, target) && !same(target, home)) {
    const rest = target.slice(home.length + 1).split(/[\\/]/);
    if (rest.length === 1 && MAIN_USER_FOLDERS.test(rest[0])) return `it is your entire ${rest[0]} folder`;
    if (rest[0].startsWith(".")) return "it holds app or shell configuration";
    if (/^AppData$/i.test(rest[0]) && !(/^Local$/i.test(rest[1] ?? "") && /^Temp$/i.test(rest[2] ?? ""))) return "it holds app settings or installed programs";
    if (rest[0] === "Library" && !win) return "it holds app settings";
  }
  return undefined;
}

/** Returns why a shell command needs the user's validation, or undefined if it can run automatically. */
export function shellRisk(command: string, workspace: string): string | undefined {
  const text = command.trim();
  if (!text) return "the command is empty";
  for (const rule of SHELL_RULES) if (rule.pattern.test(text)) return rule.reason;
  const deletes = DELETE_COMMAND.test(text);
  if (deletes || WRITE_COMMAND.test(text)) {
    for (const path of commandPaths(text)) {
      const why = pathRisk(path, workspace);
      if (why) return `${deletes ? "deletes or replaces" : "changes"} files where ${why} (${path.slice(0, 120)})`;
    }
  }
  return undefined;
}
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|metadata\.google\.internal)$/i;
function privateAddress(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(name)) return true;
  const version = isIP(name);
  if (version === 4) {
    const [a, b] = name.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) return /^(::1?|f[cd]|fe[89ab]|::ffff:(127|10|192\.168|169\.254))/i.test(name);
  return false;
}

/** Returns why fetching a URL needs the user's validation, or undefined if it can be fetched automatically. */
export function urlRisk(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return "the address is not a valid URL"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `uses the ${url.protocol} scheme`;
  if (url.username || url.password) return "contains credentials in the address";
  if (privateAddress(url.hostname)) return "targets this computer or a private network";
  const query = decodeURIComponent(url.search + url.hash);
  if (query.length > 300) return "sends a long piece of data in the address";
  if (/@[\w-]+\.[\w.]+|\b(token|password|passwd|secret|api[_-]?key|session|auth)=/i.test(query)) return "includes an email address, token or password in the address";
  return undefined;
}

/** Returns why reading a file outside the workspace needs validation, or undefined if it can be read automatically. */
export function readRisk(path: string): string | undefined {
  if (!path) return "the path is empty";
  if (SENSITIVE_PATH.test(path)) return "it may contain keys, passwords, browser data or Relay Desk's private archive";
  if (host.id === "win32" && /^[A-Za-z]:[\\/](Windows|ProgramData)[\\/]/i.test(path)) return "it is a system file";
  if (/^\/(etc|var|private|System|Library)\//.test(path)) return "it is a system file";
  return undefined;
}
