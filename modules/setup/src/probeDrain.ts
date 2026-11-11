import { smokeModel } from "./smoke.js";
import { PROBE_DRAIN_MS, type ProbeRunnerDeps, type SmokeCandidate, type SmokeChannel, type SmokeResult } from "./probeTypes.js";

/**
 * Per-channel in-flight tracking for the probe queue. Each probe registers its channel
 * as busy until its iterator fully terminates; a new probe on that channel waits up to
 * `drainMs`, and a channel that never releases is marked wedged.
 */
export class ChannelDrain {
  /** channel -> promise resolving when that channel's last probe iterator fully terminates. */
  private inflight = new Map<string, Promise<void>>();
  /** channels whose previous probe iterator did not terminate within drainMs. */
  private wedged = new Set<string>();

  constructor(private readonly deps: ProbeRunnerDeps) {}

  isWedged(channel: string): boolean {
    return this.wedged.has(channel);
  }

  markWedged(channel: string): void {
    this.wedged.add(channel);
  }

  /** Bounded wait for a channel's previous probe iterator to terminate. */
  async drain(channel: string, ctrl: AbortController): Promise<"settled" | "aborted" | "slow"> {
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

  private track(channel: string, settledP: Promise<void>): void {
    this.inflight.set(channel, settledP);
    void settledP.then(() => {
      if (this.inflight.get(channel) === settledP) this.inflight.delete(channel);
      this.wedged.delete(channel);
    });
  }

  /** Run one smoke attempt, registering its channel as in-flight until the iterator terminates. */
  async attempt(ch: SmokeChannel, c: SmokeCandidate, ctrl: AbortController): Promise<SmokeResult> {
    let settle!: () => void;
    const settledP = new Promise<void>((res) => {
      settle = res;
    });
    this.track(c.channel, settledP);
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
}
