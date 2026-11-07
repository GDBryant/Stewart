#!/usr/bin/env node
// Usage: node scripts/new-module.mjs <name> "<one-line purpose>"
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, purpose = "TODO"] = process.argv.slice(2);
if (!name) { console.error("usage: new-module.mjs <name> [purpose]"); process.exit(1); }
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", name);
if (existsSync(dir)) { console.error(`${dir} exists`); process.exit(1); }
mkdirSync(join(dir, "src"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });
const w = (f, s) => writeFileSync(join(dir, f), s);
w("package.json", JSON.stringify({
  name: `@stewart/${name}`, version: "0.1.0", private: true, type: "module",
  exports: { ".": { types: "./dist/api.d.ts", default: "./dist/api.js" } },
  scripts: {
    build: "tsc -p tsconfig.json", typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run --passWithNoTests",
  },
  devDependencies: { "@types/node": "22.19.0", typescript: "5.9.3", vitest: "3.2.4" },
}, null, 2) + "\n");
w("tsconfig.json", JSON.stringify({
  extends: "../../tsconfig.base.json",
  compilerOptions: { outDir: "dist", rootDir: "src" }, include: ["src"],
}, null, 2) + "\n");
w("src/api.ts", `// Public surface of @stewart/${name}. Only this file is importable from outside.\nexport {};\n`);
w("README.md", `# @stewart/${name}\n\n- Purpose: ${purpose}\n- Surface: \`src/api.ts\`\n- Owns: TODO\n- Depends on: see \`package.json\` (lower layers only; \`scripts/layers.json\`)\n- Fake it: TODO\n`);
