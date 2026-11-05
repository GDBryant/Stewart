import type { RunEvent } from "@stewart/protocol";

export type EventSink = (ev: RunEvent) => void;

const DELTA_KINDS = new Set<RunEvent["kind"]>(["text_delta", "reasoning_delta"]);

/**
 * Coalesces high-frequency stream deltas into 30ms frames per (runId, taskId,
 * kind) so parallel tasks cannot saturate stdio JSON-RPC or freeze the webview.
 * All other events flush immediately (and flush pending deltas first).
 */
export class EventBus {
  private pending = new Map<string, { text: string; seq: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private sink: EventSink, private frameMs = 30) {}

  emit(ev: RunEvent): void {
    if (DELTA_KINDS.has(ev.kind)) {
      const e = ev as Extract<RunEvent, { kind: "text_delta" }>;
      const key = `${e.runId}:${e.taskId ?? ""}:${e.kind}`;
      const p = this.pending.get(key) ?? { text: "", seq: 0 };
      p.text += e.text;
      this.pending.set(key, p);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.frameMs);
      return;
    }
    this.flush();
    this.sink(ev);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [key, p] of this.pending) {
      const [runId, taskId, kind] = key.split(":", 3);
      this.sink({ kind: kind as "text_delta", runId, taskId: taskId || undefined, seq: p.seq++, text: p.text });
    }
    this.pending.clear();
  }
}
