import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFiles, findFailures, nextBaseline } from "./check-functions.mjs";

const L = { lines: 40, complexity: 3, depth: 2, params: 3 };
const scan = (src) => scanFiles({ "a.ts": src });

test("measures complexity, depth, params and skips nested functions", () => {
  const m = scan(`function f(a, b, c, d) { if (a && b) { for (const x of c) { if (x) return 1; } } const g = () => { if (a) if (b) return 2; }; return d ? 1 : 0; }`);
  assert.deepEqual({ ...m["a.ts::f"], line: 0 }, { line: 0, lines: 1, complexity: 6, depth: 3, params: 4 });
  assert.equal(m["a.ts::g"].complexity, 3);
});
test("else-if chains do not deepen nesting; duplicate names get a suffix", () => {
  const m = scan(`function f(a) { if (a) {} else if (a > 1) {} else if (a > 2) {} }\nfunction h() {}\nconst o = { h() {} };`);
  assert.equal(m["a.ts::f"].depth, 1);
  assert.ok(m["a.ts::h"] && m["a.ts::h#2"]);
});
test("a new function over a limit fails; a clean one passes", () => {
  const found = scan(`function f(a) { if (a) {} if (a) {} if (a) {} }\nfunction g() {}`);
  assert.match(findFailures(found, {}, L).join(), /a\.ts::f complexity 4 > 3/);
  assert.equal(findFailures(found, {}, L).some((x) => x.includes("::g")), false);
});
test("a baselined offender may stay but not grow", () => {
  const found = scan(`function f(a) { if (a) {} if (a) {} if (a) {} }`);
  assert.deepEqual(findFailures(found, { "a.ts::f": { lines: 1, complexity: 4, depth: 1, params: 1 } }, L), []);
  assert.match(findFailures(found, { "a.ts::f": { lines: 1, complexity: 3, depth: 1, params: 1 } }, L).join(), /complexity 4 > baseline 3/);
});
test("update drops fixed entries and never adds new ones", () => {
  const found = scan(`function f(a) { if (a) {} }\nfunction g(a) { if (a) {} if (a) {} if (a) {} }`);
  const base = { "a.ts::f": { lines: 1, complexity: 9, depth: 1, params: 1 }, "gone.ts::x": { lines: 1, complexity: 9, depth: 1, params: 1 } };
  assert.deepEqual(nextBaseline(found, base, L), {});
  assert.deepEqual(Object.keys(nextBaseline(found, { ...base, "a.ts::g": base["a.ts::f"] }, L)), ["a.ts::g"]);
});
