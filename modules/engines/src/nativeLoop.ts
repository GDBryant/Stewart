import type { ToolCall } from "@stewart/kernel";
import { ToolRegistry } from "@stewart/tools";
import type { Engine, EngineEvent, EngineTurn } from "./types.js";
import { ReadGuard } from "./readGuard.js";
import { ExploreGuard } from "./exploreGuard.js";
import { LoopGuard } from "./loopGuard.js";
import { runFunction } from "./functionRun.js";
import { ReasoningPolicy } from "./reasoningPolicy.js";
import { modelTurn, type ModelOut } from "./nativeModel.js";
import { executeBatch, isParallel, readGuards, type Seen } from "./nativeToolExec.js";
import { budgetTurn, dropCalls } from "./nativeBudget.js";

/** The provider's prompt-token count for a request that sent `len` transcript messages, when it reported one. */
function measuredOf(out: ModelOut, len: number): { tokens: number; len: number } | undefined {
  return out.inTokens > 0 ? { tokens: out.inTokens, len } : undefined;
}

async function* run(raw: EngineTurn): AsyncGenerator<EngineEvent, void> {
  const turn = raw.hostTools ? { ...raw, tools: new ToolRegistry([...raw.tools.tools, ...raw.hostTools.tools]) } : raw;
  const g = newGuards(turn);
  const guard = g.loop;
  const policy = g.policy;
  const reads = new ReadGuard();
  readGuards.set(turn, reads);
  let measured: { tokens: number; len: number } | undefined;
  for (let n = 0; n < turn.maxTurns; n++) {
    if (turn.signal.aborted) {
      yield { kind: "finished", reason: "cancelled" };
      return;
    }
    reads.turn = n;
    if (await turn.beforeModelTurn?.({ measured })) measured = undefined;
    const salvage = budgetTurn(turn, n);
    const sentLen = turn.transcript.length;
    const out = yield* modelTurn(turn, policy, salvage);
    if (!out) return;
    measured = measuredOf(out, sentLen);
    if (salvage) {
      dropCalls(turn);
      break;
    }
    if (!out.calls.length) {
      yield { kind: "finished", reason: "stop" };
      return;
    }
    yield* runBatches(turn, out.calls, g);
    if (guard.trip) {
      yield { kind: "finished", reason: "loop_guard", error: guard.trip };
      return;
    }
    if (turn.signal.aborted) {
      yield { kind: "finished", reason: "cancelled" };
      return;
    }
  }
  yield { kind: "finished", reason: "turn_limit" };
}

/** Per-run guards the loop consults after each batch of tool calls. */
interface Guards {
  loop: LoopGuard;
  policy: ReasoningPolicy;
  explore: ExploreGuard;
}

function newGuards(turn: EngineTurn): Guards {
  const canWrite = ["WriteFile", "EditFile", "ApplyPatch"].some((t) => turn.tools.find(t));
  return { loop: new LoopGuard(), policy: new ReasoningPolicy(), explore: new ExploreGuard({ root: turn.cwd, canWrite }) };
}

async function* runBatches(turn: EngineTurn, calls: ToolCall[], g: Guards): AsyncGenerator<EngineEvent, void> {
  const seen = new Map<string, Seen>();
  for (let i = 0; i < calls.length; ) {
    let j = i;
    while (j < calls.length && isParallel(turn, calls[j]) === isParallel(turn, calls[i])) j++;
    const batch = calls.slice(i, j);
    i = j;
    if (turn.signal.aborted) {
      for (const call of batch) turn.transcript.push({ role: "tool", toolCallId: call.id, content: "Not executed: cancelled" });
    } else {
      yield* executeBatch(turn, batch, seen);
    }
  }
  const { warnings, nudges } = collectWarnings(seen, g);
  for (const w of nudges) yield { kind: "diag", tag: "exploration_nudge", detail: w.slice(0, 160) };
  g.policy.observe([...seen.values()], warnings.length > 0);
  if (warnings.length && !g.loop.trip) turn.transcript.push({ role: "user", content: warnings.join("\n") });
}

/** Loop-guard warnings and exploration nudges for one finished batch; `nudges` are the exploration ones (also logged). */
function collectWarnings(seen: Map<string, Seen>, g: Guards): { warnings: string[]; nudges: string[] } {
  const warnings: string[] = [];
  const nudges: string[] = [];
  for (const { call, ok, result } of seen.values()) {
    const w = g.loop.record({ name: call.name, args: call.arguments, ok, result });
    if (w) warnings.push(w);
    const nudge = g.explore.record(call, ok);
    if (nudge) nudges.push(nudge);
  }
  g.loop.endTurn();
  const stall = g.explore.endTurn();
  if (stall) nudges.push(stall);
  return { warnings: [...warnings, ...nudges], nudges };
}

/** Stewart's own tool loop over a channel's native tool calling. */
export const nativeLoop: Engine = { id: "native-loop", caps: { ownTools: false, ownContext: false }, run, complete: runFunction };
