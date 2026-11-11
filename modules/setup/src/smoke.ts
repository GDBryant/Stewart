import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { SMOKE_TIMEOUT_MS, type SmokeChannel, type SmokeOptions, type SmokeResult } from "./probeTypes.js";

const SMOKE_MAX_TOKENS = 32;
const SMOKE_MESSAGES: ChatRequest["messages"] = [{ role: "user", content: "Reply with exactly: OK" }];

type Stop = "timeout" | "aborted";

/** Combines an outer cancel signal with a hard deadline; `stop` resolves once with the cause. */
export function bounded(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; stop: Promise<Stop>; cleanup(): void } {
  const ctrl = new AbortController();
  let settle!: (why: Stop) => void;
  const stop = new Promise<Stop>((res) => {
    settle = res;
  });
  const onAbort = () => {
    ctrl.abort(signal.reason);
    settle("aborted");
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    ctrl.abort(Object.assign(new Error("probe timed out"), { name: "AbortError" }));
    settle("timeout");
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    stop,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

type Step<T> = { kind: "value"; value: T } | { kind: "done" } | { kind: "error"; error: unknown } | { kind: "stop"; why: Stop };

export function step<T>(next: () => Promise<IteratorResult<T>>, stop: Promise<Stop>): Promise<Step<T>> {
  let p: Promise<Step<T>>;
  try {
    p = next().then(
      (r) => (r.done ? ({ kind: "done" } as const) : ({ kind: "value", value: r.value } as const)),
      (error: unknown) => ({ kind: "error", error } as const),
    );
  } catch (error) {
    p = Promise.resolve({ kind: "error", error });
  }
  return Promise.race([p, stop.then((why) => ({ kind: "stop", why } as const))]);
}

export function abortWait(signal: AbortSignal): Promise<"aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((res) => signal.addEventListener("abort", () => res("aborted"), { once: true }));
}

type ProbeAccum = { text: string; sawDone: boolean; sawTool: boolean };
type ProbeFinish = (r: SmokeResult) => SmokeResult;

/** Per-probe state shared by the step loop: accumulator, finisher, caller options, deadline signal, timeout. */
interface ProbeCtx {
  acc: ProbeAccum;
  finish: ProbeFinish;
  opts: SmokeOptions;
  b: { signal: AbortSignal };
  timeoutMs: number;
}

function probeStepOutcome(s: Step<ChatEvent>, ctx: ProbeCtx): SmokeResult | "cont" | "done" {
  if (s.kind === "stop") return ctx.finish(stopResult(s.why, ctx.timeoutMs));
  if (s.kind === "error") return ctx.finish(errorResult(s.error, ctx));
  if (s.kind === "done") return "done";
  accumulate(s.value, ctx.acc);
  return "cont";
}

function stopResult(why: Stop, timeoutMs: number): SmokeResult {
  return why === "timeout" ? { state: "orange", reason: `no response within ${timeoutMs}ms` } : { state: "aborted" };
}

function errorResult(error: unknown, ctx: ProbeCtx): SmokeResult {
  if (ctx.opts.signal.aborted) return { state: "aborted" };
  if (ctx.b.signal.aborted) return { state: "orange", reason: `no response within ${ctx.timeoutMs}ms` };
  return { state: "red", reason: error instanceof Error ? error.message : String(error) };
}

function accumulate(ev: ChatEvent, acc: ProbeAccum): void {
  if (ev.kind === "text") acc.text += ev.text;
  else if (ev.kind === "tool_calls") acc.sawTool = true;
  else if (ev.kind === "done") acc.sawDone = true;
}

function probeVerdict(acc: ProbeAccum, finish: ProbeFinish): SmokeResult {
  if (!acc.sawDone) return finish({ state: "red", reason: "stream ended without completion" });
  if (!acc.text.trim()) return finish({ state: "red", reason: acc.sawTool ? "tool calls but no text" : "empty response" });
  return finish({ state: "green" });
}

/** Wraps `it.next()` so the in-flight request is known to `makeFinish` (a throwing `next` rejects instead). */
function trackNext(it: AsyncIterator<ChatEvent>): { next: () => Promise<IteratorResult<ChatEvent>>; pending: () => Promise<unknown> | undefined } {
  let pendingNext: Promise<unknown> | undefined;
  const next = (): Promise<IteratorResult<ChatEvent>> => {
    let p: Promise<IteratorResult<ChatEvent>>;
    try {
      p = it.next();
    } catch (error) {
      return Promise.reject(error);
    }
    pendingNext = p;
    const clear = () => {
      if (pendingNext === p) pendingNext = undefined;
    };
    void p.then(clear, clear);
    return p;
  };
  return { next, pending: () => pendingNext };
}

/** Result passthrough that closes the iterator and fires `settle` once the close and any in-flight `next` have settled. */
function makeFinish(it: AsyncIterator<ChatEvent>, pending: () => Promise<unknown> | undefined, settle: () => void): ProbeFinish {
  return (r) => {
    let ret: Promise<unknown> | undefined;
    try {
      ret = it.return?.();
    } catch {
      ret = undefined;
    }
    void Promise.allSettled([ret, pending()]).then(() => settle());
    return r;
  };
}

/**
 * One bounded liveness probe: a tiny prompt, no tools, hard `timeoutMs` deadline
 * covering queue admission, the request and stream completion. Timeout → orange,
 * external cancel → aborted, every other unusable outcome → red.
 */
export async function smokeModel(channel: SmokeChannel, model: string, opts: SmokeOptions): Promise<SmokeResult> {
  const timeoutMs = opts.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const b = bounded(opts.signal, timeoutMs);
  const req: ChatRequest = { model, messages: SMOKE_MESSAGES, maxTokens: SMOKE_MAX_TOKENS, signal: b.signal };
  let it: AsyncIterator<ChatEvent>;
  try {
    it = channel.chat(req)[Symbol.asyncIterator]();
  } catch (error) {
    opts.onSettle?.(Promise.resolve());
    return { state: "red", reason: error instanceof Error ? error.message : String(error) };
  }
  const tracked = trackNext(it);
  let settle!: () => void;
  const settled = new Promise<void>((res) => {
    settle = res;
  });
  opts.onSettle?.(settled);
  const finish = makeFinish(it, tracked.pending, () => settle());
  const acc = { text: "", sawDone: false, sawTool: false };
  try {
    for (;;) {
      const s = await step(tracked.next, b.stop);
      const r = probeStepOutcome(s, { acc, finish, opts, b, timeoutMs });
      if (typeof r !== "string") return r;
      if (r === "done") break;
    }
    return probeVerdict(acc, finish);
  } finally {
    b.cleanup();
  }
}
