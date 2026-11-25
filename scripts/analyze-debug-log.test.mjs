import test from "node:test";
import assert from "node:assert/strict";
import { analyze, format, outgoingFacts, parseLine, usageOf } from "./analyze-debug-log.mjs";

const line = (ts, dir, payload) => `[${ts}] [${dir}] [openai-compatible] [m] [${payload}]`;
const T = (s) => new Date(Date.UTC(2026, 10, 25, 7, 0, s)).toISOString();
const out = (s, messages) => parseLine(line(T(s), "outgoing", JSON.stringify({ model: "m", messages })));
const inc = (s, u) => parseLine(line(T(s), "incoming", JSON.stringify({ choices: [], usage: u })));
const readCall = (path) => ({ role: "assistant", content: "", tool_calls: [{ function: { name: "ReadFile", arguments: JSON.stringify({ path }) } }] });

test("parseLine parses records and rejects junk", () => {
  assert.equal(parseLine("not a record"), null);
  const r = parseLine(line(T(0), "incoming", "a\\nb"));
  assert.equal(r.dir, "incoming");
  assert.equal(r.payload, "a\nb");
});

test("usageOf reads top-level and nested reasoning tokens; ignores non-usage", () => {
  assert.deepEqual(usageOf('{"usage":{"prompt_tokens":5,"completion_tokens":9,"reasoning_tokens":7}}'), { prompt: 5, completion: 9, reasoning: 7 });
  assert.equal(usageOf('{"usage":{"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":4}}}').reasoning, 4);
  assert.equal(usageOf('{"choices":[]}'), undefined);
  assert.equal(usageOf('{"usage":{"prompt_tokens":1}}'), undefined);
});

test("outgoingFacts flags compaction requests and reads of the last assistant message", () => {
  const f = outgoingFacts(JSON.stringify({ messages: [{ role: "system", content: "Summarise the conversation so far for x" }, { role: "user", content: "." }] }));
  assert.equal(f.compaction, true);
  const g = outgoingFacts(JSON.stringify({ messages: [{ role: "system", content: "sys" }, readCall("a.ts")] }));
  assert.deepEqual(g.reads, ["a.ts"]);
  assert.equal(g.compaction, false);
  assert.deepEqual(outgoingFacts("{bad").reads, []);
});

test("analyze totals tokens, compaction, repeat reads and window overruns", () => {
  const recs = [
    out(0, [{ role: "system", content: "s" }]),
    inc(10, { prompt_tokens: 40_000, completion_tokens: 100, reasoning_tokens: 80 }),
    out(11, [{ role: "system", content: "s" }, readCall("a.ts")]),
    inc(15, { prompt_tokens: 1000, completion_tokens: 100, reasoning_tokens: 20 }),
    out(16, [{ role: "system", content: "Summarise the conversation so far" }]),
    inc(26, { prompt_tokens: 500, completion_tokens: 50, reasoning_tokens: 0 }),
    out(27, [{ role: "system", content: "s" }, readCall("a.ts")]),
    inc(30, { prompt_tokens: 900, completion_tokens: 10, reasoning_tokens: 0 }),
  ];
  const [r, ...rest] = analyze(recs);
  assert.equal(rest.length, 0);
  assert.equal(r.requests, 4);
  assert.equal(r.modelS, 10 + 4 + 10 + 3);
  assert.equal(r.reasoningTokens, 100);
  assert.equal(r.reasoningShare, +(100 / 260).toFixed(3));
  assert.equal(r.compactions, 1);
  assert.equal(r.compactionS, 10);
  assert.equal(r.requestsOverWindow, 1);
  assert.equal(r.maxPromptTokens, 40_000);
  assert.equal(r.repeatReads, 1);
  assert.equal(r.topRepeatReads[0].path, "a.ts");
  assert.equal(r.slowest[0].ms, 10_000);
  assert.match(format([r]), /run 1: 4 req/);
});

test("a long pause starts a new run; empty input yields no runs", () => {
  const recs = [out(0, []), inc(5, { prompt_tokens: 1, completion_tokens: 1 }), out(5000, []), inc(5005, { prompt_tokens: 1, completion_tokens: 1 })];
  assert.equal(analyze(recs).length, 2);
  assert.equal(analyze(recs, { gapS: 99_999 }).length, 1);
  assert.deepEqual(analyze([]), []);
});

test("parseLine unescapes in one pass: an escaped backslash before n stays a backslash and n", () => {
  assert.equal(parseLine(line(T(0), "incoming", "a\\\\nb")).payload, "a\\nb");
  assert.equal(parseLine(line(T(0), "incoming", "x\\ty")).payload, "x\ty");
});
