import type { ChatMessage } from "@stewart/kernel";
import type { WriteRecord } from "@stewart/engines";
import type { Baseline, CheckResult } from "@stewart/tasks";
import type { Tried } from "./handover.js";

/** One contract command: argv run at verify time; `approved` commands skip the permission gate. */
export interface ContractCommand {
  argv: string[];
  approved: boolean;
  /** Run only when the task changed files (diff non-empty or unknown). */
  whenChanged?: boolean;
}

/** The explicit verify contract of a task: commands that must exit 0 and files that must exist. */
export interface Contract {
  commands: ContractCommand[];
  files: string[];
}

export type FinishReason = "stop" | "turn_limit" | "cancelled" | "loop_guard" | "error" | "";

/** Run-wide mutable state shared by the lead turn and its children (cost, cancellation, event ordering). */
export interface RunState {
  controller: AbortController;
  seq: number;
  accrued: number;
  costCapped: boolean;
}

/** Per-task facts one runTask accumulates (the lead turn is one task; each delegated child is another). */
export interface TaskState {
  writes: WriteRecord[];
  tried: Tried[];
  reads: number;
  reason: FinishReason;
  error?: string;
}

/** Repairs a transcript interrupted mid tool batch: unanswered calls of the last open batch get a tool message each. */
export function closeOpenCalls(transcript: ChatMessage[]): void {
  const tail = transcript[transcript.length - 1];
  if (!tail || tail.role === "user" || (tail.role === "assistant" && !tail.toolCalls?.length)) return;
  const ai = transcript.map((m, i) => (m.role === "assistant" && m.toolCalls?.length ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  if (ai < 0) return;
  const answered = new Set(transcript.slice(ai + 1).filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const c of (transcript[ai] as { toolCalls: { id: string }[] }).toolCalls) {
    if (!answered.has(c.id)) transcript.push({ role: "tool", toolCallId: c.id, content: "Interrupted: the session ended before this call finished" });
  }
}

export function newRunState(): RunState {
  return { controller: new AbortController(), seq: 0, accrued: 0, costCapped: false };
}

export function newTaskState(): TaskState {
  return { writes: [], tried: [], reads: 0, reason: "" };
}

export function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/** The task's reply: last non-empty assistant text after the last user message. */
export function lastReply(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && m.content.trim()) return m.content;
    if (m.role === "user") break;
  }
  return "";
}

export type RunOutcome = { changed: string[]; verified: "command" | "files" | "none"; command?: string; tracking?: "unavailable"; trackingReason?: string };

/** How the finished run changed files and how that was verified, from the contract and last check. */
export function runOutcome(contract: Contract, res: CheckResult | undefined, changed: string[] | undefined, baseline: Baseline): RunOutcome {
  const out: RunOutcome = { changed: changed ?? [], verified: "none" };
  if (baseline.kind === "unavailable") return { ...out, tracking: "unavailable", trackingReason: baseline.reason };
  const ran = res?.evidence.some((e) => e.code === "command_ok" || e.code === "command_failed" || e.code === "command_timeout");
  if (res?.passed && ran) return { ...out, verified: "command", command: contract.commands.map((c) => c.argv.join(" ")).join("; ") };
  if (res?.passed && !ran && contract.files.length) return { ...out, verified: "files" };
  return out;
}
