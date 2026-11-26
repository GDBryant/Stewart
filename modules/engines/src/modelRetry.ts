import { isTransientError } from "@stewart/channels";

/** Waits before the 1st and 2nd repeat of a request that failed with a transient provider error. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

/** Resolves after `ms`, or early when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A request may be repeated unchanged only when it failed transiently before producing anything. */
export function retryable(e: unknown, produced: boolean, attempt: number, delays: readonly number[]): boolean {
  return !produced && attempt < delays.length && isTransientError(e);
}
