import { isIP } from "node:net";
import { host, insidePath } from "./platform";

/**
 * Deterministic risk checks for assistant shell commands, web requests and file reads in "automatic" mode.
 * Anything returning a reason must be validated by the user; everything else runs without a prompt.
 * This runs in trusted code and never asks the model, so injected email/web content cannot talk its way past it.
 */
interface Rule { pattern: RegExp; reason: string }

const SHELL_RULES: Rule[] = [
  // Deleting, wiping or force-overwriting data
  { pattern: /(^|[\s;&|(`{])(rm|rmdir|del|erase|rd|unlink|shred|srm|wipe)(\s|$)/i, reason: "deletes files or folders" },
  { pattern: /\b(Remove-Item|Clear-Content|Clear-RecycleBin|Remove-ItemProperty|Clear-Item)\b/i, reason: "deletes files, folders or settings" },
  { pattern: /\bfind\b[^\n|;]*\s-delete\b/i, reason: "deletes files" },
  { pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart|mkfs(\.\w+)?|wipefs|fdisk|parted|vssadmin|wbadmin|fsutil|bcdedit)\b/i, reason: "modifies disks, volumes, backups or boot settings" },
  { pattern: /(^|[\s;&|])format\s+[a-z]:/i, reason: "formats a drive" },
  { pattern: /\bcipher\s+\/w\b/i, reason: "wipes disk space" },
  { pattern: /\bdd\b[^\n]*\bof=/i, reason: "writes raw data to a device or file" },
  { pattern: /\bgit\s+(clean\s+-\w*f|reset\s+--hard|push\b[^\n]*(--force|-f\b)|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/i, reason: "discards or force-overwrites Git work" },
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

const WRITE_COMMAND = /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|cp|copy|xcopy|robocopy|mv|move|ren|rename|tee|touch|mkdir|md)\b|>{1,2}/i;
const ABSOLUTE_PATH = host.id === "win32"
  ? /(?:[A-Za-z]:[\\/][^\s"'`|;&<>]*|\\\\[^\s"'`|;&<>]+|\$(?:env:)?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)[^\s"'`|;&<>]*|%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%[^\s"'`|;&<>]*)/gi
  : /(?:(?:^|[\s"'=])(?:\/|~[\\/])[^\s"'`|;&<>]*|\$(?:env:)?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)[^\s"'`|;&<>]*|%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%[^\s"'`|;&<>]*)/g;

/** Returns why a shell command needs the user's validation, or undefined if it can run automatically. */
export function shellRisk(command: string, workspace: string): string | undefined {
  const text = command.trim();
  if (!text) return "the command is empty";
  for (const rule of SHELL_RULES) if (rule.pattern.test(text)) return rule.reason;
  if (WRITE_COMMAND.test(text)) {
    // Quoted paths may contain spaces; unquoted ones end at whitespace.
    const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/g)].map(match => match[1] ?? match[2]);
    const candidates = [...quoted.flatMap(value => [...value.matchAll(ABSOLUTE_PATH)].length ? [value] : []),
      ...[...text.replace(/"[^"]*"|'[^']*'/g, " ").matchAll(ABSOLUTE_PATH)].map(match => match[0])];
    const outside = candidates.map(path => path.trim().replace(/^["'=]/, ""))
      .filter(path => path && !/^\/(dev\/null|tmp\b)/.test(path) && !/^\$null$/i.test(path))
      .find(path => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") ? !insidePath(workspace, path) : true);
    if (outside) return `writes outside the workspace folder (${outside.slice(0, 120)})`;
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
