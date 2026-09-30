import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// WS4 only: the regression suite (tests/*.test.js) re-pointed at zz-ws4
// (bench/ws4/tests/*.ws4check.js). Not matched by the default test glob nor by
// bench/vitest.config.js.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["bench/ws4/tests/*.ws4check.js"],
    testTimeout: 600000,
    hookTimeout: 600000,
    fileParallelism: false,
    pool: "forks"
  }
});
