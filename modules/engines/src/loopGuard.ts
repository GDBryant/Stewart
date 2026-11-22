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
/** The same call returning the same result this many times inside the window is no progress. */
const SAME_RESULT = 3;
/** The same call failing this many times inside the window is no progress. */
const SAME_FAIL = 3;
/** Only the last WINDOW calls count: healthy long runs legitimately repeat reads and retry failures. */
const WINDOW = 12;
/** A successful call to one of these changes the project, so the window restarts after it. */
const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

function canonicalArgs(args: unknown): string {
  return JSON.stringify(args, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
}

interface Seen {
  key: string;
  digest: string;
  ok: boolean;
}

function warnText(key: string): string {
  const k = key.length > 200 ? key.slice(0, 200) : key;
  return `[Stewart] ${k} was already called with these arguments and gave the same result. Do not repeat it: use that result or change approach. One more identical call ends this run.`;
}

/**
 * Stops a tool loop that makes no progress: the same call (tool name + canonical JSON args) failing
 * three times, the same call returning the same result three times, or six model turns in a row in
 * which every call failed. Repeats count inside the last 12 calls only, and a successful file-write
 * call clears that window (the project changed). `record` returns a warning on the second identical
 * result or failure — one more identical call then trips. Shared by native-loop and claude-code.
 */
export class LoopGuard {
  private readonly seen: Seen[] = [];
  private streak = 0;
  private turnCalls = 0;
  private turnOk = false;
  trip?: string;

  record(o: CallOutcome): string | undefined {
    const key = `${o.name} ${canonicalArgs(o.args)}`;
    this.turnCalls++;
    if (o.ok) this.turnOk = true;
    if (o.ok && WRITE_TOOLS.has(o.name)) this.seen.length = 0;
    const digest = createHash("sha1").update(`${o.ok} ${o.result}`).digest("hex");
    const sameResult = this.seen.filter((s) => s.key === key && s.digest === digest).length + 1;
    const sameFail = o.ok ? 0 : this.seen.filter((s) => s.key === key && !s.ok).length + 1;
    this.seen.push({ key, digest, ok: o.ok });
    if (this.seen.length > WINDOW) this.seen.shift();
    if (sameFail >= SAME_FAIL) this.trip ??= `same call failed ${SAME_FAIL} times: ${key}`;
    if (sameResult >= SAME_RESULT) this.trip ??= `no progress: ${key} returned the same result ${SAME_RESULT} times`;
    return sameFail === SAME_FAIL - 1 || sameResult === SAME_RESULT - 1 ? warnText(key) : undefined;
  }

  /** Close one model turn's batch of calls (counts the all-failed streak). */
  endTurn(): void {
    if (this.turnCalls === 0) return;
    this.streak = this.turnOk ? 0 : this.streak + 1;
    if (this.streak >= FAIL_STREAK) this.trip ??= `${FAIL_STREAK} consecutive model turns with no successful tool call`;
    this.turnCalls = 0;
    this.turnOk = false;
  }
}
