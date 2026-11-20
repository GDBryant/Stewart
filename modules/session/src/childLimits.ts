const MAX_CHILDREN = 4;

/** Child concurrency: a cap of MAX_CHILDREN running tasks plus a FIFO read/write lock (a waiting writer blocks later readers; readers share). */
export class ChildLimiter {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readers = 0;
  private writerActive = false;
  private readonly lockWaiters: { writer: boolean; grant: () => void }[] = [];

  private async acquire(): Promise<void> {
    if (this.running < MAX_CHILDREN) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  private pump(): void {
    while (this.lockWaiters.length && !this.lockWaiters[0].writer) this.lockWaiters.shift()!.grant();
    if (this.lockWaiters[0]?.writer && this.readers === 0 && !this.writerActive) this.lockWaiters.shift()!.grant();
  }

  private acquireLock(writer: boolean): Promise<void> {
    const take = () => (writer ? void (this.writerActive = true) : void this.readers++);
    if (!this.writerActive && (writer ? this.readers === 0 : true) && !this.lockWaiters.length) {
      take();
      return Promise.resolve();
    }
    return new Promise<void>((r) => this.lockWaiters.push({ writer, grant: () => { take(); r(); } }));
  }

  async asReader<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(false);
    try {
      return await fn();
    } finally {
      this.readers--;
      if (this.readers === 0) this.pump();
    }
  }

  async limited<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** One writer at a time: waits for running readers and blocks readers queued after it. */
  async asWriter<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(true);
    try {
      return await fn();
    } finally {
      this.writerActive = false;
      this.pump();
    }
  }
}
