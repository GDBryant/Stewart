#!/usr/bin/env node
// Boundary lint for packages/core/src (docs/building/MODULAR_DESIGN.md §7 steps 1 and 8).
// Reports files over `maxLines` and, for any file still mapped to a module in scripts/boundaries.json,
// relative imports that point to the same or a higher layer. The map is empty now that every module has
// been extracted, so only the size rule applies to core. Known violations live in
// scripts/boundaries.baseline.json; only NEW ones fail. `--update` rewrites the baseline.
// Step 8 (deferred) replaces the size rule with eslint `max-lines` etc. across every package.
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function moduleOf(rel, map) {
  for (const [prefix, mod] of map) if (rel === prefix || (prefix.endsWith("/") && rel.startsWith(prefix))) return mod;
  return "app";
}

export function findViolations(files, cfg, layers) {
  const rank = (m) => (m === "app" ? cfg.appLayer : layers[m]);
  const out = [];
  for (const [rel, text] of Object.entries(files)) {
    const from = moduleOf(rel, cfg.map);
    if (text.split("\n").length > cfg.maxLines) out.push(`size ${rel}`);
    for (const m of text.matchAll(/from\s+"(\.[^"]*)"/g)) {
      const target = join(dirname(rel), m[1]).replace(/\.js$/, ".ts");
      const to = moduleOf(files[target] !== undefined ? target : target + "/index.ts", cfg.map);
      if (to !== from && rank(to) >= rank(from)) out.push(`import ${rel} -> ${to}`);
    }
  }
  return [...new Set(out)].sort();
}

function walk(dir, base, acc) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else if (p.endsWith(".ts")) acc[relative(base, p)] = readFileSync(p, "utf8");
  }
  return acc;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cfg = JSON.parse(readFileSync(join(root, "scripts/boundaries.json"), "utf8"));
  const layers = JSON.parse(readFileSync(join(root, "scripts/layers.json"), "utf8"));
  const found = findViolations(walk(join(root, "packages/core/src"), join(root, "packages/core/src"), {}), cfg, layers);
  const basePath = join(root, "scripts/boundaries.baseline.json");
  if (process.argv.includes("--update")) { writeFileSync(basePath, JSON.stringify(found, null, 2) + "\n"); return console.log(`baseline: ${found.length}`); }
  const base = new Set(existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : []);
  const fresh = found.filter((v) => !base.has(v));
  const fixed = [...base].filter((v) => !found.includes(v));
  console.log(`boundaries: ${found.length} known violations, ${fresh.length} new, ${fixed.length} fixed (run --update to ratchet)`);
  if (fresh.length) { console.error(fresh.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
