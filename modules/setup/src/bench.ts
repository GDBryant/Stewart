import type { ManagedChannel } from "@stewart/channels";
import type { ChatEvent } from "@stewart/channels";
import { capsFor, type ModelPerf, type ProbeLoop } from "@stewart/models";
import type { Clock, ToolSpec } from "@stewart/kernel";

/** Bump when the suite changes meaning; cached perf older than this is re-measured. */
export const BENCH_VERSION = 1;
const PROBE_CAP_MS = 30_000;
const TOOL_TRIALS = 3;

const pingTool: ToolSpec = {
  name: "bench_ping",
  description: "Test tool. Call it exactly once with ok=true, then stop.",
  parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};

const editProbeTool: ToolSpec = {
  name: "EditFile",
  description: "Replace text in a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

type BenchDeps = { channel: ManagedChannel; model: string; clock: Clock; probe: ProbeLoop<ManagedChannel> };
type BenchStep = "speed" | "tools" | "edit" | "json";

/** Timestamps (clock ms; -1 = not seen) and counts from one streamed request. `now` is read after the stream ends. */
type SpeedSample = { t0: number; first: number; done: number; chars: number; out: number; now: number };

function summarizePerf(s: SpeedSample): Pick<ModelPerf, "ttftMs" | "tokPerSec"> {
  const perf: Pick<ModelPerf, "ttftMs" | "tokPerSec"> = {};
  if (s.first >= 0) perf.ttftMs = s.first - s.t0;
  const tokens = s.out > 0 ? s.out : Math.round(s.chars / 4);
  const genMs = (s.done >= 0 ? s.done : s.now) - (s.first >= 0 ? s.first : s.t0);
  if (tokens > 0 && genMs > 0) perf.tokPerSec = Math.round((tokens / genMs) * 100_000) / 100;
  return perf;
}

function observeSpeed(ev: ChatEvent, s: SpeedSample, clock: Clock): void {
  if (ev.kind === "text") {
    if (s.first < 0) s.first = clock.now();
    s.chars += ev.text.length;
  } else if (ev.kind === "done") {
    s.done = clock.now();
    s.out = ev.usage?.out ?? 0;
  }
}

async function collectSpeed(d: BenchDeps): Promise<SpeedSample> {
  const s: SpeedSample = { t0: d.clock.now(), first: -1, done: -1, chars: 0, out: 0, now: 0 };
  for await (const ev of d.channel.chat({
    model: d.model,
    messages: [{ role: "user", content: "Write a short paragraph (about 150 words) describing how a hash map works." }],
    maxTokens: 260,
    signal: AbortSignal.timeout(PROBE_CAP_MS),
  })) {
    observeSpeed(ev, s, d.clock);
  }
  s.now = d.clock.now();
  return s;
}

async function measureSpeed(d: BenchDeps): Promise<Partial<ModelPerf>> {
  try {
    return summarizePerf(await collectSpeed(d));
  } catch {
    return {};
  }
}

async function measureTools(d: BenchDeps): Promise<Partial<ModelPerf>> {
  try {
    let ok = 0;
    for (let i = 0; i < TOOL_TRIALS; i++) {
      const r = await d.probe(d.channel, {
        model: d.model,
        tool: pingTool,
        reply: "pong",
        prompt: 'Call the bench_ping tool exactly once with {"ok": true}. Do not write any other text.',
        maxTurns: 3,
        timeoutMs: PROBE_CAP_MS,
      });
      if (r.kind === "failed") throw new Error(r.message);
      if (r.toolOk) ok++;
    }
    return { toolReliability: Math.round((ok / TOOL_TRIALS) * 100) / 100 };
  } catch {
    return {};
  }
}

async function measureEdit(d: BenchDeps): Promise<Partial<ModelPerf>> {
  try {
    const body = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const r = await d.probe(d.channel, {
      model: d.model,
      tool: editProbeTool,
      reply: "edited",
      prompt: `A file notes.txt contains:\n${body}\nUse the EditFile tool to change "line3" to "three".`,
      maxTurns: 3,
      timeoutMs: PROBE_CAP_MS,
    });
    if (r.kind === "failed") throw new Error(r.message);
    return { editOk: r.toolOk };
  } catch {
    return {};
  }
}

async function measureJson(d: BenchDeps): Promise<Partial<ModelPerf>> {
  try {
    let text = "";
    for await (const ev of d.channel.chat({
      model: d.model,
      messages: [{ role: "user", content: 'Reply with only this JSON object and nothing else: {"ok": true, "n": 1}' }],
      signal: AbortSignal.timeout(PROBE_CAP_MS),
    })) {
      if (ev.kind === "text") text += ev.text;
    }
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) return { jsonOk: false };
    try {
      const p = JSON.parse(text.slice(s, e + 1)) as { ok?: unknown; n?: unknown };
      return { jsonOk: p?.ok === true && p?.n === 1 };
    } catch {
      return { jsonOk: false };
    }
  } catch {
    return {};
  }
}

const BENCH_STEPS: Record<BenchStep, (d: BenchDeps) => Promise<Partial<ModelPerf>>> = {
  speed: measureSpeed,
  tools: measureTools,
  edit: measureEdit,
  json: measureJson,
};

/**
 * Opt-in benchmark: latency + throughput from one streamed request, tool-call
 * reliability and edit ability through the injected ProbeLoop (so shim-mode models
 * are measured on the same path they run on). Every field is best-effort — a
 * failed probe leaves it undefined, never zero.
 */
export async function benchModel(channel: ManagedChannel, model: string, clock: Clock, probe: ProbeLoop<ManagedChannel>): Promise<ModelPerf> {
  const perf: ModelPerf = { benchedAt: clock.now(), benchVersion: BENCH_VERSION };
  const mode = capsFor(channel.cfg, model).tools;
  const deps: BenchDeps = { channel, model, clock, probe };
  const steps: BenchStep[] = mode === "none" ? ["speed", "json"] : ["speed", "tools", "edit", "json"];
  for (const step of steps) Object.assign(perf, await BENCH_STEPS[step](deps));
  return perf;
}
