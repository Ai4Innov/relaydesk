const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

let failed = false;
function check(name, script) {
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) {
    failed = true;
    console.error(`${name}: unavailable. ${result.error?.message || result.stderr?.trim() || `Native process exited ${result.status}`}`);
    return;
  }
  console.log(`${name}: ${result.stdout.trim() || "ready"}`);
}
console.log(`Relay Desk environment: Node ${process.version}, ${process.platform}/${process.arch}`);
check("Native SDK binding", "require('koffi'); console.log('ready')");
check("Encrypted SQLite", "const DB=require('better-sqlite3-multiple-ciphers'); const d=new DB(':memory:'); d.pragma(\"cipher='sqlcipher'\"); console.log(d.prepare('select sqlite_version() as version').get().version); d.close()");
check("Local embedding runtime", "require('onnxruntime-node'); console.log('ready')");
const electronReady = existsSync(join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe"));
console.log(`Electron binary: ${electronReady ? "ready" : "missing (run npm rebuild electron)"}`);
if (!electronReady) failed = true;
console.log("Account access is not tested here. Connect Copilot and register your Google/Microsoft/Slack applications in Settings.");
if (failed) console.error("Use an official Node.js 24 Windows installation, not an MSYS build, and run npm install. After Electron development, npm rebuild better-sqlite3-multiple-ciphers restores the Node test ABI.");
process.exitCode = failed ? 1 : 0;
