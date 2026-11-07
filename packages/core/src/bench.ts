import type { ManagedChannel } from "./channels/registry.js";
import { DEFAULT_CAPS, type ModelPerf, type ToolsMode } from "@stewart/models";
import type { AgentDef } from "./config/schema.js";
import { createAgentSession } from "./agentSession.js";
import type { Clock } from "@stewart/kernel";
import { ToolLoop } from "./tools/toolLoop.js";
import { ToolRegistry, type Tool } from "./tools/types.js";

/** Bump when the suite changes meaning; cached perf older than this is re-measured. */
export const BENCH_VERSION = 1;
const PROBE_CAP_MS = 30_000;
const TOOL_TRIALS = 3;

const approve = async () => ({ kind: "approved" as const });

const pingTool: Tool = {
  spec: {
    name: "bench_ping",
    description: "Test tool. Call it exactly once with ok=true, then stop.",
    parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  },
  requiresApproval: false,
  execute: async () => "pong",
};

const editProbeTool: Tool = {
  spec: {
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
  },
  requiresApproval: false,
  execute: async () => "edited",
};

/** Synthetic agent: the probe runs on the model's channel caps, not a configured agent. */
function benchLoop(channel: ManagedChannel, model: string, tools: Tool[], terminal: string, clock: Clock): ToolLoop {
  const agent: AgentDef = { id: "bench", channel: channel.cfg.id, model, effort: "medium" };
  return createAgentSession(
    {
      agent,
      channel,
      registry: new ToolRegistry(tools),
      approve,
      terminal: new Set([terminal]),
      limitsOverride: { maxModelTurns: 3 },
    },
    clock,
  ).loop;
}

/**
 * Opt-in benchmark: latency + throughput from one streamed request, tool-call
 * reliability and edit ability through the real ToolLoop (so shim-mode models
 * are measured on the same path they run on). Every field is best-effort — a
 * failed probe leaves it undefined, never zero.
 */
export async function benchModel(channel: ManagedChannel, model: string, clock: Clock): Promise<ModelPerf> {
  const perf: ModelPerf = { benchedAt: clock.now(), benchVersion: BENCH_VERSION };
  const mode = (channel.cfg.modelCaps?.[model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;

  try {
    const t0 = clock.now();
    let first = -1;
    let done = -1;
    let chars = 0;
    let out = 0;
    for await (const ev of channel.chat({
      model,
      messages: [{ role: "user", content: "Write a short paragraph (about 150 words) describing how a hash map works." }],
      maxTokens: 260,
      signal: AbortSignal.timeout(PROBE_CAP_MS),
    })) {
      if (ev.kind === "text") {
        if (first < 0) first = clock.now();
        chars += ev.text.length;
      }
      if (ev.kind === "done") {
        done = clock.now();
        out = ev.usage?.out ?? 0;
      }
    }
    if (first >= 0) perf.ttftMs = first - t0;
    const tokens = out > 0 ? out : Math.round(chars / 4);
    const genMs = (done >= 0 ? done : clock.now()) - (first >= 0 ? first : t0);
    if (tokens > 0 && genMs > 0) perf.tokPerSec = Math.round((tokens / genMs) * 100_000) / 100;
  } catch {
    /* speed probe failed: leave ttftMs/tokPerSec undefined */
  }

  if (mode !== "none") {
    try {
      let ok = 0;
      for (let i = 0; i < TOOL_TRIALS; i++) {
        let called = false;
        const r = await benchLoop(channel, model, [pingTool], "bench_ping", clock).run(
          model,
          [{ role: "user", content: 'Call the bench_ping tool exactly once with {"ok": true}. Do not write any other text.' }],
          { onToolOutcome: (c, o) => { if (c.name === "bench_ping" && o.kind === "success") called = true; } },
          AbortSignal.timeout(PROBE_CAP_MS),
        );
        if (r.kind === "failed") throw new Error(`bench call failed: ${r.message}`);
        if (called) ok++;
      }
      perf.toolReliability = Math.round((ok / TOOL_TRIALS) * 100) / 100;
    } catch {
      /* tool probe failed: leave undefined */
    }

    try {
      let edited = false;
      const body = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
      const r = await benchLoop(channel, model, [editProbeTool], "EditFile", clock).run(
        model,
        [{ role: "user", content: `A file notes.txt contains:\n${body}\nUse the EditFile tool to change "line3" to "three".` }],
        { onToolOutcome: (c, o) => { if (c.name === "EditFile" && o.kind === "success") edited = true; } },
        AbortSignal.timeout(PROBE_CAP_MS),
      );
      if (r.kind === "failed") throw new Error(`bench call failed: ${r.message}`);
      perf.editOk = edited;
    } catch {
      /* edit probe failed: leave undefined */
    }
  }

  try {
    let text = "";
    for await (const ev of channel.chat({
      model,
      messages: [{ role: "user", content: 'Reply with only this JSON object and nothing else: {"ok": true, "n": 1}' }],
      signal: AbortSignal.timeout(PROBE_CAP_MS),
    })) {
      if (ev.kind === "text") text += ev.text;
    }
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        const p = JSON.parse(text.slice(s, e + 1)) as { ok?: unknown; n?: unknown };
        perf.jsonOk = p?.ok === true && p?.n === 1;
      } catch {
        perf.jsonOk = false;
      }
    } else {
      perf.jsonOk = false;
    }
  } catch {
    /* json probe failed: leave undefined */
  }

  return perf;
}
