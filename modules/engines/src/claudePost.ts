import { exitCause, isStartFailure } from "@stewart/kernel";
import { classify, type SpawnedProc } from "@stewart/channels";
import type { EngineEvent, EngineTurn } from "./types.js";
import type { ClaudeObs } from "./claudeContext.js";
import type { LoopGuard } from "./loopGuard.js";
import type { Obj } from "./claudeLines.js";

export interface Attempt {
  turn: EngineTurn;
  proc: SpawnedProc;
  obs: ClaudeObs;
  /** API message ids already streamed as deltas (their assistant text must not be re-emitted). */
  deltaIds: Set<string>;
  /** tool_use_id → name/input, filled from assistant blocks. */
  pending: Map<string, { name: string; input: Obj }>;
  result?: { subtype: string; isError: boolean; text: string };
  /** This attempt was spawned with --resume (id may be stale). */
  usedResume: boolean;
  /** Stdout lines seen on this attempt (a bare start failure produces none). */
  lines: number;
  /** argv[0] for error messages. */
  cli: string;
  guard: LoopGuard;
}

export interface PostAttempt {
  retry: boolean;
  ev?: EngineEvent;
  /** Stale --resume: drop the saved CLI session id before retrying. */
  dropSession?: boolean;
}

function finishedFor(a: Attempt): EngineEvent {
  const r = a.result;
  if (!r || r.subtype === "success") return { kind: "finished", reason: "stop" };
  if (r.subtype === "error_max_turns") return { kind: "finished", reason: "turn_limit" };
  if (r.isError || r.subtype.startsWith("error")) return { kind: "finished", reason: "error", error: r.text || r.subtype };
  return { kind: "finished", reason: "stop" };
}

/** True when a --resume attempt died because the CLI session id is stale. */
function staleResume(stderr: string, text: string): boolean {
  return /no conversation|conversation.{0,40}not found|could not resume|cannot resume|invalid.{0,20}session/i.test(`${stderr}\n${text}`);
}

function exitError(tail: string): EngineEvent {
  const detail = tail.trim() || "stream ended before completion";
  return { kind: "finished", reason: "error", error: classify(tail) === "auth" ? `Claude CLI not logged in: ${detail}` : `Claude CLI exited: ${detail}` };
}

/** The loop guard tripped: stop the CLI and finish as loop_guard. */
async function loopGuardEnd(a: Attempt, trip: string): Promise<PostAttempt> {
  a.proc.end?.();
  await a.proc.kill().catch(() => {});
  return { retry: false, ev: { kind: "finished", reason: "loop_guard", error: trip } };
}

/** A result line arrived: let the CLI exit (kill after 5 s); a stale --resume retries fresh. */
async function resultEnd(a: Attempt, r: NonNullable<Attempt["result"]>): Promise<PostAttempt> {
  a.proc.end?.();
  const exited = await Promise.race([a.proc.done.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 5000))]);
  if (!exited) await a.proc.kill().catch(() => {});
  if (a.usedResume && (r.isError || r.subtype.startsWith("error")) && staleResume("", r.text)) return { retry: true, dropSession: true };
  return { retry: false, ev: finishedFor(a) };
}

/** Decide what happens after one attempt: retry fresh, or emit the final event. */
export async function postAttempt(a: Attempt): Promise<PostAttempt> {
  if (a.turn.signal.aborted) return { retry: false, ev: { kind: "finished", reason: "cancelled" } };
  if (a.guard.trip) return await loopGuardEnd(a, a.guard.trip);
  if (a.result) return await resultEnd(a, a.result);
  const tail = (await a.proc.stderrText()).slice(-2000);
  const res = await a.proc.done;
  if (res.spawnError) return { retry: false, ev: { kind: "finished", reason: "error", error: `cannot start Claude CLI at ${a.cli}: ${res.spawnError}` } };
  if (a.usedResume && staleResume(tail, "")) return { retry: true, dropSession: true };
  if (isStartFailure(res.code) && a.lines === 0) {
    return { retry: true, ev: { kind: "finished", reason: "error", error: `Claude CLI ${exitCause(res.code)}` } };
  }
  return { retry: false, ev: exitError(tail) };
}
