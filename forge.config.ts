import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

class WindowsZIP extends MakerZIP {
  override async make({ dir, makeDir, packageJSON, targetArch, targetPlatform }: Parameters<MakerZIP["make"]>[0]): Promise<string[]> {
    if (!process.env.SystemRoot) throw new Error("Windows system directory is unavailable.");
    const destination = join(makeDir, "zip", targetPlatform, targetArch, `${basename(dir)}-${packageJSON.version}.zip`);
    await this.ensureFile(destination);
    try {
      // Forge's PowerShell ZIP implementation fails on long native-dependency paths.
      await promisify(execFile)(join(process.env.SystemRoot, "System32", "tar.exe"),
        ["-a", "-cf", destination, "."], { cwd: dir, windowsHide: true });
      return [destination];
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
}

const config: ForgeConfig = {
  // Lets a second build run while a packaged copy from out/ is open (Windows locks running binaries).
  ...(process.env.RELAY_OUT_DIR ? { outDir: process.env.RELAY_OUT_DIR } : {}),
  packagerConfig: {
    asar: false,
    executableName: "RelayDesk",
    appBundleId: "com.relaydesk.personal",
    appCategoryType: "public.app-category.productivity",
    // Runtime/native dependencies are deliberately external to the Vite bundle.
    ignore: path => {
      const normalized = path.replace(/\\/g, "/");
      return normalized !== "" && normalized !== "/" && !/^\/(?:\.vite|node_modules)(?:\/|$)|^\/package\.json$/.test(normalized);
    }
  },
  rebuildConfig: {},
  makers: [
    new WindowsZIP({}, ["win32"]),
    new MakerZIP({}, ["darwin", "linux"]),
    new MakerDeb({ options: { name: "relay-desk", bin: "RelayDesk", productName: "Relay Desk", categories: ["Office", "Network"],
      homepage: "https://github.com/Ai4Innov/relaydesk", depends: ["libsecret-1-0"] } }, ["linux"])
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/app.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts", target: "preload" }
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }]
    })
  ]
};
export default config;
