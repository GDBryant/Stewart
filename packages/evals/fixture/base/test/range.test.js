import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.js";

test("range excludes the end", () => {
  assert.deepEqual(range(0, 3), [0, 1, 2]);
  assert.deepEqual(range(2, 5), [2, 3, 4]);
});

test("empty range", () => {
  assert.deepEqual(range(3, 3), []);
});
