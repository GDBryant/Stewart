import type { ChatEvent, ChatRequest } from "@stewart/channels";

/** Hard per-candidate deadline for the setup quick probe. */
export const SMOKE_TIMEOUT_MS = 30_000;
/** Deadline for the evaluator's usefulness ranking of non-local candidates. */
export const RANK_TIMEOUT_MS = 20_000;
/** Max wait for a channel's previous probe to fully terminate before skipping same-channel candidates. */
export const PROBE_DRAIN_MS = 10_000;
/** Per-candidate attempt cap across explicit retries. */
export const MAX_SMOKE_ATTEMPTS = 3;

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

export interface RankCandidate extends SmokeCandidate {
  channelType: string;
  /** Compact capability/price hints for the ranking prompt. */
  detail?: string;
}

export const key = (c: SmokeCandidate) => `${c.channel}:${c.model}`;

/** The fields every result for this candidate carries; `attempts` counts this probe and `lastReason` keeps the prior failure. */
export const attemptBase = (c: SmokeCandidate, prior: ProbeItem | undefined) => ({
  channel: c.channel,
  model: c.model,
  attempts: (prior?.attempts ?? 0) + 1,
  lastReason: prior?.lastReason ?? prior?.reason,
});

const REASON_MAX = 160;

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
