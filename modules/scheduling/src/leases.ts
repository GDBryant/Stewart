/**
 * Per-file write leases for parallel tasks. Reads are never blocked. An
 * undeclared write acquires its lease on demand and waits; an AB-BA wait cycle
 * is detected immediately and resolved by re-queueing the younger task instead
 * of stalling until timeout.
 */
export type LeaseResult = { kind: "granted" } | { kind: "timeout" } | { kind: "cycle"; victim: string };

interface Waiter {
  path: string;
  taskId: string;
  resolve(r: LeaseResult): void;
}

export class LeaseManager {
  private held = new Map<string, string>();
  private waiters: Waiter[] = [];
  private waitsOn = new Map<string, Set<string>>();
  private ages = new Map<string, number>();
  private seq = 0;

  register(taskId: string): void {
    if (!this.ages.has(taskId)) this.ages.set(taskId, ++this.seq);
  }

  /** Younger task wins the tie-break as the one to re-queue. */
  age(taskId: string): number {
    return this.ages.get(taskId) ?? ++this.seq;
  }

  holder(path: string): string | undefined {
    return this.held.get(path);
  }

  heldBy(taskId: string): string[] {
    return [...this.held.entries()].filter(([, t]) => t === taskId).map(([p]) => p);
  }

  tryAcquire(path: string, taskId: string): boolean {
    this.register(taskId);
    const holder = this.held.get(path);
    if (holder === undefined || holder === taskId) {
      this.held.set(path, taskId);
      return true;
    }
    return false;
  }

  /** Grant now or wait for the holder; reports the cycle victim when one forms. */
  acquire(path: string, taskId: string, timeoutMs: number, onWait?: (holder: string) => void): Promise<LeaseResult> {
    this.register(taskId);
    if (this.tryAcquire(path, taskId)) return Promise.resolve({ kind: "granted" });
    const holder = this.held.get(path)!;
    const waits = this.waitsOn.get(taskId) ?? new Set<string>();
    this.waitsOn.set(taskId, waits);
    waits.add(holder);
    const cycle = this.findCycle(taskId);
    if (cycle) {
      waits.delete(holder);
      return Promise.resolve({ kind: "cycle", victim: this.youngest(cycle) });
    }
    onWait?.(holder);
    return new Promise<LeaseResult>((resolve) => {
      const waiter: Waiter = { path, taskId, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waits.delete(holder);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      const done = waiter.resolve;
      waiter.resolve = (r) => {
        clearTimeout(timer);
        done(r);
      };
    });
  }

  /** Release every lease a task holds and wake the waiters it was blocking. */
  release(taskId: string): void {
    const freed: string[] = [];
    for (const [p, t] of [...this.held.entries()]) {
      if (t !== taskId) continue;
      this.held.delete(p);
      freed.push(p);
    }
    this.waitsOn.delete(taskId);
    for (const p of freed) {
      const w = this.waiters.find((x) => x.path === p);
      if (!w) continue;
      this.waiters = this.waiters.filter((x) => x !== w);
      this.held.set(p, w.taskId);
      this.waitsOn.get(w.taskId)?.delete(taskId);
      w.resolve({ kind: "granted" });
    }
  }

  releaseAll(): void {
    this.held.clear();
    this.waitsOn.clear();
    for (const w of this.waiters) w.resolve({ kind: "timeout" });
    this.waiters = [];
  }

  /** DFS over "waits for" edges; returns the cycle path when one closes on taskId. */
  private findCycle(taskId: string): string[] | undefined {
    const seen = new Set<string>();
    const path: string[] = [];
    const walk = (id: string): boolean => {
      if (id === taskId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      path.push(id);
      for (const next of this.waitsOn.get(id) ?? []) if (walk(next)) return true;
      path.pop();
      return false;
    };
    for (const next of this.waitsOn.get(taskId) ?? []) if (walk(next)) return [taskId, ...path];
    return undefined;
  }

  private youngest(cycle: string[]): string {
    let victim = cycle[0];
    for (const id of cycle) if (this.age(id) > this.age(victim)) victim = id;
    return victim;
  }
}
