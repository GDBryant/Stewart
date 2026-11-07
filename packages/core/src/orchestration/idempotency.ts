import type { HostPort } from "../ports.js";
import type { IdempotencyHooks } from "../tools/toolLoop.js";

/**
 * Persisted tool-outcome log for one run. `/resume` skips calls whose outcome is
 * already recorded, so an interrupted run never re-executes a landed write.
 */
export class IdempotencyLog {
  private outcomes = new Map<string, string>();

  constructor(
    private host: HostPort,
    private path: string,
    private runId: string,
  ) {}

  async load(): Promise<void> {
    for (const line of await this.host.files.readLines(this.path)) {
      try {
        const e = JSON.parse(line) as { key: string; content: string };
        if (typeof e.key === "string" && typeof e.content === "string") this.outcomes.set(e.key, e.content);
      } catch {
        /* torn tail */
      }
    }
  }

  get(key: string): string | undefined {
    return this.outcomes.get(key);
  }

  async record(key: string, content: string): Promise<void> {
    this.outcomes.set(key, content);
    await this.host.files.appendLine(this.path, JSON.stringify({ key, content }));
  }

  get size(): number {
    return this.outcomes.size;
  }

  clearTask(taskId: string): void {
    const prefix = `${this.runId}:${taskId}:`;
    for (const k of [...this.outcomes.keys()]) {
      if (k.startsWith(prefix)) this.outcomes.delete(k);
    }
  }

  /** Hooks bound to one task so keys are `runId:taskId:callIndex`; `offset` shifts indices for continuations. */
  hooks(taskId: string, offset = 0): IdempotencyHooks {
    return {
      key: (_call, index) => `${this.runId}:${taskId}:${offset + index}`,
      lookup: (k) => this.get(k),
      record: (k, content) => this.record(k, content),
    };
  }
}
