#!/usr/bin/env node
// Rewrites tsconfig "references" from workspace deps in each package manifest, and
// sets composite:true on every package that is referenced. --check exits 1 on drift.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIRS = ["modules", "packages", "hosts"];

export function packageDirs(root = ROOT) {
  const dirs = [];
  for (const top of PKG_DIRS) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const dir = join(base, d);
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "tsconfig.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

export function computeUpdates(root = ROOT) {
  const dirs = packageDirs(root);
  const byName = new Map();
  for (const dir of dirs) {
    const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    byName.set(j.name, dir);
  }
  const referenced = new Set();
  const wantRefs = new Map();
  for (const dir of dirs) {
    const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const deps = { ...j.dependencies, ...j.devDependencies, ...j.peerDependencies };
    const refs = [];
    for (const [name, spec] of Object.entries(deps)) {
      if (!String(spec).startsWith("workspace:") || !byName.has(name)) continue;
      const dep = byName.get(name);
      referenced.add(dep);
      refs.push({ path: relative(dir, dep).split("\\").join("/") });
    }
    refs.sort((a, b) => a.path.localeCompare(b.path));
    wantRefs.set(dir, refs);
  }
  const updates = new Map();
  for (const dir of dirs) {
    const tp = join(dir, "tsconfig.json");
    const t = JSON.parse(readFileSync(tp, "utf8"));
    const next = { ...t };
    const refs = wantRefs.get(dir);
    if (refs.length) next.references = refs;
    else delete next.references;
    if (referenced.has(dir)) {
      next.compilerOptions = { ...(next.compilerOptions || {}), composite: true };
    }
    if (JSON.stringify(next) !== JSON.stringify(t)) updates.set(tp, next);
  }
  return updates;
}

function main() {
  const check = process.argv.includes("--check");
  const updates = computeUpdates();
  if (check) {
    if (updates.size) {
      for (const [tp, next] of updates) {
        console.error(`${relative(ROOT, tp)}: drift`);
        console.error(`  want ${JSON.stringify(next)}`);
      }
      process.exit(1);
    }
    console.log("check:tsrefs: all tsconfig references in sync");
    return;
  }
  for (const [tp, next] of updates) writeFileSync(tp, JSON.stringify(next, null, 2) + "\n");
  console.log(`sync-tsrefs: updated ${updates.size} tsconfig(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
