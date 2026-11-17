import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDocs } from "./check-docs.mjs";

const layers = { a: 0, b: 1 };
const doc = (v, rows) => `Product version ${v} (x)\n| Module | Layer | Purpose |\n|---|---|---|\n${rows}`;
const ok = "| `a` | 0 | pa |\n| `b` | 1 | pb |";

test("matching version and table passes", () => {
  assert.deepEqual(checkDocs(doc("1.2.3", ok), "1.2.3", layers), []);
});
test("wrong or missing version fails", () => {
  assert.match(checkDocs(doc("2.2.0", ok), "1.2.3", layers).join(), /doc says 2\.2\.0/);
  assert.match(checkDocs(ok, "1.2.3", layers).join(), /doc says none/);
});
test("missing row, wrong layer and unknown module fail", () => {
  assert.match(checkDocs(doc("1.2.3", "| `a` | 0 | pa |"), "1.2.3", layers).join(), /missing row for b/);
  assert.match(checkDocs(doc("1.2.3", "| `a` | 0 | pa |\n| `b` | 2 | pb |"), "1.2.3", layers).join(), /b is layer 1, doc says 2/);
  assert.match(checkDocs(doc("1.2.3", ok + "\n| `z` | 3 | pz |"), "1.2.3", layers).join(), /unknown module z/);
});

const extra = (kv, dv) => ({
  versionConst: `export const STEWART_VERSION = "${kv}";`,
  diagram: `Rendered view of the code as built (v${dv}).`,
});

test("matching version.ts and diagram versions pass", () => {
  assert.deepEqual(checkDocs(doc("1.2.3", ok), "1.2.3", layers, extra("1.2.3", "1.2.3")), []);
});
test("drifting version.ts constant fails", () => {
  assert.match(checkDocs(doc("1.2.3", ok), "1.2.3", layers, extra("1.2.2", "1.2.3")).join(), /version\.ts: constant says 1\.2\.2/);
});
test("drifting or missing diagram version fails", () => {
  assert.match(checkDocs(doc("1.2.3", ok), "1.2.3", layers, extra("1.2.3", "9.9.9")).join(), /diagram: doc says 9\.9\.9/);
  assert.match(checkDocs(doc("1.2.3", ok), "1.2.3", layers, { versionConst: 'export const STEWART_VERSION = "1.2.3";', diagram: "no version here" }).join(), /diagram: doc says none/);
});
