import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "relay-copilot-smoke-"));
const env = { ...process.env };
for (const name of ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "COPILOT_SDK_AUTH_TOKEN", "COPILOT_CLI_PATH", "COPILOT_DISABLE_KEYTAR", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"]) delete env[name];
const client = new CopilotClient({
  mode: "copilot-cli", useLoggedInUser: true, workingDirectory: directory,
  logLevel: "none", env,
  sessionFs: { initialCwd: directory, sessionStatePath: "C:\\relay-session", conventions: "windows", capabilities: { sqlite: false } }
});
try {
  await client.start();
  const auth = await client.getAuthStatus();
  console.log(JSON.stringify({ authenticated: auth.isAuthenticated, authType: auth.authType }));
  if (auth.isAuthenticated) {
    const models = await client.listModels();
    console.log(JSON.stringify({ availableModels: models.map(model => model.id) }));
  }
} finally {
  await client.stop();
  await rm(directory, { recursive: true, force: true });
}
