import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { errorMessage } from "@stewart/kernel";
import type { Violation } from "@stewart/business-policy";
import { BusinessPolicyError, type ChatEvent } from "@stewart/channels";
import type { Effort } from "@stewart/config";
import { freshWithheld, noticesOf, redactBlocked, withholdTools } from "./policyNotice.js";
import type { EngineEvent, EngineTurn } from "./types.js";
import { forNative } from "./nativeMessages.js";
import { RETRY_DELAYS_MS, retryable, sleep } from "./modelRetry.js";
import { OVERRUN_CHARS, ReasoningPolicy } from "./reasoningPolicy.js";

export interface ModelOut {
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

/** One model request; a thrown channel error becomes a `finished` event and `false`. A transient failure before any output is repeated (see `modelRetry.ts`). */
async function* requestModel(turn: EngineTurn, out: ModelOut, mode: Mode): AsyncGenerator<EngineEvent, boolean> {
  const delays = turn.retryDelaysMs ?? (turn.maxTurns >= 10 ? RETRY_DELAYS_MS : []); // probes and conformance (few turns) report a failure at once
  for (let attempt = 0; ; attempt++) {
    try {
      yield* streamModel(turn, out, mode);
      return true;
    } catch (e) {
      if (!turn.signal.aborted && retryable(e, hasOutput(out), attempt, delays)) {
        yield { kind: "diag", tag: "retry", detail: `${errorMessage(e)}; attempt ${attempt + 2} of ${delays.length + 1} in ${delays[attempt] / 1000} s` };
        await sleep(delays[attempt], turn.signal);
        continue;
      }
      yield failure(turn, e);
      return false;
    }
  }
}

const hasOutput = (o: ModelOut): boolean => o.content !== "" || o.reasoningChars > 0 || o.calls.length > 0;

function failure(turn: EngineTurn, e: unknown): EngineEvent {
  const aborted = turn.signal.aborted || (e instanceof Error && e.name === "AbortError");
  return { kind: "finished", reason: aborted ? "cancelled" : "error", error: aborted ? undefined : errorMessage(e) };
}

/**
 * A reply cut off by the context window before any content (a reasoning model spent it all thinking) is
 * retried once with reasoning off and a larger window; if that is cut off too, the turn fails with that cause.
 */
export async function* modelTurn(turn: EngineTurn, policy: ReasoningPolicy, report: boolean): AsyncGenerator<EngineEvent, ModelOut | null> {
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
