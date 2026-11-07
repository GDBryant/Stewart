import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLayers } from "./check-layers.mjs";

const layers = { a: 0, b: 1, c: 1 };
const m = (name, deps = {}, exports = { ".": "./x" }) => ({ name: `@stewart/${name}`, dependencies: deps, exports });

test("downward dependency passes", () => {
  assert.deepEqual(checkLayers(layers, [m("a"), m("b", { "@stewart/a": "workspace:*" }), m("c")]), []);
});
test("same-layer and upward dependencies fail", () => {
  const e = checkLayers(layers, [m("a", { "@stewart/b": "workspace:*" }), m("b"), m("c", { "@stewart/b": "workspace:*" })]);
  assert.equal(e.length, 2);
});
test("unlisted package, missing package, extra exports fail", () => {
  assert.match(checkLayers(layers, [m("a"), m("b"), m("c"), m("z")]).join(), /z: not in layers/);
  assert.match(checkLayers(layers, [m("a"), m("b")]).join(), /no package for c/);
  assert.match(checkLayers(layers, [m("a", {}, { ".": "x", "./deep": "y" }), m("b"), m("c")]).join(), /exports must be/);
});
test("protocol dependency is allowed; unknown @stewart dep fails", () => {
  assert.deepEqual(checkLayers(layers, [m("a", { "@stewart/protocol": "1" }), m("b"), m("c")]), []);
  assert.match(checkLayers(layers, [m("a", { "@stewart/nope": "1" }), m("b"), m("c")]).join(), /unknown/);
});
