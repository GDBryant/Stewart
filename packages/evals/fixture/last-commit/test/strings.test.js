import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize, truncate, words } from "../src/strings.js";

test("capitalize upper-cases the first character", () => {
  assert.equal(capitalize("hello"), "Hello");
});

test("words splits on whitespace", () => {
  assert.deepEqual(words("  a b\tc "), ["a", "b", "c"]);
});

test("truncate shortens long text with an ellipsis", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});
