#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const PLUGIN_ID = "com.adb.stewart";
export const RELEASES_BASE = "https://github.com/GDBryant/Stewart/releases/download";

export function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function feedXml(version, { changeNotes = "" } = {}) {
  if (!SEMVER.test(version)) throw new Error(`malformed version: ${version}`);
  const zip = `${RELEASES_BASE}/v${version}/stewart-${version}.zip`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<plugins>
  <plugin id="${PLUGIN_ID}" url="${zip}" version="${version}">
    <name>Stewart</name>
    <idea-version since-build="261"/>
    <description>${xmlEscape("Chat with local and remote models inside the IDE: roles, skills, orchestration and tools.")}</description>
    <change-notes>${xmlEscape(changeNotes)}</change-notes>
  </plugin>
</plugins>
`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [version, out = "updatePlugins.xml"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: gen-update-feed.mjs <version> [output-file]");
    process.exit(1);
  }
  try {
    writeFileSync(out, feedXml(version));
    console.log(`wrote ${out} for ${version}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
