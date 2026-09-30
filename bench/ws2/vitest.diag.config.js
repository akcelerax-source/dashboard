import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// WS2 diagnostics only (bench/ws2/*.diag.js). Not matched by bench/vitest.config.js.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["bench/ws2/**/*.diag.js"],
    testTimeout: 7 * 24 * 3600 * 1000,
    hookTimeout: 600000,
    reporters: ["default"],
    fileParallelism: false,
    pool: "forks"
  }
});
