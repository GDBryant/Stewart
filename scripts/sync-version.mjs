#!/usr/bin/env node
// Sets the product version everywhere `check:docs` guards it: hosts/vscode/package.json,
// modules/kernel/src/version.ts, docs/ai_docs/ARCHITECTURE_NOW.md and docs/ARCHITECTURE_DIAGRAM.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;

const FILES = {
  packageJson: "hosts/vscode/package.json",
  versionTs: "modules/kernel/src/version.ts",
  archNow: "docs/ai_docs/ARCHITECTURE_NOW.md",
  diagram: "docs/ARCHITECTURE_DIAGRAM.md",
};

/** Updated file texts for a version bump; throws on a non-semver version or a missing version pattern. */
export function syncVersion(version, texts) {
  if (!SEMVER.test(version)) throw new Error(`not a semver x.y.z: ${version}`);
  const must = (name, text, re, next) => {
    if (!re.test(text)) throw new Error(`version pattern not found in ${name}`);
    return text.replace(re, next);
  };
  return {
    packageJson: must(FILES.packageJson, texts.packageJson, /"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`),
    versionTs: must(FILES.versionTs, texts.versionTs, /STEWART_VERSION = "\d+\.\d+\.\d+"/, `STEWART_VERSION = "${version}"`),
    archNow: must(FILES.archNow, texts.archNow, /Product version \d+\.\d+\.\d+/, `Product version ${version}`),
    diagram: must(FILES.diagram, texts.diagram, /code as built \(v\d+\.\d+\.\d+\)/, `code as built (v${version})`),
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const texts = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(join(root, f), "utf8")]));
  let out;
  try {
    out = syncVersion(process.argv[2] ?? "", texts);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const [k, f] of Object.entries(FILES)) writeFileSync(join(root, f), out[k]);
  console.log(`version set to ${process.argv[2]} (${Object.keys(FILES).length} files)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
