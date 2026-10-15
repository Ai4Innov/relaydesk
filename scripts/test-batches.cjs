#!/usr/bin/env node
// Runs the Vitest suite in batches. One process for every file can exhaust memory on Windows
// because several suites load native modules and ONNX/OCR runtimes.
const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

const size = Number(process.env.RELAY_TEST_BATCH_SIZE) || 12;
const root = join(__dirname, "..");
const files = readdirSync(join(root, "tests"))
  .filter(name => /\.test\.tsx?$/.test(name))
  .sort()
  .map(name => `tests/${name}`);
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const failed = [];

for (let index = 0; index < files.length; index += size) {
  const batch = files.slice(index, index + size);
  console.log(`\n=== Batch ${index / size + 1}/${Math.ceil(files.length / size)}: ${batch.length} files ===`);
  const result = spawnSync(process.execPath, [vitest, "run", "--no-file-parallelism", ...batch], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) failed.push(...batch);
}

if (failed.length) {
  console.error(`\nFailing batches contained:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);
