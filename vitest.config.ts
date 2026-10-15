import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], exclude: ["tests/e2e/**"], testTimeout: 30000 }
});
