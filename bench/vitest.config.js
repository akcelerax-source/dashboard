import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Benchmark-only config: picks up bench/*.run.js (never matched by the
// default *.test.js glob, so `npx vitest run` does not run the benchmark).
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["bench/**/*.run.js"],
    testTimeout: 7 * 24 * 3600 * 1000,
    hookTimeout: 600000,
    reporters: ["default"],
    // One run matrix per process; parallel shards are separate processes.
    fileParallelism: false,
    pool: "forks"
  }
});
