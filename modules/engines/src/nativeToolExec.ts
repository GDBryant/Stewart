import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { errorMessage } from "@stewart/kernel";
import { categoryOf, type ToolPreview } from "@stewart/permissions";
import { outcomeMessage, type Tool, type ToolOutcome } from "@stewart/tools";
import type { EngineEvent, EngineTurn } from "./types.js";
import { capOutput, outputCap } from "./outputCap.js";
import type { ReadGuard } from "./readGuard.js";

export interface Seen {
  call: ToolCall;
  ok: boolean;
  result: string;
}

const TOOL_TIMEOUT_MS = 120_000;
const SUMMARY_CAP = 200;
/** Per-run re-read guard, keyed by the turn object the loop runs. */
export const readGuards = new WeakMap<EngineTurn, ReadGuard>();
const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);

function summaryOf(outcome: ToolOutcome): string {
  const first = outcomeMessage(outcome).split("\n")[0];
  return first.length > SUMMARY_CAP ? `${first.slice(0, SUMMARY_CAP)}…` : first;
}

async function previewOf(tool: Tool, call: ToolCall): Promise<{ preview: ToolPreview | null; error?: string }> {
  if (!tool.preview) return { preview: null };
  try {
    return { preview: (await tool.preview(call.arguments)) ?? null };
  } catch (e) {
    return { preview: null, error: errorMessage(e) };
  }
}

async function execWithTimeout(tool: Tool, call: ToolCall, preview: ToolPreview | null, signal: AbortSignal) {
  const exec = tool.execute(call.arguments, preview, signal);
  if (tool.awaitsUser || tool.noTimeout) return exec;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exec,
      new Promise<never>((_r, rej) => {
        timer = setTimeout(() => rej(new Error(`tool timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function invoke(turn: EngineTurn, call: ToolCall, tool: Tool, preview: ToolPreview | null): Promise<ToolOutcome> {
  if (tool.requiresApproval) {
    const d = turn.signal.aborted ? { kind: "rejected" as const, reason: "cancelled" } : await turn.approve(call, preview, { roleId: turn.roleId });
    if (d.kind === "rejected") return { kind: "rejected", reason: d.reason };
  }
  try {
    const out = await execWithTimeout(tool, call, preview, turn.signal);
    const raw = typeof out === "string" ? out : out.text;
    const dup = readGuards.get(turn)?.check(call, raw, turn.transcript);
    return { kind: "success", content: dup ?? capOutput(raw, outputCap(turn.window), call.name), images: typeof out === "string" ? undefined : out.images };
  } catch (e) {
    if (turn.signal.aborted) return { kind: "failure", message: "cancelled" };
    return { kind: "failure", message: errorMessage(e) };
  }
}

function writeRecord(call: ToolCall, outcome: ToolOutcome): { path: string; ok: boolean; message?: string } | null {
  if (!WRITE_TOOLS.has(call.name) || typeof call.arguments.path !== "string") return null;
  const ok = outcome.kind === "success";
  return { path: call.arguments.path, ok, message: ok ? undefined : outcomeMessage(outcome) };
}

interface Prepared {
  rc: ToolCall;
  tool?: Tool;
  preview: ToolPreview | null;
  early?: ToolOutcome;
  note?: string;
}

async function prepare(turn: EngineTurn, call: ToolCall): Promise<Prepared> {
  const resolved = turn.tools.resolve(call);
  if ("error" in resolved) return { rc: call, preview: null, early: { kind: "invalid", reason: resolved.error } };
  const rc = resolved.call;
  const tool = turn.tools.find(rc.name);
  const { preview, error } = tool ? await previewOf(tool, rc) : { preview: null };
  return { rc, tool, preview, early: error ? { kind: "failure", message: error } : undefined, note: resolved.note };
}

async function* executeCall(
  turn: EngineTurn,
  call: ToolCall,
  transcript: ChatMessage[] = turn.transcript,
  seen?: Map<string, Seen>,
): AsyncGenerator<EngineEvent, void> {
  const p = await prepare(turn, call);
  yield { kind: "tool.request", callId: call.id, tool: p.rc.name, args: p.rc.arguments, category: categoryOf(p.preview) ?? "OTHER" };
  const outcome = p.early ?? (await invoke(turn, p.rc, p.tool as Tool, p.preview));
  const result = outcomeMessage(outcome) + (p.note ? `\n[${p.note}]` : "");
  transcript.push({ role: "tool", toolCallId: call.id, content: result });
  if (outcome.kind === "success" && outcome.images?.length) {
    transcript.push({ role: "user", content: `[image from ${p.rc.name}]`, images: outcome.images });
  }
  seen?.set(call.id, { call: p.rc, ok: outcome.kind === "success", result });
  yield { kind: "tool.outcome", callId: call.id, ok: outcome.kind === "success", summary: summaryOf(outcome) };
  const rec = writeRecord(p.rc, outcome);
  if (rec) yield { kind: "write", record: rec };
}

export function isParallel(turn: EngineTurn, call: ToolCall): boolean {
  return turn.tools.find(call.name)?.parallel === true;
}

/** Consecutive calls flagged `parallel` run concurrently; tool messages join the transcript in call order. */
export async function* executeBatch(turn: EngineTurn, calls: ToolCall[], seen?: Map<string, Seen>): AsyncGenerator<EngineEvent, void> {
  if (calls.length === 1 || !calls.every((c) => isParallel(turn, c))) {
    for (const call of calls) {
      if (turn.signal.aborted) turn.transcript.push({ role: "tool", toolCallId: call.id, content: "Not executed: cancelled" });
      else yield* executeCall(turn, call, turn.transcript, seen);
    }
    return;
  }
  const queue: EngineEvent[] = [];
  const buffers = calls.map(() => [] as ChatMessage[]);
  let wake: (() => void) | undefined;
  let pending = calls.length;
  const c: PumpCtx = { queue, done: () => pending--, wake: () => wake?.(), seen };
  calls.forEach((call, i) => {
    void pump(turn, call, buffers[i], c);
  });
  while (pending > 0 || queue.length) {
    while (queue.length) yield queue.shift()!;
    if (pending > 0) await new Promise<void>((r) => (wake = r));
  }
  for (const buf of buffers) turn.transcript.push(...buf);
}

interface PumpCtx {
  queue: EngineEvent[];
  done: () => void;
  wake: () => void;
  seen?: Map<string, Seen>;
}

async function pump(turn: EngineTurn, call: ToolCall, buf: ChatMessage[], c: PumpCtx): Promise<void> {
  try {
    for await (const ev of executeCall(turn, call, buf, c.seen)) {
      c.queue.push(ev);
      c.wake();
    }
  } finally {
    c.done();
    c.wake();
  }
}
