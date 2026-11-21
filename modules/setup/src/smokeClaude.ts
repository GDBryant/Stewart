import type { AgentDef } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import { ToolRegistry } from "@stewart/tools";
import { lastText } from "./conformanceShared.js";
import { runBounded } from "./smoke.js";
import { SMOKE_MESSAGES, type SmokeOptions, type SmokeResult } from "./probeTypes.js";

const SMOKE_TURNS = 2;

export interface ClaudeSmoke {
  engine: Engine;
  agent: AgentDef;
  channel: ManagedChannel;
  /** Scratch cwd for the CLI subprocess; created and removed by the caller (after `onSettle` resolves). */
  dir: string;
}

type EngineAccum = { text: string; sawDone: boolean; sawTool: boolean; err?: string };

function smokeTurn(req: ClaudeSmoke, signal: AbortSignal): EngineTurn {
  return {
    sessionId: "smoke",
    transcript: [...SMOKE_MESSAGES],
    system: "",
    agent: req.agent,
    channel: req.channel,
    roleId: "setup",
    tools: new ToolRegistry([]),
    approve: async () => ({ kind: "rejected", reason: "not available in the smoke probe" }),
    state: {},
    cwd: req.dir,
    signal,
    maxTurns: SMOKE_TURNS,
  };
}

function accumulateEngine(ev: EngineEvent, acc: EngineAccum): void {
  if (ev.kind === "text") acc.text += ev.text;
  else if (ev.kind === "tool.request") acc.sawTool = true;
  else if (ev.kind === "finished") {
    acc.sawDone = true;
    if (ev.reason !== "stop") acc.err = `engine ${ev.reason}${ev.error ? `: ${ev.error}` : ""}`;
  }
}

function engineVerdict(acc: EngineAccum, turn: EngineTurn | undefined): SmokeResult {
  if (!acc.sawDone) return { state: "red", reason: "stream ended without completion" };
  if (acc.err) return { state: "red", reason: acc.err };
  const reply = acc.text.trim() ? acc.text : lastText(turn?.transcript ?? []);
  if (!reply.trim()) return { state: "red", reason: acc.sawTool ? "tool calls but no text" : "empty response" };
  return { state: "green" };
}

/**
 * One bounded liveness probe over the claude-code engine for `claude-cli` candidates
 * (the channel adapter's `chat()` is unsupported — the engine owns that transport).
 * Same verdicts as `smokeModel`: timeout -> orange, external cancel -> aborted, error or
 * unusable outcome -> red, a `finished: stop` turn with reply text -> green.
 */
export function smokeClaude(req: ClaudeSmoke, opts: SmokeOptions): Promise<SmokeResult> {
  const acc: EngineAccum = { text: "", sawDone: false, sawTool: false };
  let turn: EngineTurn | undefined;
  return runBounded<EngineEvent>(opts, {
    start: (signal) => {
      turn = smokeTurn(req, signal);
      return req.engine.run(turn);
    },
    accept: (ev) => accumulateEngine(ev, acc),
    verdict: () => engineVerdict(acc, turn),
  });
}
