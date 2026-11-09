import type { ChatEvent, ChatRequest } from "@stewart/channels";

/** Hard per-candidate deadline for the setup quick probe. */
export const SMOKE_TIMEOUT_MS = 30_000;
/** Deadline for the evaluator's usefulness ranking of non-local candidates. */
export const RANK_TIMEOUT_MS = 20_000;
/** Max wait for a channel's previous probe to fully terminate before skipping same-channel candidates. */
export const PROBE_DRAIN_MS = 10_000;
/** Per-candidate attempt cap across explicit retries. */
export const MAX_SMOKE_ATTEMPTS = 3;
const SMOKE_MAX_TOKENS = 32;
const SMOKE_MESSAGES: ChatRequest["messages"] = [{ role: "user", content: "Reply with exactly: OK" }];
const REASON_MAX = 160;

export type SmokeState = "queued" | "running" | "green" | "orange" | "red" | "skipped";
export type SmokeVerdict = "green" | "red" | "orange" | "aborted";

export interface SmokeResult {
  state: SmokeVerdict;
  reason?: string;
}

export interface SmokeCandidate {
  channel: string;
  model: string;
}

export interface ProbeItem extends SmokeCandidate {
  state: SmokeState;
  reason?: string;
  /** Reason from the previous attempt, kept after a retry re-queues the candidate. */
  lastReason?: string;
  /** Probe attempts so far (1 = first try). */
  attempts?: number;
  /** Time spent queued before admission; the smoke deadline only covers the probe itself. */
  waitMs?: number;
  durationMs?: number;
}

export type ProbeStatus = "idle" | "running" | "done" | "cancelled";

export type ProbeCounts = Record<SmokeState, number>;

export interface ProbeSnapshot {
  status: ProbeStatus;
  /** Monotonic run identity; increments on every new probe run. */
  runId: number;
  /** True while the evaluator ranking for the non-local tail is still in flight. */
  ranking: boolean;
  items: ProbeItem[];
  counts: ProbeCounts;
  green: SmokeCandidate[];
}

export interface SmokeChannel {
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}

const key = (c: SmokeCandidate) => `${c.channel}:${c.model}`;

type Stop = "timeout" | "aborted";

/** Combines an outer cancel signal with a hard deadline; `stop` resolves once with the cause. */
function bounded(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; stop: Promise<Stop>; cleanup(): void } {
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

function step<T>(next: () => Promise<IteratorResult<T>>, stop: Promise<Stop>): Promise<Step<T>> {
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

function abortWait(signal: AbortSignal): Promise<"aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((res) => signal.addEventListener("abort", () => res("aborted"), { once: true }));
}

/**
 * Collapse whitespace, drop provider response bodies (`→ 500: {...}`, `HTTP 500: ...`)
 * and truncate so reasons are safe to show in the UI, events and logs.
 */
export function normalizeReason(reason: string): string {
  let s = reason.replace(/\s+/g, " ").trim();
  s = s.replace(/(→\s*\d{3}|HTTP\s+\d{3})\s*:.*$/i, "$1");
  if (s.length > REASON_MAX) s = `${s.slice(0, REASON_MAX - 3)}...`;
  return s;
}

export interface SmokeOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  /**
   * Called once with a promise that resolves when the underlying chat iterator has fully
   * terminated. It may never resolve when the adapter ignores abort — the runner uses this
   * to avoid overlapping requests on the same channel without blocking the queue.
   */
  onSettle?(settled: Promise<void>): void;
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

export interface ProbeRunnerDeps {
  channelFor(id: string): SmokeChannel | undefined;
  onEvent?(ev: { kind: "probe.state"; snapshot: ProbeSnapshot }): void;
  now?(): number;
  timeoutMs?: number;
  /** Max wait for a channel's previous probe iterator to terminate before same-channel candidates are skipped. */
  drainMs?: number;
  /** Per-candidate attempt cap across retries. */
  maxAttempts?: number;
  /** Final user-visible reason sanitizer (secret/header redaction); applied after normalizeReason. */
  sanitizeReason?(reason: string): string;
}

const emptyCounts = (): ProbeCounts => ({ queued: 0, running: 0, green: 0, orange: 0, red: 0, skipped: 0 });

/**
 * Server-owned, one-at-a-time smoke-test queue per project. Candidates are probed
 * in the order given; `rest` may still be resolving (evaluator ranking) and is only
 * awaited once the priority head is done. Each `start` bumps `runId`; results written
 * by a superseded run are discarded. Cancel aborts the in-flight request and marks
 * everything unfinished skipped; completed results are kept for retry/status.
 *
 * A candidate's 30 s deadline starts at scheduler admission, not while queued
 * (`waitMs` tracks queue time separately). If an adapter ignores abort, its channel
 * is drained up to `drainMs`; candidates on a still-busy channel are skipped rather
 * than overlapping the zombie request or blocking the queue.
 */
export class SetupProbeRunner {
  private order: SmokeCandidate[] = [];
  private results = new Map<string, ProbeItem>();
  private enqueuedAt = new Map<string, number>();
  private status: ProbeStatus = "idle";
  private signature = "";
  private runId = 0;
  private ctrl = new AbortController();
  private loop: Promise<void> | undefined;
  private rest: Promise<SmokeCandidate[]> = Promise.resolve([]);
  private restPending = false;
  /** channel -> promise resolving when that channel's last probe iterator fully terminates. */
  private inflight = new Map<string, Promise<void>>();
  /** channels whose previous probe iterator did not terminate within drainMs. */
  private wedged = new Set<string>();

  constructor(private readonly deps: ProbeRunnerDeps) {}

  snapshot(): ProbeSnapshot {
    const items = this.order.map((c) => {
      const k = key(c);
      return this.results.get(k) ?? { channel: c.channel, model: c.model, state: "queued" as const };
    });
    const counts = emptyCounts();
    for (const i of items) counts[i.state]++;
    return {
      status: this.status,
      runId: this.runId,
      ranking: this.restPending,
      items,
      counts,
      green: items.filter((i) => i.state === "green").map((i) => ({ channel: i.channel, model: i.model })),
    };
  }

  private emit(): void {
    this.deps.onEvent?.({ kind: "probe.state", snapshot: this.snapshot() });
  }

  private reason(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const normalized = normalizeReason(raw);
    return this.deps.sanitizeReason ? this.deps.sanitizeReason(normalized) : normalized;
  }

  private finish(runId: number, ctrl: AbortController): void {
    if (runId !== this.runId || this.status !== "running") return;
    this.status = ctrl.signal.aborted ? "cancelled" : "done";
    for (const c of this.order) {
      const k = key(c);
      const r = this.results.get(k);
      if (!r || r.state === "queued" || r.state === "running") {
        this.results.set(k, {
          channel: c.channel,
          model: c.model,
          state: "skipped",
          reason: r?.lastReason ?? "not reached",
          lastReason: r?.lastReason,
          attempts: r?.attempts,
          waitMs: r?.waitMs,
        });
      }
    }
    this.emit();
  }

  private launch(): void {
    const runId = this.runId;
    const ctrl = this.ctrl;
    this.loop = this.run(runId, ctrl).finally(() => this.finish(runId, ctrl));
    this.emit();
  }

  /**
   * Begin (or resume) a run. `signature` fingerprints the enabled channels, candidate
   * set and evaluator; re-starting with the same signature returns the cached snapshot
   * instead of re-probing. A different signature while running cancels the current
   * run and starts fresh — late results from the old run are discarded via `runId`.
   * While `rest` is unresolved only `priority` items are visible.
   */
  start(opts: { signature: string; priority: SmokeCandidate[]; rest: Promise<SmokeCandidate[]> }): ProbeSnapshot {
    if (this.status === "running" && this.signature === opts.signature) return this.snapshot();
    if (this.status !== "running" && this.status !== "idle" && this.signature === opts.signature) return this.snapshot();
    if (this.status === "running") this.ctrl.abort();
    const seen = new Set<string>();
    this.order = [];
    this.enqueuedAt.clear();
    const now = this.deps.now ?? Date.now;
    for (const c of opts.priority) {
      const k = key(c);
      if (seen.has(k)) continue;
      seen.add(k);
      this.order.push(c);
      this.enqueuedAt.set(k, now());
    }
    this.results.clear();
    this.signature = opts.signature;
    this.ctrl = new AbortController();
    this.runId += 1;
    this.status = "running";
    this.rest = opts.rest;
    this.restPending = true;
    this.launch();
    return this.snapshot();
  }

  private async run(runId: number, ctrl: AbortController): Promise<void> {
    const stale = () => ctrl.signal.aborted || runId !== this.runId;
    for (const c of [...this.order]) {
      if (stale()) return;
      if (this.results.get(key(c))?.state === "green") continue;
      await this.probeOne(c, ctrl, runId);
    }
    if (!this.restPending || stale()) return;
    const tail = await Promise.race([this.rest.catch(() => [] as SmokeCandidate[]), abortWait(ctrl.signal).then(() => null)]);
    if (stale()) return;
    this.restPending = false;
    if (tail === null) {
      this.restPending = true; // keep the ranking visible; retry() awaits the same promise
      return;
    }
    await this.runRestTail(tail, ctrl, runId, stale);
  }

  private async runRestTail(tail: SmokeCandidate[], ctrl: AbortController, runId: number, stale: () => boolean): Promise<void> {
    const seen = new Set(this.order.map(key));
    const now = this.deps.now ?? Date.now;
    for (const c of tail) {
      const k = key(c);
      if (seen.has(k)) continue;
      seen.add(k);
      this.order.push(c);
      this.enqueuedAt.set(k, now());
      this.emit();
      if (stale()) return;
      await this.probeOne(c, ctrl, runId);
    }
    this.emit();
  }

  /** Bounded wait for a channel's previous probe iterator to terminate. */
  private async drain(channel: string, ctrl: AbortController): Promise<"settled" | "aborted" | "slow"> {
    const prev = this.inflight.get(channel);
    if (!prev) return "settled";
    const drainMs = this.deps.drainMs ?? PROBE_DRAIN_MS;
    if (ctrl.signal.aborted) return "aborted";
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("slow"), drainMs);
      void prev.then(() => {
        clearTimeout(timer);
        resolve("settled");
      });
      ctrl.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve("aborted");
        },
        { once: true },
      );
    });
  }

  private trackSettled(channel: string, settledP: Promise<void>): void {
    this.inflight.set(channel, settledP);
    void settledP.then(() => {
      if (this.inflight.get(channel) === settledP) this.inflight.delete(channel);
      this.wedged.delete(channel);
    });
  }

  private putSkipped(c: SmokeCandidate, reason: string, prior: ProbeItem | undefined): void {
    this.results.set(key(c), {
      channel: c.channel,
      model: c.model,
      state: "skipped",
      reason: this.reason(reason),
      lastReason: prior?.lastReason ?? prior?.reason,
      attempts: prior?.attempts,
      waitMs: prior?.waitMs,
    });
    this.emit();
  }

  private async runSmokeAttempt(ch: SmokeChannel, c: SmokeCandidate, ctrl: AbortController): Promise<SmokeResult> {
    let settle!: () => void;
    const settledP = new Promise<void>((res) => {
      settle = res;
    });
    this.trackSettled(c.channel, settledP);
    let settleSeen = false;
    try {
      return await smokeModel(ch, c.model, {
        signal: ctrl.signal,
        timeoutMs: this.deps.timeoutMs,
        onSettle: (p) => {
          settleSeen = true;
          void p.then(settle, settle);
        },
      });
    } catch (error) {
      return { state: "red", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (!settleSeen) settle();
    }
  }

  private async probeOne(c: SmokeCandidate, ctrl: AbortController, runId: number): Promise<void> {
    const k = key(c);
    const now = this.deps.now ?? Date.now;
    const prior = this.results.get(k);
    const base = { channel: c.channel, model: c.model, attempts: (prior?.attempts ?? 0) + 1, lastReason: prior?.lastReason ?? prior?.reason };
    if (this.wedged.has(c.channel)) {
      this.putSkipped(c, "channel did not release the previous probe", prior);
      return;
    }
    const ch = this.deps.channelFor(c.channel);
    if (!ch) {
      this.results.set(k, { ...base, state: "red", reason: this.reason("channel not configured") });
      this.emit();
      return;
    }
    const drained = await this.drain(c.channel, ctrl);
    if (drained === "aborted" || runId !== this.runId) return;
    if (drained === "slow") {
      this.wedged.add(c.channel);
      this.putSkipped(c, "previous probe on this channel did not terminate", prior);
      return;
    }
    const enq = this.enqueuedAt.get(k);
    const waitMs = enq === undefined ? undefined : Math.max(0, now() - enq);
    const t0 = now();
    this.results.set(k, { ...base, state: "running", waitMs });
    this.emit();
    const r = await this.runSmokeAttempt(ch, c, ctrl);
    if (runId !== this.runId) return; // superseded run: discard the late result
    const state: SmokeState = r.state === "aborted" ? "skipped" : r.state;
    this.results.set(k, {
      ...base,
      state,
      reason: this.reason(state === "skipped" ? (prior?.lastReason ?? "stopped") : r.reason),
      waitMs,
      durationMs: Math.max(0, now() - t0),
    });
    this.emit();
  }

  /** Accept-and-continue: stop admitting candidates and abort the in-flight probe. Idempotent. */
  cancel(): ProbeSnapshot {
    if (this.status === "running") this.ctrl.abort();
    return this.snapshot();
  }

  private requeueResults(max: number, now: () => number): boolean {
    let any = false;
    for (const r of this.results.values()) {
      if (r.state !== "green" && (r.attempts ?? 1) < max) {
        r.lastReason = r.reason ?? r.lastReason;
        r.reason = undefined;
        r.state = "queued";
        this.enqueuedAt.set(key(r), now());
        any = true;
      }
    }
    return any;
  }

  private enqueueMissing(now: () => number): boolean {
    let any = false;
    for (const c of this.order) {
      const k = key(c);
      if (!this.results.has(k)) {
        this.enqueuedAt.set(k, now());
        any = true;
      }
    }
    return any;
  }

  /**
   * Re-queue every non-green result up to `maxAttempts` and resume. Explicit only;
   * prior attempt diagnostics (`lastReason`, `attempts`) are preserved.
   */
  retry(): ProbeSnapshot {
    if (this.status !== "done" && this.status !== "cancelled") return this.snapshot();
    const max = this.deps.maxAttempts ?? MAX_SMOKE_ATTEMPTS;
    const now = this.deps.now ?? Date.now;
    const any = this.requeueResults(max, now) || this.enqueueMissing(now);
    if (!any) return this.snapshot();
    this.ctrl = new AbortController();
    this.runId += 1;
    this.status = "running";
    this.launch();
    return this.snapshot();
  }
}

export interface RankCandidate extends SmokeCandidate {
  channelType: string;
  /** Compact capability/price hints for the ranking prompt. */
  detail?: string;
}

/** Deterministic fallback order: configured agents first, then smaller models, then name. */
export function fallbackOrder<T extends SmokeCandidate & { hasAgent?: boolean; sizeB?: number }>(cands: T[]): T[] {
  return [...cands].sort((a, b) => {
    if (!!a.hasAgent !== !!b.hasAgent) return a.hasAgent ? -1 : 1;
    const sa = a.sizeB ?? Number.POSITIVE_INFINITY;
    const sb = b.sizeB ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return key(a).localeCompare(key(b));
  });
}

/**
 * Provider-first split: Ollama candidates probe first, Claude CLI second, the rest
 * go to the evaluator ranking tail. Within local groups the deterministic
 * `fallbackOrder` applies.
 */
export function orderSmokeCandidates<T extends SmokeCandidate & { channelType: string; hasAgent?: boolean; sizeB?: number }>(
  cands: T[],
): { priority: SmokeCandidate[]; rest: T[] } {
  const local = cands.filter((c) => c.channelType === "ollama" || c.channelType === "claude-cli");
  const rest = cands.filter((c) => c.channelType !== "ollama" && c.channelType !== "claude-cli");
  const rank = (c: T) => (c.channelType === "ollama" ? 0 : 1);
  const priority = fallbackOrder(local).sort((a, b) => rank(a) - rank(b));
  return { priority: priority.map(({ channel, model }) => ({ channel, model })), rest: fallbackOrder(rest) };
}

/**
 * Ask the evaluator to order the non-local candidates by expected usefulness.
 * Returns the validated ordering (unknown/duplicate entries dropped, omitted
 * candidates appended in fallback order) or undefined on any failure.
 */
export async function rankCandidates(
  cands: RankCandidate[],
  channel: SmokeChannel,
  model: string,
  opts: { timeoutMs?: number } = {},
): Promise<SmokeCandidate[] | undefined> {
  if (!cands.length) return [];
  const timeoutMs = opts.timeoutMs ?? RANK_TIMEOUT_MS;
  const b = bounded(new AbortController().signal, timeoutMs);
  const it = channel
    .chat({ model, messages: [{ role: "user", content: rankPrompt(cands) }], maxTokens: 512, signal: b.signal })[Symbol.asyncIterator]();
  let text = "";
  try {
    for (;;) {
      const s = await step(() => it.next(), b.stop);
      if (s.kind === "stop" || s.kind === "error" || s.kind === "done") break;
      if (s.value.kind === "text") text += s.value.text;
    }
    if (!text.trim()) return undefined;
    return validateRanking(text, cands);
  } catch {
    return undefined;
  } finally {
    b.cleanup();
    void it.return?.()?.catch(() => {});
  }
}

function rankPrompt(cands: RankCandidate[]): string {
  const lines = cands.map((c) => `- ${key(c)} (${c.channelType}${c.detail ? `, ${c.detail}` : ""})`).join("\n");
  return [
    "Rank these model candidates for a coding assistant, most useful first.",
    "Weigh capability hints, cost and expected reliability; local models are already probed separately so rank only for general assistant work.",
    "",
    lines,
    "",
    'Reply ONLY a JSON object {"order":["channel:model", ...]} using the exact ids above. Include every id exactly once.',
  ].join("\n");
}

function validateRanking(text: string, cands: RankCandidate[]): SmokeCandidate[] | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: { order?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { order?: unknown };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.order)) return undefined;
  const known = new Map(cands.map((c) => [key(c), c]));
  const out: SmokeCandidate[] = [];
  const used = new Set<string>();
  for (const e of parsed.order) {
    if (typeof e !== "string") continue;
    const c = known.get(e);
    if (!c || used.has(e)) continue;
    used.add(e);
    out.push({ channel: c.channel, model: c.model });
  }
  for (const c of fallbackOrder(cands)) {
    const k = key(c);
    if (!used.has(k)) {
      used.add(k);
      out.push({ channel: c.channel, model: c.model });
    }
  }
  return out;
}
