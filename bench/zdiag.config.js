import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ root: fileURLToPath(new URL("..", import.meta.url)), test: { include: ["bench/zdiag.diag.js"], testTimeout: 7 * 24 * 3600 * 1000, pool: "forks" } });
