import { ChannelDrain } from "./probeDrain.js";
import { abortWait } from "./smoke.js";
import {
  attemptBase,
  key,
  MAX_SMOKE_ATTEMPTS,
  normalizeReason,
  type ProbeCounts,
  type ProbeItem,
  type ProbeRunnerDeps,
  type ProbeSnapshot,
  type ProbeStatus,
  type SmokeCandidate,
  type SmokeResult,
  type SmokeState,
} from "./probeTypes.js";

export {
  MAX_SMOKE_ATTEMPTS,
  normalizeReason,
  PROBE_DRAIN_MS,
  RANK_TIMEOUT_MS,
  SMOKE_TIMEOUT_MS,
} from "./probeTypes.js";
export { smokeModel } from "./smoke.js";
export { fallbackOrder, orderSmokeCandidates, rankCandidates } from "./rank.js";
export type {
  ProbeCounts,
  ProbeItem,
  ProbeRunnerDeps,
  ProbeSnapshot,
  ProbeStatus,
  RankCandidate,
  SmokeCandidate,
  SmokeChannel,
  SmokeOptions,
  SmokeResult,
  SmokeState,
  SmokeVerdict,
} from "./probeTypes.js";

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
  private readonly busy: ChannelDrain;

  constructor(private readonly deps: ProbeRunnerDeps) {
    this.busy = new ChannelDrain(deps);
  }

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

  private async probeOne(c: SmokeCandidate, ctrl: AbortController, runId: number): Promise<void> {
    const k = key(c);
    const now = this.deps.now ?? Date.now;
    const prior = this.results.get(k);
    const base = attemptBase(c, prior);
    if (this.busy.isWedged(c.channel)) {
      this.putSkipped(c, "channel did not release the previous probe", prior);
      return;
    }
    const ch = this.deps.channelFor(c.channel);
    if (!ch) {
      this.results.set(k, { ...base, state: "red", reason: this.reason("channel not configured") });
      this.emit();
      return;
    }
    const drained = await this.busy.drain(c.channel, ctrl);
    if (drained === "aborted" || runId !== this.runId) return;
    if (drained === "slow") {
      this.busy.markWedged(c.channel);
      this.putSkipped(c, "previous probe on this channel did not terminate", prior);
      return;
    }
    const enq = this.enqueuedAt.get(k);
    const waitMs = enq === undefined ? undefined : Math.max(0, now() - enq);
    const t0 = now();
    this.results.set(k, { ...base, state: "running", waitMs });
    this.emit();
    const r = await this.busy.attempt(ch, c, ctrl);
    if (runId !== this.runId) return; // superseded run: discard the late result
    const { state, reason } = this.settle(r, prior);
    this.results.set(k, { ...base, state, reason, waitMs, durationMs: Math.max(0, now() - t0) });
    this.emit();
  }

  /** Map an attempt verdict to the stored state; an aborted attempt is reported as skipped. */
  private settle(r: SmokeResult, prior: ProbeItem | undefined): { state: SmokeState; reason: string | undefined } {
    const state: SmokeState = r.state === "aborted" ? "skipped" : r.state;
    return { state, reason: this.reason(state === "skipped" ? (prior?.lastReason ?? "stopped") : r.reason) };
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
