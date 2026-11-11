import { test } from "node:test";
import assert from "node:assert/strict";
import { findViolations, moduleOf, sizeFindings } from "./check-boundaries.mjs";

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

const lines = (n) => Array(n).fill("x").join("\n");
test("sizeFindings: under soft passes, soft-to-hard warns, over hard fails", () => {
  const r = sizeFindings({ "ok.ts": lines(3), "edge.ts": lines(5), "long.ts": lines(6), "huge.ts": lines(11) }, 5, 10);
  assert.deepEqual(r.warn, ["long.ts (6)"]);
  assert.deepEqual(r.fail, ["size huge.ts"]);
});
test("sizeFindings: exactly at hard limit is a warning, not a failure", () => {
  const r = sizeFindings({ "a.ts": lines(10) }, 5, 10);
  assert.deepEqual(r, { warn: ["a.ts (10)"], fail: [] });
});
