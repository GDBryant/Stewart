import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL("./test/vscode.stub.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], coverage: { provider: "v8", include: ["src/**"], exclude: ["src/extension.ts", "src/host.ts"], thresholds: { lines: 90, branches: 80 } } },
});
