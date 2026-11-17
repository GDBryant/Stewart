import { test } from "node:test";
import assert from "node:assert/strict";
import { syncVersion } from "./sync-version.mjs";

const texts = (v) => ({
  packageJson: `{\n  "name": "x",\n  "version": "${v}"\n}`,
  versionTs: `export const STEWART_VERSION = "${v}";`,
  archNow: `Product version ${v} — source of truth`,
  diagram: `Rendered view of the code as built (v${v}).`,
});

test("updates all four version sites", () => {
  const out = syncVersion("4.5.6", texts("1.2.3"));
  assert.match(out.packageJson, /"version": "4\.5\.6"/);
  assert.match(out.versionTs, /STEWART_VERSION = "4\.5\.6"/);
  assert.match(out.archNow, /Product version 4\.5\.6/);
  assert.match(out.diagram, /code as built \(v4\.5\.6\)/);
});

test("rejects a non-semver version", () => {
  for (const v of ["", "1.2", "1.2.3.4", "v1.2.3", "abc", "1.2.x"]) {
    assert.throws(() => syncVersion(v, texts("1.2.3")), /not a semver/);
  }
});

test("fails when a file lacks its version pattern", () => {
  const bad = { ...texts("1.2.3"), diagram: "no version here" };
  assert.throws(() => syncVersion("4.5.6", bad), /version pattern not found/);
});
