import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  // Windows directory watchers otherwise prevent the archive restore tests from renaming data.
  server: { watch: { ignored: ["**/.test-data/**", "**/out/**", "**/test-results/**"] } }
});
