import { describe, expect, it } from "vitest";
import type { Fetcher } from "@stewart/kernel";
import { collect } from "@stewart/kernel";
import { OpenAICompatAdapter } from "../src/openai.js";
import { BusinessPolicyError, ChannelError, type ChatRequest } from "../src/types.js";
import { FIRST_TOKEN_TIMEOUT, isTransientError } from "../src/transient.js";

const cfg = { id: "o", type: "openai-compatible", enabled: true, baseUrl: "http://x", maxParallel: 1 } as const;
const req = (signal = new AbortController().signal): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal });

describe("isTransientError", () => {
  it("accepts timeouts, 5xx, 429 and network errors", () => {
    expect(isTransientError(new ChannelError("x", 504))).toBe(true);
    expect(isTransientError(new ChannelError("x", 503))).toBe(true);
    expect(isTransientError(new ChannelError("x", 408))).toBe(true);
    expect(isTransientError(new ChannelError("rate limited", 429, 1000))).toBe(true);
    expect(isTransientError(new ChannelError("x", undefined, undefined, FIRST_TOKEN_TIMEOUT))).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("connection failed: ECONNRESET"))).toBe(true);
  });
  it("rejects auth/bad-request, aborts, policy errors and unknown errors", () => {
    expect(isTransientError(new ChannelError("x", 401))).toBe(false);
    expect(isTransientError(new ChannelError("x", 400))).toBe(false);
    expect(isTransientError(Object.assign(new Error("fetch failed"), { name: "AbortError" }))).toBe(false);
    expect(isTransientError(new BusinessPolicyError("c", []))).toBe(false);
    expect(isTransientError(new Error("malformed NDJSON line"))).toBe(false);
    expect(isTransientError("fetch failed")).toBe(false);
  });
});

describe("OpenAICompat first-token deadline", () => {
  const hang: Fetcher = (_u, init) =>
    new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));

  it("fails a request with no response as a transient first-token timeout", async () => {
    const a = new OpenAICompatAdapter({ fetcher: hang, firstTokenTimeoutMs: 20 });
    const e = await collect(a.chat(cfg, undefined, req())).catch((x) => x);
    expect(e).toBeInstanceOf(ChannelError);
    expect(e.code).toBe(FIRST_TOKEN_TIMEOUT);
    expect(isTransientError(e)).toBe(true);
  });
  it("keeps a caller abort as an abort, not a timeout", async () => {
    const ctl = new AbortController();
    const a = new OpenAICompatAdapter({ fetcher: hang, firstTokenTimeoutMs: 5_000 });
    const p = collect(a.chat(cfg, undefined, req(ctl.signal))).catch((x) => x);
    ctl.abort();
    const e = await p;
    expect(e.code).not.toBe(FIRST_TOKEN_TIMEOUT);
    expect(isTransientError(e)).toBe(false);
  });
  it("does not fire once data has arrived", async () => {
    const enc = new TextEncoder();
    const fetcher: Fetcher = async () => ({
      status: 200,
      headers: {},
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          setTimeout(() => {
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          }, 60);
        },
      }),
    });
    const evs = await collect(new OpenAICompatAdapter({ fetcher, firstTokenTimeoutMs: 20 }).chat(cfg, undefined, req()));
    expect(evs.some((e) => e.kind === "text" && e.text === "ok")).toBe(true);
  });
});
