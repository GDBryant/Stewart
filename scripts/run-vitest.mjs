#!/usr/bin/env node
// Run vitest in one or more packages, optionally narrowed to test files.
// Usage: node scripts/run-vitest.mjs <pkg> [<pkg> ...] [-- <test-file-glob>...]
//
// The repo's test stack needs a modern Node; system Node here is v18 while the
// maintained toolchain lives under ~/.nvm/versions/node/*/bin (see AGENTS.md).
// The newest nvm node wins unless STEWART_NODE overrides it; fall back to the
// current process binary.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const packages = (sep < 0 ? argv : argv.slice(0, sep)).map(String);
const filters = sep < 0 ? [] : argv.slice(sep + 1).map(String);

function versionOf(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const m = /^v(\d+)\./.exec(r.stdout ?? "");
  return m ? Number(m[1]) : 0;
}

function pickNode() {
  if (process.env.STEWART_NODE && existsSync(process.env.STEWART_NODE)) return process.env.STEWART_NODE;
  const nvmDir = join(homedir(), ".nvm", "versions", "node");
  const candidates = [];
  try {
    for (const v of readdirSync(nvmDir)) {
      const bin = join(nvmDir, v, "bin", "node");
      if (existsSync(bin)) candidates.push({ bin, major: versionOf(bin) });
    }
  } catch {
    /* no nvm installation */
  }
  candidates.sort((a, b) => b.major - a.major);
  const best = candidates[0];
  if (best && best.major >= 20) return best.bin;
  if (versionOf(process.execPath) >= 20) return process.execPath;
  return best?.bin ?? process.execPath;
}

if (!packages.length) {
  console.error("usage: node scripts/run-vitest.mjs <pkg> [<pkg> ...] [-- <test-file-glob>...]");
  process.exit(2);
}

const nodeBin = pickNode();
let failed = false;
for (const pkg of packages) {
  const dir = resolve(root, pkg);
  // Use vitest's JS entry directly (the .bin shim is a shell script that node can't run).
  const entry = join(dir, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(entry)) {
    console.error(`no vitest in ${pkg} (run pnpm install)`);
    failed = true;
    continue;
  }
  console.log(`> ${pkg}${filters.length ? ` (${filters.join(" ")})` : ""} [${nodeBin}]`);
  const r = spawnSync(nodeBin, [entry, "run", ...filters], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
