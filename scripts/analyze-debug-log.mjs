#!/usr/bin/env node
// Per-run efficiency report from a Stewart debug log (see docs/ai_docs/DEBUG_LOGGING.md).
// Usage: node scripts/analyze-debug-log.mjs <yyyy-MM-dd.log> [--gap <seconds>] [--json]
// Reports per run: requests, model time, completion/reasoning tokens, compactions, repeat file reads, slowest requests.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const LINE = /^\[([^\]]+)\] \[(outgoing|incoming|error)\] \[[^\]]*\] \[[^\]]*\] \[(.*)\]$/s;
const SUMMARY_MARK = "Summarise the conversation so far";
const READ_TOOLS = new Set(["ReadFile", "Read"]);
/** A pause this long between a response and the next request starts a new run. */
export const RUN_GAP_S = 900;

/** Parses one log line; null when it is not a record. */
export function parseLine(line) {
  const m = LINE.exec(line);
  return m ? { ts: Date.parse(m[1]), dir: m[2], payload: m[3].replace(/\\([\\nrt])/g, (_m, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : "\\")) } : null;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Facts from an outgoing request body: compaction flag and file paths read by the previous response's tool calls. */
export function outgoingFacts(payload) {
  const j = safeJson(payload);
  if (!j || !Array.isArray(j.messages)) return { compaction: false, reads: [] };
  const first = j.messages[0];
  const compaction = first?.role === "system" && typeof first.content === "string" && first.content.startsWith(SUMMARY_MARK);
  let last;
  for (let i = j.messages.length - 1; i >= 0; i--) if (j.messages[i].role === "assistant") { last = j.messages[i]; break; }
  const reads = [];
  for (const c of last?.tool_calls ?? []) {
    const args = safeJson(c.function?.arguments ?? "");
    if (READ_TOOLS.has(c.function?.name) && typeof args?.path === "string") reads.push(args.path);
  }
  return { compaction, reads, promptChars: JSON.stringify(j.messages).length };
}

/** Usage from an incoming chunk, or undefined. Reasoning tokens ride top-level or in completion_tokens_details. */
export function usageOf(payload) {
  if (!payload.includes('"usage"')) return undefined;
  const u = safeJson(payload)?.usage;
  if (!u || typeof u.completion_tokens !== "number") return undefined;
  return { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens, reasoning: u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0 };
}

const emptyRun = () => ({ requests: 0, startTs: 0, endTs: 0, modelMs: 0, completion: 0, reasoning: 0, compactions: 0, compactionMs: 0, maxPrompt: 0, overWindow: 0, reads: new Map(), slow: [] });

/** Folds an ordered record stream into runs. `window` (tokens) counts requests whose prompt exceeded it. */
export function analyze(records, { gapS = RUN_GAP_S, window = 32_768 } = {}) {
  const runs = [];
  let run;
  let pending; // the outgoing request awaiting its usage chunk
  let lastEnd = 0;
  for (const r of records) {
    if (r.dir === "outgoing") {
      if (!run || (lastEnd && r.ts - lastEnd > gapS * 1000)) runs.push((run = emptyRun()));
      if (!run.startTs) run.startTs = r.ts;
      const f = outgoingFacts(r.payload);
      for (const p of f.reads) run.reads.set(p, (run.reads.get(p) ?? 0) + 1);
      pending = { ts: r.ts, compaction: f.compaction };
    } else if (r.dir === "incoming" && pending && run) {
      const u = usageOf(r.payload);
      if (!u) continue;
      const ms = Math.max(0, r.ts - pending.ts);
      run.requests++;
      run.modelMs += ms;
      run.completion += u.completion;
      run.reasoning += u.reasoning;
      run.maxPrompt = Math.max(run.maxPrompt, u.prompt);
      if (u.prompt > window) run.overWindow++;
      if (pending.compaction) {
        run.compactions++;
        run.compactionMs += ms;
      }
      run.slow.push({ ts: new Date(pending.ts).toISOString(), ms, completion: u.completion, reasoning: u.reasoning });
      run.endTs = lastEnd = r.ts;
      pending = undefined;
    }
  }
  return runs.filter((x) => x.requests > 0).map(summarise);
}

function summarise(r) {
  const repeats = [...r.reads].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return {
    requests: r.requests,
    wallS: Math.round((r.endTs - r.startTs) / 1000),
    modelS: Math.round(r.modelMs / 1000),
    completionTokens: r.completion,
    reasoningTokens: r.reasoning,
    reasoningShare: r.completion ? +(r.reasoning / r.completion).toFixed(3) : 0,
    compactions: r.compactions,
    compactionS: Math.round(r.compactionMs / 1000),
    compactionShare: r.modelMs ? +(r.compactionMs / r.modelMs).toFixed(3) : 0,
    requestsPerCompaction: r.compactions ? +(r.requests / r.compactions).toFixed(1) : null,
    maxPromptTokens: r.maxPrompt,
    requestsOverWindow: r.overWindow,
    repeatReads: repeats.reduce((n, [, c]) => n + c - 1, 0),
    topRepeatReads: repeats.slice(0, 5).map(([path, count]) => ({ path, count })),
    slowest: r.slow.sort((a, b) => b.ms - a.ms).slice(0, 5),
  };
}

export function format(runs) {
  return runs
    .map((r, i) => `run ${i + 1}: ${r.requests} req, wall ${r.wallS}s, model ${r.modelS}s, reasoning ${(r.reasoningShare * 100).toFixed(0)}% of ${r.completionTokens} tok, compactions ${r.compactions} (${r.compactionS}s, ${(r.compactionShare * 100).toFixed(0)}% of model time), max prompt ${r.maxPromptTokens}, over window ${r.requestsOverWindow}, repeat reads ${r.repeatReads}`)
    .join("\n");
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--gap");
  if (!file) {
    console.error("usage: analyze-debug-log.mjs <log> [--gap <seconds>] [--json]");
    process.exit(2);
  }
  const g = argv.indexOf("--gap");
  const records = [];
  for await (const line of createInterface({ input: createReadStream(file) })) {
    const r = parseLine(line);
    if (r) records.push(r);
  }
  const runs = analyze(records, g >= 0 ? { gapS: Number(argv[g + 1]) } : {});
  console.log(argv.includes("--json") ? JSON.stringify(runs, null, 2) : format(runs));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
