import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.{ts,mjs}"], coverage: { provider: "v8", include: ["src/**"], thresholds: { lines: 90, branches: 80 } } } });
