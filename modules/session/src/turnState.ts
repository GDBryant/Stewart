import path from "node:path";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { WriteRecord } from "@stewart/engines";
import type { CheckInput, CheckResult } from "@stewart/tasks";
import type { DeclaredCheck } from "./sessionTools.js";
import type { Tried } from "./handover.js";

export type FinishReason = "stop" | "turn_limit" | "cancelled" | "loop_guard" | "error" | "";

/** Mutable state of one lead turn, shared with its children. */
export interface RunState {
  controller: AbortController;
  seq: number;
  writes: WriteRecord[];
  accrued: number;
  reason: FinishReason;
  error?: string;
  costCapped: boolean;
  tried: Tried[];
  /** File content before its first write this turn (null = absent), keyed by project-relative path. */
  before: Record<string, string | null>;
  /** The lead's `set_check` declaration. */
  declared: { value?: DeclaredCheck };
  /** The turn's user request, for report/edit detection. */
  goal: string;
  /** Successful read/search tool calls this turn (a "no findings" report must have looked). */
  reads: number;
  /** Last check result and the write count it saw, reused by `finish` when nothing changed since. */
  lastCheck?: { res: CheckResult; writes: number; declared?: DeclaredCheck };
}

export function newRunState(goal: string): RunState {
  return { controller: new AbortController(), seq: 0, writes: [], accrued: 0, reason: "", costCapped: false, tried: [], before: {}, declared: {}, goal, reads: 0 };
}

export function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Project-relative, forward-slash form of a tool path (engines report absolute CLI paths relative). */
export function relPath(cwd: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "") || ".";
}

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["path", "file_path", "notebook_path"];

/** The project-relative path a write tool call targets, or undefined for non-write tools. */
export function writeTarget(cwd: string, tool: string, args: unknown): string | undefined {
  if (!WRITE_TOOLS.has(tool)) return undefined;
  const a = (args ?? {}) as Record<string, unknown>;
  const key = PATH_KEYS.find((k) => typeof a[k] === "string");
  return key ? relPath(cwd, a[key] as string) : undefined;
}

export interface SnapTarget {
  host: Pick<HostPort, "files">;
  cwd: string;
  before: Record<string, string | null>;
  /** Also told about every first write (plan checkpoints keep pre-write content). */
  onFirst?: (path: string, content: string | null) => void | Promise<void>;
}

/** Remember a file's content before the first write to it (best effort; unreadable = no snapshot). */
export async function snapshotBefore(t: SnapTarget, tool: string, args: unknown): Promise<void> {
  const p = writeTarget(t.cwd, tool, args);
  if (p === undefined || p in t.before) return;
  try {
    t.before[p] = (await t.host.files.exists(p)) ? (await t.host.files.read(p)).content : null;
    await t.onFirst?.(p, t.before[p]);
  } catch {
    /* no snapshot: the changed-content check skips this path */
  }
}

const READ_TOOLS = new Set(["delegate", "ReadFile", "ListCodeFiles", "FindFiles", "Search", "GetDiff", "CodeMetrics", "GetProblems", "Read", "Grep", "Glob", "LS"]);

/** True for tools whose success means the agent looked at the project. */
export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

export function lastUserText(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/** The turn's reply (last assistant text after the last user message) and its write facts. */
export function checkInput(transcript: ChatMessage[], rs: RunState): CheckInput {
  let reply = "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && m.content.trim()) {
      reply = m.content;
      break;
    }
    if (m.role === "user") break;
  }
  const changed = [...new Set(rs.writes.filter((w) => w.ok).map((w) => w.path))];
  return { reply, writes: rs.writes, changed, before: rs.before, reads: rs.reads };
}

export function finishedEvent(runId: string, rs: RunState, res: CheckResult): RunEvent {
  if (rs.costCapped) return { kind: "run.finished", runId, roleId: "lead", status: "failed", error: "cost cap reached" };
  if (rs.reason === "cancelled") return { kind: "run.finished", runId, roleId: "lead", status: "cancelled" };
  if (rs.reason === "stop" && res.passed) return { kind: "run.finished", runId, roleId: "lead", status: "done" };
  const error = rs.error ?? (res.passed ? rs.reason || "failed" : res.evidence.join("; "));
  return { kind: "run.finished", runId, roleId: "lead", status: "failed", error };
}
