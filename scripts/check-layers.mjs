#!/usr/bin/env node
// Fails if a module depends on its own layer or above, is missing from scripts/layers.json,
// or exposes more than the single `.` export. See docs/building/MODULAR_DESIGN.md §6.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTSIDE = new Set(["@stewart/protocol"]);

export function checkLayers(layers, manifests) {
  const errors = [];
  const names = new Set(manifests.map((m) => m.name));
  for (const m of manifests) {
    const short = m.name.replace(/^@stewart\//, "");
    const rank = layers[short];
    if (rank === undefined) { errors.push(`${m.name}: not in layers.json`); continue; }
    const exp = m.exports && typeof m.exports === "object" ? Object.keys(m.exports) : [];
    if (exp.length !== 1 || exp[0] !== ".") errors.push(`${m.name}: exports must be exactly "."`);
    const deps = { ...m.dependencies, ...m.devDependencies, ...m.peerDependencies };
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith("@stewart/") || OUTSIDE.has(dep)) continue;
      const dr = layers[dep.replace(/^@stewart\//, "")];
      if (dr === undefined || !names.has(dep)) errors.push(`${m.name}: depends on unknown ${dep}`);
      else if (dr >= rank) errors.push(`${m.name} (L${rank}) depends on ${dep} (L${dr}): must be strictly lower`);
    }
  }
  for (const k of Object.keys(layers)) if (!names.has(`@stewart/${k}`)) errors.push(`layers.json: no package for ${k}`);
  return errors;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const layers = JSON.parse(readFileSync(join(root, "scripts", "layers.json"), "utf8"));
  const dir = join(root, "modules");
  const manifests = existsSync(dir)
    ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "package.json")))
        .map((d) => JSON.parse(readFileSync(join(dir, d, "package.json"), "utf8")))
    : [];
  const errors = checkLayers(layers, manifests);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`check-layers: ${manifests.length} modules ok`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
