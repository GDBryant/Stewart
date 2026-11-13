import { createHash } from "node:crypto";

/** One finished tool call, as the loop guard sees it. */
export interface CallOutcome {
  name: string;
  args: unknown;
  ok: boolean;
  /** The tool result text (compared, never stored). */
  result: string;
}

/** Model turns in a row where every tool call failed. */
const FAIL_STREAK = 6;
/** The same call returning the same result this many times is no progress. */
const SAME_RESULT = 3;

function canonicalArgs(args: unknown): string {
  return JSON.stringify(args, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
}

/**
 * Stops a tool loop that makes no progress: the same failing call twice, the same call with the
 * same result three times, or six model turns in a row in which every call failed.
 * Shared by native-loop and claude-code.
 */
export class LoopGuard {
  private readonly fails = new Map<string, number>();
  private readonly repeats = new Map<string, number>();
  private streak = 0;
  private turnCalls = 0;
  private turnOk = false;
  trip?: string;

  record(o: CallOutcome): void {
    const key = `${o.name} ${canonicalArgs(o.args)}`;
    this.turnCalls++;
    if (o.ok) this.turnOk = true;
    else this.bump(this.fails, key, 2, `same call failed twice: ${key}`);
    const digest = createHash("sha1").update(`${o.ok}\u0000${o.result}`).digest("hex");
    this.bump(this.repeats, `${key}\u0000${digest}`, SAME_RESULT, `no progress: ${key} returned the same result ${SAME_RESULT} times`);
  }

  /** Close one model turn's batch of calls (counts the all-failed streak). */
  endTurn(): void {
    if (this.turnCalls === 0) return;
    this.streak = this.turnOk ? 0 : this.streak + 1;
    if (this.streak >= FAIL_STREAK) this.trip ??= `${FAIL_STREAK} consecutive model turns with no successful tool call`;
    this.turnCalls = 0;
    this.turnOk = false;
  }

  private bump(map: Map<string, number>, key: string, limit: number, reason: string): void {
    const n = (map.get(key) ?? 0) + 1;
    map.set(key, n);
    if (n >= limit) this.trip ??= reason;
  }
}
