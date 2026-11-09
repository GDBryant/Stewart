import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], coverage: { provider: "v8", include: ["src/**"], exclude: ["src/extension.ts", "src/host.ts"], thresholds: { lines: 90, branches: 80 } } } });
