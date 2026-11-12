import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";

test("parses hours, minutes and seconds", () => {
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1m30s"), 90);
});

test("rejects malformed input", () => {
  assert.throws(() => parseDuration("10x"));
});
