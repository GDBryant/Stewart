import { ChannelError } from "./types.js";

/** Code carried by a `ChannelError` when no first byte arrived before the first-token deadline. */
export const FIRST_TOKEN_TIMEOUT = "first_token_timeout";

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection failed|network/i;

/**
 * True for a failure worth repeating unchanged: timeouts, rate limits, 5xx, a first-token timeout or a network error.
 * Auth/bad-request (other 4xx), aborts and policy errors are not transient.
 */
export function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error) || e.name === "AbortError") return false;
  if (e instanceof ChannelError) {
    if (e.code === FIRST_TOKEN_TIMEOUT) return true;
    if (e.status !== undefined) return e.status === 408 || e.status === 429 || e.status >= 500;
  }
  return e.name !== "BusinessPolicyError" && NETWORK.test(e.message);
}

/** An abort signal that also fires when no response data arrives within `ms`; `clear()` disarms it at the first byte. */
export function firstTokenDeadline(parent: AbortSignal, ms: number): { signal: AbortSignal; clear: () => void; timedOut: () => boolean; error: () => ChannelError } {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ctl.abort();
  }, ms);
  if (parent.aborted) ctl.abort();
  else parent.addEventListener("abort", () => ctl.abort(), { once: true });
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(timer),
    timedOut: () => fired && !parent.aborted,
    error: () => new ChannelError(`no response within ${Math.round(ms / 1000)} s (first-token timeout)`, undefined, undefined, FIRST_TOKEN_TIMEOUT),
  };
}
