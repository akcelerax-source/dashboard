import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
// WS3: the regular unit suite re-pointed at zz-ws3 (copies in bench/ws3/tests).
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: { include: ["bench/ws3/tests/*.test.js"], testTimeout: 600000, hookTimeout: 600000, pool: "forks", fileParallelism: false }
});
