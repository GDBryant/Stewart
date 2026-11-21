import { errorMessage } from "@stewart/kernel";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { SMOKE_MESSAGES, SMOKE_TIMEOUT_MS, type SmokeChannel, type SmokeOptions, type SmokeResult } from "./probeTypes.js";

const SMOKE_MAX_TOKENS = 32;

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

/** Per-probe state shared by the step loop: finisher, caller options, deadline signal, timeout. */
interface ProbeCtx {
  finish: ProbeFinish;
  opts: SmokeOptions;
  b: { signal: AbortSignal };
  timeoutMs: number;
}

function stopResult(why: Stop, timeoutMs: number): SmokeResult {
  return why === "timeout" ? { state: "orange", reason: `no response within ${timeoutMs}ms` } : { state: "aborted" };
}

function errorResult(error: unknown, ctx: ProbeCtx): SmokeResult {
  if (ctx.opts.signal.aborted) return { state: "aborted" };
  if (ctx.b.signal.aborted) return { state: "orange", reason: `no response within ${ctx.timeoutMs}ms` };
  return { state: "red", reason: errorMessage(error) };
}

function stepOutcome<E>(s: Step<E>, ctx: ProbeCtx, accept: (ev: E) => void): SmokeResult | "cont" | "done" {
  if (s.kind === "stop") return ctx.finish(stopResult(s.why, ctx.timeoutMs));
  if (s.kind === "error") return ctx.finish(errorResult(s.error, ctx));
  if (s.kind === "done") return "done";
  accept(s.value);
  return "cont";
}

/** Wraps `it.next()` so the in-flight request is known to `makeFinish` (a throwing `next` rejects instead). */
function trackNext<T>(it: AsyncIterator<T>): { next: () => Promise<IteratorResult<T>>; pending: () => Promise<unknown> | undefined } {
  let pendingNext: Promise<unknown> | undefined;
  const next = (): Promise<IteratorResult<T>> => {
    let p: Promise<IteratorResult<T>>;
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
function makeFinish<T>(it: AsyncIterator<T>, pending: () => Promise<unknown> | undefined, settle: () => void): ProbeFinish {
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

/** What one bounded probe runs: how to start the event stream, fold each event, and judge the finished stream. */
export interface ProbeSpec<E> {
  /** Starts the stream; may throw synchronously (reported as red). */
  start(signal: AbortSignal): AsyncIterable<E>;
  accept(ev: E): void;
  verdict(): SmokeResult;
}

/**
 * Generic bounded probe runner: hard `timeoutMs` deadline over the whole stream, settle
 * tracking via `opts.onSettle`. Timeout -> orange, external cancel -> aborted, errors -> red.
 */
export async function runBounded<E>(opts: SmokeOptions, spec: ProbeSpec<E>): Promise<SmokeResult> {
  const timeoutMs = opts.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const b = bounded(opts.signal, timeoutMs);
  let it: AsyncIterator<E>;
  try {
    it = spec.start(b.signal)[Symbol.asyncIterator]();
  } catch (error) {
    opts.onSettle?.(Promise.resolve());
    b.cleanup();
    return { state: "red", reason: errorMessage(error) };
  }
  const tracked = trackNext(it);
  let settle!: () => void;
  const settled = new Promise<void>((res) => {
    settle = res;
  });
  opts.onSettle?.(settled);
  const finish = makeFinish(it, tracked.pending, () => settle());
  try {
    for (;;) {
      const s = await step(tracked.next, b.stop);
      const r = stepOutcome(s, { finish, opts, b, timeoutMs }, (ev) => spec.accept(ev));
      if (typeof r !== "string") return r;
      if (r === "done") break;
    }
    return finish(spec.verdict());
  } finally {
    b.cleanup();
  }
}

function accumulate(ev: ChatEvent, acc: ProbeAccum): void {
  if (ev.kind === "text") acc.text += ev.text;
  else if (ev.kind === "tool_calls") acc.sawTool = true;
  else if (ev.kind === "done") acc.sawDone = true;
}

function probeVerdict(acc: ProbeAccum): SmokeResult {
  if (!acc.sawDone) return { state: "red", reason: "stream ended without completion" };
  if (!acc.text.trim()) return { state: "red", reason: acc.sawTool ? "tool calls but no text" : "empty response" };
  return { state: "green" };
}

/**
 * One bounded liveness probe: a tiny prompt, no tools, hard `timeoutMs` deadline
 * covering queue admission, the request and stream completion. Timeout -> orange,
 * external cancel -> aborted, every other unusable outcome -> red.
 */
export function smokeModel(channel: SmokeChannel, model: string, opts: SmokeOptions): Promise<SmokeResult> {
  const acc: ProbeAccum = { text: "", sawDone: false, sawTool: false };
  return runBounded<ChatEvent>(opts, {
    start: (signal) => channel.chat({ model, messages: SMOKE_MESSAGES, maxTokens: SMOKE_MAX_TOKENS, signal }),
    accept: (ev) => accumulate(ev, acc),
    verdict: () => probeVerdict(acc),
  });
}
