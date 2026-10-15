import { defineConfig } from "vite";
import { builtinModules } from "node:module";
import pkg from "./package.json";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export default defineConfig({
  plugins: [{
    name: "relay-attachment-worker",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "attachment-worker.cjs", source: readFileSync("src/main/attachments/attachment-worker.cjs", "utf8") });
      for (const name of readdirSync("browser-extension"))
        if (/\.(json|js|html|css)$/.test(name))
          this.emitFile({ type: "asset", fileName: `browser-extension/${name}`, source: readFileSync(join("browser-extension", name)) });
    }
  }],
  build: {
    sourcemap: true,
    lib: { entry: "src/main/app.ts", formats: ["cjs"], fileName: () => "main.js" },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map(name => `node:${name}`), ...Object.keys(pkg.dependencies)]
    }
  }
});
