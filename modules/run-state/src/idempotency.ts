import type { HostPort, IdempotencyHooks, Json, ToolCall } from "@stewart/kernel";

function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, Json>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** cyrb53: 53-bit string hash, enough to tell two argument sets apart (not a security boundary). */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Identity of a call's work: tool name + argument hash, so a replay can never answer a different call. */
function callFingerprint(call: ToolCall): string {
  return `${call.name}:${hash53(stable(call.arguments))}`;
}

/**
 * Persisted tool-outcome log for one run. `/resume` skips calls whose outcome is
 * already recorded, so an interrupted run never re-executes a landed write.
 */
export class IdempotencyLog {
  private outcomes = new Map<string, string>();

  constructor(
    private host: Pick<HostPort, "files">,
    private path: string,
    private runId: string,
  ) {}

  /** Starts a fresh run: drops the in-memory outcomes and any file left by an earlier run that reused this run id. A failed delete is not fatal: keys carry the call fingerprint, so leftovers cannot answer a different call. */
  async reset(): Promise<void> {
    this.outcomes.clear();
    try {
      await this.host.files.delete(this.path);
    } catch {
      /* best effort */
    }
  }

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

  /** Hooks bound to one task so keys are `runId:taskId:callIndex:tool:argsHash`; `offset` shifts indices for continuations. */
  hooks(taskId: string, offset = 0): IdempotencyHooks {
    return {
      key: (call, index) => `${this.runId}:${taskId}:${offset + index}:${callFingerprint(call)}`,
      lookup: (k) => this.get(k),
      record: (k, content) => this.record(k, content),
    };
  }
}
