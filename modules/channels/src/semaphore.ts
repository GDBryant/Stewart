/** Counting semaphore with FIFO atomic handoff: a released slot goes straight to the next waiter, so no late caller can slip in. */
export class Semaphore {
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private limit: number) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
  }

  release(): void {
    if (this.running > this.limit || !this.waiters.length) {
      this.running--;
      return;
    }
    this.waiters.shift()!();
  }

  /** Applies a new limit; a raised limit admits waiting callers immediately. */
  setLimit(limit: number): void {
    this.limit = limit;
    while (this.running < this.limit && this.waiters.length) {
      this.running++;
      this.waiters.shift()!();
    }
  }
}
