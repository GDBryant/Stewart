#!/usr/bin/env node
// Fails when docs/ai_docs/ARCHITECTURE_NOW.md drifts from the code: product version and the §1a module table.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pure check: `doc` text, real `version`, and the `layers` map from scripts/layers.json. */
export function checkDocs(doc, version, layers) {
  const errors = [];
  const v = /Product version (\d+\.\d+\.\d+)/.exec(doc)?.[1];
  if (v !== version) errors.push(`version: doc says ${v ?? "none"}, package says ${version}`);
  const rows = new Map();
  for (const m of doc.matchAll(/^\| `([a-z0-9-]+)` \| (\d+) \|/gm)) rows.set(m[1], Number(m[2]));
  for (const [name, layer] of Object.entries(layers)) {
    if (!rows.has(name)) errors.push(`module table: missing row for ${name}`);
    else if (rows.get(name) !== layer) errors.push(`module table: ${name} is layer ${layer}, doc says ${rows.get(name)}`);
  }
  for (const name of rows.keys()) if (!(name in layers)) errors.push(`module table: unknown module ${name}`);
  return errors;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const doc = readFileSync(join(root, "docs/ai_docs/ARCHITECTURE_NOW.md"), "utf8");
  const version = JSON.parse(readFileSync(join(root, "hosts/vscode/package.json"), "utf8")).version;
  const layers = JSON.parse(readFileSync(join(root, "scripts/layers.json"), "utf8"));
  const errors = checkDocs(doc, version, layers);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`check-docs: ok (v${version}, ${Object.keys(layers).length} modules)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
