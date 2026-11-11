#!/usr/bin/env node
// Boundary lint (docs/building/MODULAR_DESIGN.md §7 steps 1 and 8; docs/building/ARCHITECTURE_IMPROVEMENTS.md F).
// Size rule over every non-test source file in modules/*/src, packages/*/src, hosts/*/src (.ts .tsx .kt):
// over `softLines` (300) = warning, over `maxLines` (500) = failure. For packages/core/src, files still mapped
// to a module in scripts/boundaries.json also get the relative-import layer rule (the map is empty now).
// Known failures live in scripts/boundaries.baseline.json; only NEW ones fail. `--update` rewrites the baseline.
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

/** Files over the soft limit (warning) and over the hard limit (`size` failure); line counts per path. */
export function sizeFindings(files, softLines, maxLines) {
  const warn = [];
  const fail = [];
  for (const [rel, text] of Object.entries(files)) {
    const n = text.split("\n").length;
    if (n > maxLines) fail.push(`size ${rel}`);
    else if (n > softLines) warn.push(`${rel} (${n})`);
  }
  return { warn: warn.sort(), fail: fail.sort() };
}

const SKIP = new Set(["node_modules", "dist", "build", "coverage", "test", "tests", ".gradle"]);
const SRC = /\.(ts|tsx|kt)$/;

function walk(dir, base, acc, ext = /\.ts$/) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc, ext);
    else if (ext.test(p) && !/\.(test|d)\.ts$/.test(p)) acc[relative(base, p)] = readFileSync(p, "utf8");
  }
  return acc;
}

function sourceRoots(root) {
  const roots = [];
  for (const group of ["modules", "packages", "hosts"]) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const d of readdirSync(g)) if (existsSync(join(g, d, "src"))) roots.push(join(g, d, "src"));
  }
  return roots;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cfg = JSON.parse(readFileSync(join(root, "scripts/boundaries.json"), "utf8"));
  const layers = JSON.parse(readFileSync(join(root, "scripts/layers.json"), "utf8"));
  const coreDir = join(root, "packages/core/src");
  const found = findViolations(walk(coreDir, coreDir, {}), { ...cfg, maxLines: Infinity }, layers);
  const all = {};
  for (const r of sourceRoots(root)) walk(r, root, all, SRC);
  const sizes = sizeFindings(all, cfg.softLines, cfg.maxLines);
  found.push(...sizes.fail);
  if (sizes.warn.length) console.log(`size warnings (>${cfg.softLines} lines, hard limit ${cfg.maxLines}):\n  ${sizes.warn.join("\n  ")}`);
  const basePath = join(root, "scripts/boundaries.baseline.json");
  if (process.argv.includes("--update")) { writeFileSync(basePath, JSON.stringify(found, null, 2) + "\n"); return console.log(`baseline: ${found.length}`); }
  const base = new Set(existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : []);
  const fresh = found.filter((v) => !base.has(v));
  const fixed = [...base].filter((v) => !found.includes(v));
  console.log(`boundaries: ${found.length} known violations, ${fresh.length} new, ${fixed.length} fixed (run --update to ratchet)`);
  if (fresh.length) { console.error(fresh.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
