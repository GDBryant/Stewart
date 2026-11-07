import { test } from "node:test";
import assert from "node:assert/strict";
import { findViolations, moduleOf } from "./check-boundaries.mjs";

const cfg = { map: [["a.ts", "low"], ["b/", "high"]], appLayer: 9, maxLines: 3 };
const layers = { low: 1, high: 2 };

test("moduleOf: exact, prefix, default app", () => {
  assert.equal(moduleOf("a.ts", cfg.map), "low");
  assert.equal(moduleOf("b/x.ts", cfg.map), "high");
  assert.equal(moduleOf("zzz.ts", cfg.map), "app");
});
test("downward import ok; upward import and oversize file flagged", () => {
  assert.deepEqual(findViolations({ "b/x.ts": 'import {a} from "../a.js";', "a.ts": "x" }, cfg, layers), []);
  const v = findViolations({ "a.ts": 'import {x} from "./b/x.js";\n\n\n\n', "b/x.ts": "" }, cfg, layers);
  assert.deepEqual(v, ["import a.ts -> high", "size a.ts"]);
});
test("same-module import is fine", () => {
  assert.deepEqual(findViolations({ "b/x.ts": 'import {y} from "./y.js";', "b/y.ts": "" }, cfg, layers), []);
});
