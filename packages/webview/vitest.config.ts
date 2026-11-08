import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", globals: false, coverage: { provider: "v8", include: ["src/**"], thresholds: { lines: 90, branches: 80 } } },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
});
