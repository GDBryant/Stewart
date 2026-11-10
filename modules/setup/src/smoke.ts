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

function probeStepOutcome(
  s: Step<ChatEvent>,
  acc: ProbeAccum,
  finish: ProbeFinish,
  opts: SmokeOptions,
  b: { signal: AbortSignal },
  timeoutMs: number,
): SmokeResult | "cont" | "done" {
  if (s.kind === "stop") return finish(s.why === "timeout" ? { state: "orange", reason: `no response within ${timeoutMs}ms` } : { state: "aborted" });
  if (s.kind === "error") {
    if (opts.signal.aborted) return finish({ state: "aborted" });
    if (b.signal.aborted) return finish({ state: "orange", reason: `no response within ${timeoutMs}ms` });
    return finish({ state: "red", reason: s.error instanceof Error ? s.error.message : String(s.error) });
  }
  if (s.kind === "done") return "done";
  const ev = s.value;
  if (ev.kind === "text") acc.text += ev.text;
  else if (ev.kind === "tool_calls") acc.sawTool = true;
  else if (ev.kind === "done") acc.sawDone = true;
  return "cont";
}

function probeVerdict(acc: ProbeAccum, finish: ProbeFinish): SmokeResult {
  if (!acc.sawDone) return finish({ state: "red", reason: "stream ended without completion" });
  if (!acc.text.trim()) return finish({ state: "red", reason: acc.sawTool ? "tool calls but no text" : "empty response" });
  return finish({ state: "green" });
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
  let settle!: () => void;
  const settled = new Promise<void>((res) => {
    settle = res;
  });
  opts.onSettle?.(settled);
  const finish = (r: SmokeResult): SmokeResult => {
    let ret: Promise<unknown> | undefined;
    try {
      ret = it.return?.();
    } catch {
      ret = undefined;
    }
    const pend = pendingNext;
    void Promise.allSettled([ret, pend]).then(() => settle());
    return r;
  };
  const acc = { text: "", sawDone: false, sawTool: false };
  try {
    for (;;) {
      const s = await step(next, b.stop);
      const r = probeStepOutcome(s, acc, finish, opts, b, timeoutMs);
      if (typeof r !== "string") return r;
      if (r === "done") break;
    }
    return probeVerdict(acc, finish);
  } finally {
    b.cleanup();
  }
}
