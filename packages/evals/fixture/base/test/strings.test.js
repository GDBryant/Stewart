import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize, words } from "../src/strings.js";

test("capitalize upper-cases the first character", () => {
  assert.equal(capitalize("hello"), "Hello");
});

test("words splits on whitespace", () => {
  assert.deepEqual(words("  a b\tc "), ["a", "b", "c"]);
});
