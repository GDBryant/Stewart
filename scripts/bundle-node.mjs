#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NODE_VERSION = "22.20.0";

export const TARGETS = {
  "linux-x64": { archive: "node-v{v}-linux-x64.tar.gz", member: "bin/node", exe: "node", zip: false },
  "linux-arm64": { archive: "node-v{v}-linux-arm64.tar.gz", member: "bin/node", exe: "node", zip: false },
  "macos-x64": { archive: "node-v{v}-darwin-x64.tar.gz", member: "bin/node", exe: "node", zip: false },
  "macos-arm64": { archive: "node-v{v}-darwin-arm64.tar.gz", member: "bin/node", exe: "node", zip: false },
  "windows-x64": { archive: "node-v{v}-win-x64.zip", member: "node.exe", exe: "node.exe", zip: true },
};

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function shasumFor(shasumsText, filename) {
  for (const line of shasumsText.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && m[2] === filename) return m[1];
  }
  return undefined;
}

export function verifyArchive(shasumsText, filename, bytes) {
  const expected = shasumFor(shasumsText, filename);
  if (!expected) throw new Error(`no SHASUMS256 entry for ${filename}`);
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${filename}: expected ${expected}, got ${actual}`);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function archiveDirName(archive) {
  return archive.replace(/\.(tar\.gz|zip)$/, "");
}

function extractMember(archivePath, archive, { member, zip }) {
  if (zip) {
    return execFileSync("unzip", ["-p", archivePath, member], { maxBuffer: 256 * 1024 * 1024 });
  }
  return execFileSync("tar", ["-xzOf", archivePath, `${archiveDirName(archive)}/${member}`], { maxBuffer: 256 * 1024 * 1024 });
}

export async function bundleNode(key, outRoot = "dist/node", version = NODE_VERSION) {
  const target = TARGETS[key];
  if (!target) throw new Error(`unknown target '${key}'; expected one of ${Object.keys(TARGETS).join(", ")}`);
  const archive = target.archive.replace("{v}", version);
  const base = `https://nodejs.org/dist/v${version}`;
  const shasums = (await download(`${base}/SHASUMS256.txt`)).toString("utf8");
  const bytes = await download(`${base}/${archive}`);
  verifyArchive(shasums, archive, bytes);
  const tmp = mkdtempSync(join(tmpdir(), "stewart-node-"));
  try {
    const archivePath = join(tmp, archive);
    writeFileSync(archivePath, bytes);
    const bin = extractMember(archivePath, archive, target);
    const out = join(outRoot, key, target.exe);
    mkdirSync(join(outRoot, key), { recursive: true });
    writeFileSync(out, bin);
    chmodSync(out, 0o755);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
  for (const key of keys) {
    const out = await bundleNode(key);
    console.log(`bundled ${key} -> ${out}`);
  }
}
