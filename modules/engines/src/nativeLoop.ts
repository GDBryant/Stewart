import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { categoryOf, type ToolPreview } from "@stewart/permissions";
import { outcomeMessage, ToolRegistry, type Tool, type ToolOutcome } from "@stewart/tools";
import type { Violation } from "@stewart/business-policy";
import { BusinessPolicyError, type ChatEvent } from "@stewart/channels";
import { freshWithheld, noticesOf, redactBlocked, withholdTools } from "./policyNotice.js";
import type { Effort } from "@stewart/config";
import type { Engine, EngineEvent, EngineTurn } from "./types.js";
import { LoopGuard } from "./loopGuard.js";
import { forNative } from "./nativeMessages.js";
import { runFunction } from "./functionRun.js";
import { OVERRUN_CHARS, ReasoningPolicy } from "./reasoningPolicy.js";

interface Seen {
  call: ToolCall;
  ok: boolean;
  result: string;
}

const TOOL_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 20_000;
const SUMMARY_CAP = 200;
const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);

interface ModelOut {
  calls: ToolCall[];
  content: string;
  /** The provider stopped at its length limit (context window full). */
  truncated: boolean;
  /** Prompt + output tokens of the request, when reported. */
  tokens: number;
  /** Prompt tokens of the request (provider-reported), 0 when unreported. */
  inTokens: number;
  /** Reasoning chars streamed so far; `overrun` is set when the request was cut for exceeding `OVERRUN_CHARS` with no answer. */
  reasoningChars: number;
  watch: boolean;
  overrun: boolean;
}

const freshOut = (watch = false): ModelOut => ({ calls: [], content: "", truncated: false, tokens: 0, inTokens: 0, reasoningChars: 0, watch, overrun: false });

/** How one request is sent: a length-cut retry, thinking off for a routine turn. */
interface Mode {
  retry?: { minNumCtx: number };
  thinkOff?: boolean;
}
const RETRY_MIN_CTX = 8192;

/** Cut off by the length limit before producing any reply or tool call. */
const cutOffEmpty = (o: ModelOut): boolean => o.truncated && !o.calls.length && !o.content.trim();

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

/** Request options for the role's `think` setting; a retry turns reasoning off (dropping effort) and raises the window floor. */
function retryOpts(turn: EngineTurn, mode: Mode): { think?: boolean; minNumCtx?: number; effort?: Effort } {
  if (mode.retry) return { think: false, minNumCtx: mode.retry.minNumCtx };
  if (mode.thinkOff) return { think: false };
  return { ...(turn.think !== undefined ? { think: turn.think } : {}), ...(turn.effort ? { effort: turn.effort } : {}) };
}

async function* streamModel(turn: EngineTurn, out: ModelOut, mode: Mode): AsyncGenerator<EngineEvent, void> {
  const cut = new AbortController();
  const onAbort = (): void => cut.abort();
  turn.signal.addEventListener("abort", onAbort, { once: true });
  try {
    yield* streamCut(turn, out, mode, cut);
  } finally {
    turn.signal.removeEventListener("abort", onAbort);
  }
}

async function* streamCut(turn: EngineTurn, out: ModelOut, mode: Mode, cut: AbortController): AsyncGenerator<EngineEvent, void> {
  const withheld: Violation[] = [];
  const pre = withholdTools(turn.channel, turn.system, turn.transcript);
  yield* pre.notices;
  const req = {
    model: turn.agent.model,
    temperature: turn.agent.temperature,
    ...retryOpts(turn, mode),
    messages: [{ role: "system" as const, content: turn.system }, ...forNative(pre.transcript, new Set(turn.tools.specs.map((s) => s.name)))],
    tools: turn.tools.specs.map((s) => ({ name: s.name, description: s.description, schema: s.parameters })),
    onWithheld: (w: Violation[]) => withheld.push(...w),
    signal: cut.signal,
  };
  try {
    for await (const ev of turn.channel.chat(req)) {
      yield* freshWithheld(turn.channel.cfg.id, req.messages, withheld.splice(0));
      yield* modelEvent(ev, out);
      if (out.overrun) {
        cut.abort();
        break;
      }
    }
    yield* freshWithheld(turn.channel.cfg.id, req.messages, withheld.splice(0));
  } catch (e) {
    if (e instanceof BusinessPolicyError) {
      redactBlocked(turn.transcript, e.violations);
      yield* noticesOf(e.channel, "blocked", e.violations);
    }
    throw e;
  }
}

/** Counts streamed reasoning; flags an overrun when a watched request reasons past the limit with no answer yet. */
function noteReasoning(out: ModelOut, text: string): void {
  out.reasoningChars += text.length;
  if (out.watch && !out.content.trim() && !out.calls.length && out.reasoningChars > OVERRUN_CHARS) out.overrun = true;
}

function* modelEvent(ev: ChatEvent, out: ModelOut): Generator<EngineEvent, void> {
  if (ev.kind === "text") {
    out.content += ev.text;
    yield { kind: "text", text: ev.text };
  } else if (ev.kind === "reasoning") {
    noteReasoning(out, ev.text);
    yield { kind: "reasoning", text: ev.text };
  } else if (ev.kind === "tool_calls") {
    out.calls.push(...ev.calls);
  } else if (ev.kind === "done") {
    out.truncated = ev.truncated === true;
    out.tokens = ev.usage ? ev.usage.in + ev.usage.out : 0;
    out.inTokens = ev.usage?.in ?? 0;
    if (ev.usage) yield { kind: "usage", inTokens: ev.usage.in, outTokens: ev.usage.out, costUsd: ev.costUsd };
  }
}

/** One model request; a thrown channel error becomes a `finished` event and `false`. */
async function* requestModel(turn: EngineTurn, out: ModelOut, mode: Mode): AsyncGenerator<EngineEvent, boolean> {
  try {
    yield* streamModel(turn, out, mode);
    return true;
  } catch (e) {
    const aborted = turn.signal.aborted || (e instanceof Error && e.name === "AbortError");
    yield { kind: "finished", reason: aborted ? "cancelled" : "error", error: aborted ? undefined : err(e) };
    return false;
  }
}

/**
 * A reply cut off by the context window before any content (a reasoning model spent it all thinking) is
 * retried once with reasoning off and a larger window; if that is cut off too, the turn fails with that cause.
 */
async function* modelTurn(turn: EngineTurn, policy: ReasoningPolicy, report: boolean): AsyncGenerator<EngineEvent, ModelOut | null> {
  let out = freshOut(policy.watch(turn));
  const mode: Mode = { thinkOff: policy.thinkOff(turn, report) };
  if (!(yield* requestModel(turn, out, mode))) return null;
  if (out.overrun) {
    policy.overran();
    yield { kind: "diag", tag: "reasoning_overrun", detail: `${out.reasoningChars} reasoning chars with no answer; retrying with thinking off` };
    out = freshOut();
    if (!(yield* requestModel(turn, out, { thinkOff: true }))) return null;
  }
  if (cutOffEmpty(out)) {
    const retry = freshOut();
    if (!(yield* requestModel(turn, retry, { retry: { minNumCtx: Math.max(RETRY_MIN_CTX, out.tokens * 2) } }))) return null;
    out = retry;
    if (cutOffEmpty(out)) {
      yield { kind: "finished", reason: "error", error: `reply cut off by the context window (${out.tokens} tokens used) before any answer; raise numCtx or shorten the task` };
      return null;
    }
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

function isParallel(turn: EngineTurn, call: ToolCall): boolean {
  return turn.tools.find(call.name)?.parallel === true;
}

/** Consecutive calls flagged `parallel` run concurrently; tool messages join the transcript in call order. */
async function* executeBatch(turn: EngineTurn, calls: ToolCall[], seen?: Map<string, Seen>): AsyncGenerator<EngineEvent, void> {
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

/** Budget nudge this many turns before the end. */
const NUDGE_LEFT = 3;
/** Budgets below this (bench probes, conformance) get no nudge and no report-only last turn. */
const BUDGET_MIN = 10;
const EMPTY_REPORT = "(No report: the last turn only requested tools, which were ignored.)";

/**
 * Budget notes for model turn `n`: warns NUDGE_LEFT turns before the end, and makes the last turn
 * report-only. Tools stay in the request so the history renders unchanged; calls made on it are dropped.
 * Returns true for that last turn.
 */
export function budgetTurn(turn: EngineTurn, n: number): boolean {
  if (turn.maxTurns < BUDGET_MIN) return false;
  const left = turn.maxTurns - n;
  if (left === NUDGE_LEFT) {
    turn.transcript.push({ role: "user", content: `[Stewart] ${left} model turns left; the last is for your report only. Stop investigating: make the change and verify it now.` });
  }
  if (left !== 1) return false;
  turn.transcript.push({ role: "user", content: "[Stewart] Turn budget used up; this is your last reply. Do not call tools: any call is ignored. Report what you found, what you changed, and the exact remaining change (file, code) so the task can continue." });
  return true;
}

/** The report-only reply must not leave dangling tool calls, nor an empty assistant message. */
function dropCalls(turn: EngineTurn): void {
  const msg = turn.transcript[turn.transcript.length - 1];
  if (msg?.role !== "assistant" || !msg.toolCalls) return;
  delete msg.toolCalls;
  if (!msg.content.trim()) msg.content = EMPTY_REPORT;
}

/** The provider's prompt-token count for a request that sent `len` transcript messages, when it reported one. */
function measuredOf(out: ModelOut, len: number): { tokens: number; len: number } | undefined {
  return out.inTokens > 0 ? { tokens: out.inTokens, len } : undefined;
}

async function* run(raw: EngineTurn): AsyncGenerator<EngineEvent, void> {
  const turn = raw.hostTools ? { ...raw, tools: new ToolRegistry([...raw.tools.tools, ...raw.hostTools.tools]) } : raw;
  const guard = new LoopGuard();
  const policy = new ReasoningPolicy();
  let measured: { tokens: number; len: number } | undefined;
  for (let n = 0; n < turn.maxTurns; n++) {
    if (turn.signal.aborted) {
      yield { kind: "finished", reason: "cancelled" };
      return;
    }
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
    yield* runBatches(turn, out.calls, guard, policy);
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

async function* runBatches(turn: EngineTurn, calls: ToolCall[], guard: LoopGuard, policy: ReasoningPolicy): AsyncGenerator<EngineEvent, void> {
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
  const warnings: string[] = [];
  for (const { call, ok, result } of seen.values()) {
    const w = guard.record({ name: call.name, args: call.arguments, ok, result });
    if (w) warnings.push(w);
  }
  guard.endTurn();
  policy.observe([...seen.values()], warnings.length > 0);
  if (warnings.length && !guard.trip) turn.transcript.push({ role: "user", content: warnings.join("\n") });
}

/** Stewart's own tool loop over a channel's native tool calling. */
export const nativeLoop: Engine = { id: "native-loop", caps: { ownTools: false, ownContext: false }, run, complete: runFunction };
