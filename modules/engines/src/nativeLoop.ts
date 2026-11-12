import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { categoryOf, type ToolPreview } from "@stewart/permissions";
import { outcomeMessage, type Tool, type ToolOutcome } from "@stewart/tools";
import type { Engine, EngineEvent, EngineTurn } from "./types.js";

const TOOL_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 20_000;
const SUMMARY_CAP = 200;
const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);

interface ModelOut {
  calls: ToolCall[];
  content: string;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capOutput(raw: string): string {
  if (raw.length <= OUTPUT_CAP) return raw;
  const head = Math.ceil(OUTPUT_CAP * 0.7);
  const tail = Math.floor(OUTPUT_CAP * 0.3);
  return `${raw.slice(0, head)}\n[output truncated: ${raw.length - OUTPUT_CAP} chars omitted]\n${raw.slice(-tail)}`;
}

function summaryOf(outcome: ToolOutcome): string {
  const first = outcomeMessage(outcome).split("\n")[0];
  return first.length > SUMMARY_CAP ? `${first.slice(0, SUMMARY_CAP)}…` : first;
}

async function* streamModel(turn: EngineTurn, out: ModelOut): AsyncGenerator<EngineEvent, void> {
  const req = {
    model: turn.agent.model,
    temperature: turn.agent.temperature,
    messages: [{ role: "system" as const, content: turn.system }, ...turn.transcript],
    tools: turn.tools.specs.map((s) => ({ name: s.name, description: s.description, schema: s.parameters })),
    signal: turn.signal,
  };
  for await (const ev of turn.channel.chat(req)) {
    if (ev.kind === "text") {
      out.content += ev.text;
      yield { kind: "text", text: ev.text };
    } else if (ev.kind === "reasoning") {
      yield { kind: "reasoning", text: ev.text };
    } else if (ev.kind === "tool_calls") {
      out.calls.push(...ev.calls);
    } else if (ev.kind === "done" && ev.usage) {
      yield { kind: "usage", inTokens: ev.usage.in, outTokens: ev.usage.out, costUsd: ev.costUsd };
    }
  }
}

async function* modelTurn(turn: EngineTurn): AsyncGenerator<EngineEvent, ModelOut | null> {
  const out: ModelOut = { calls: [], content: "" };
  try {
    yield* streamModel(turn, out);
  } catch (e) {
    const aborted = turn.signal.aborted || (e instanceof Error && e.name === "AbortError");
    yield { kind: "finished", reason: aborted ? "cancelled" : "error", error: aborted ? undefined : err(e) };
    return null;
  }
  const msg: ChatMessage = { role: "assistant", content: out.content, toolCalls: out.calls.length ? out.calls : undefined };
  turn.transcript.push(msg);
  return out;
}

async function previewOf(tool: Tool, call: ToolCall): Promise<{ preview: ToolPreview | null; error?: string }> {
  if (!tool.preview) return { preview: null };
  try {
    return { preview: (await tool.preview(call.arguments)) ?? null };
  } catch (e) {
    return { preview: null, error: err(e) };
  }
}

async function execWithTimeout(tool: Tool, call: ToolCall, preview: ToolPreview | null, signal: AbortSignal) {
  const exec = tool.execute(call.arguments, preview, signal);
  if (tool.awaitsUser) return exec;
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
    const d = turn.signal.aborted ? { kind: "rejected" as const, reason: "cancelled" } : await turn.approve(call, preview, { roleId: "lead" });
    if (d.kind === "rejected") return { kind: "rejected", reason: d.reason };
  }
  try {
    const out = await execWithTimeout(tool, call, preview, turn.signal);
    const raw = typeof out === "string" ? out : out.text;
    return { kind: "success", content: capOutput(raw), images: typeof out === "string" ? undefined : out.images };
  } catch (e) {
    if (turn.signal.aborted) return { kind: "failure", message: "cancelled" };
    return { kind: "failure", message: err(e) };
  }
}

function writeRecord(call: ToolCall, outcome: ToolOutcome): { path: string; ok: boolean; message?: string } | null {
  if (!WRITE_TOOLS.has(call.name) || typeof call.arguments.path !== "string") return null;
  const ok = outcome.kind === "success";
  return { path: call.arguments.path, ok, message: ok ? undefined : outcomeMessage(outcome) };
}

async function* executeCall(turn: EngineTurn, call: ToolCall, transcript: ChatMessage[] = turn.transcript): AsyncGenerator<EngineEvent, void> {
  const tool = turn.tools.find(call.name);
  const invalid = tool ? turn.tools.validate(call) : `unknown tool '${call.name}'`;
  const { preview, error: previewErr } = tool && !invalid ? await previewOf(tool, call) : { preview: null };
  const category = categoryOf(preview) ?? "OTHER";
  yield { kind: "tool.request", callId: call.id, tool: call.name, args: call.arguments, category };
  const outcome: ToolOutcome = previewErr
    ? { kind: "failure", message: previewErr }
    : invalid
      ? { kind: "invalid", reason: invalid }
      : await invoke(turn, call, tool as Tool, preview);
  transcript.push({ role: "tool", toolCallId: call.id, content: outcomeMessage(outcome) });
  if (outcome.kind === "success" && outcome.images?.length) {
    transcript.push({ role: "user", content: `[image from ${call.name}]`, images: outcome.images });
  }
  yield { kind: "tool.outcome", callId: call.id, ok: outcome.kind === "success", summary: summaryOf(outcome) };
  const rec = writeRecord(call, outcome);
  if (rec) yield { kind: "write", record: rec };
}

function isParallel(turn: EngineTurn, call: ToolCall): boolean {
  return turn.tools.find(call.name)?.parallel === true;
}

/** Consecutive calls flagged `parallel` run concurrently; tool messages join the transcript in call order. */
async function* executeBatch(turn: EngineTurn, calls: ToolCall[]): AsyncGenerator<EngineEvent, void> {
  if (calls.length === 1 || !calls.every((c) => isParallel(turn, c))) {
    for (const call of calls) {
      if (turn.signal.aborted) turn.transcript.push({ role: "tool", toolCallId: call.id, content: "Not executed: cancelled" });
      else yield* executeCall(turn, call);
    }
    return;
  }
  const queue: EngineEvent[] = [];
  const buffers = calls.map(() => [] as ChatMessage[]);
  let wake: (() => void) | undefined;
  let pending = calls.length;
  const c: PumpCtx = { queue, done: () => pending--, wake: () => wake?.() };
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
}

async function pump(turn: EngineTurn, call: ToolCall, buf: ChatMessage[], c: PumpCtx): Promise<void> {
  try {
    for await (const ev of executeCall(turn, call, buf)) {
      c.queue.push(ev);
      c.wake();
    }
  } finally {
    c.done();
    c.wake();
  }
}

async function* run(turn: EngineTurn): AsyncGenerator<EngineEvent, void> {
  for (let n = 0; n < turn.maxTurns; n++) {
    if (turn.signal.aborted) {
      yield { kind: "finished", reason: "cancelled" };
      return;
    }
    const out = yield* modelTurn(turn);
    if (!out) return;
    if (!out.calls.length) {
      yield { kind: "finished", reason: "stop" };
      return;
    }
    yield* runBatches(turn, out.calls);
    if (turn.signal.aborted) {
      yield { kind: "finished", reason: "cancelled" };
      return;
    }
  }
  yield { kind: "finished", reason: "turn_limit" };
}

async function* runBatches(turn: EngineTurn, calls: ToolCall[]): AsyncGenerator<EngineEvent, void> {
  for (let i = 0; i < calls.length; ) {
    let j = i;
    while (j < calls.length && isParallel(turn, calls[j]) === isParallel(turn, calls[i])) j++;
    const batch = calls.slice(i, j);
    i = j;
    if (turn.signal.aborted) {
      for (const call of batch) turn.transcript.push({ role: "tool", toolCallId: call.id, content: "Not executed: cancelled" });
    } else {
      yield* executeBatch(turn, batch);
    }
  }
}

/** Stewart's own tool loop over a channel's native tool calling. */
export const nativeLoop: Engine = { id: "native-loop", run };
