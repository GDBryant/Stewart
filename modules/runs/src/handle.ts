import type { EventBus } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

/**
 * The §4 sketch surface: `RunService.start/resume → RunHandle`. `events` is an
 * AsyncIterable view of the shared EventBus filtered to this run — it consumes
 * the bus, it does not duplicate it. Events buffer until iterated, so a handle
 * created before `run.started` still yields it; the stream ends after
 * `run.finished` or `run.reverted`.
 */
export interface RunHandle {
  id: string;
  events: AsyncIterable<RunEvent>;
}

const TERMINAL_EVENTS = new Set(["run.finished", "run.reverted"]);

export function runHandle(bus: Pick<EventBus, "subscribe">, runId: string): RunHandle {
  const queue: RunEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const unsubscribe = bus.subscribe((ev) => {
    const e = ev as { runId?: string; kind?: string };
    if (e.runId !== runId) return;
    queue.push(ev);
    if (e.kind && TERMINAL_EVENTS.has(e.kind)) ended = true;
    wake?.();
  });
  return {
    id: runId,
    events: {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            while (queue.length) yield queue.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
          }
        } finally {
          unsubscribe();
        }
      },
    },
  };
}
