import { describe, expect, it } from "vitest";
import { ManagedChannel, OllamaAdapter, OpenAICompatAdapter, ClaudeCliAdapter } from "../src/api.js";
import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest, SpawnFn } from "../src/api.js";
import { type DebugEntry, type DebugSink } from "@stewart/diagnostics";
import { collect, fakeFetcher } from "@stewart/kernel";

class Capture implements DebugSink {
  entries: DebugEntry[] = [];
  record(e: DebugEntry): void {
    this.entries.push(e);
  }
}

const req = (): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal });
const ollamaCfg: ChannelConfig = { id: "o", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 };
const openaiCfg: ChannelConfig = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1", maxParallel: 4 };

describe("adapter debug hooks", () => {
  it("Ollama records request with num_ctx prefix, each NDJSON chunk, and an incomplete-stream error", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":false}'] }]);
    const cfg = { ...ollamaCfg, modelCaps: { m: { numCtx: 8192 } } };
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(cfg, undefined, req()));
    expect(cap.entries[0]).toMatchObject({ direction: "outgoing", provider: "ollama", model: "m" });
    expect(cap.entries[0].payload.startsWith("num_ctx=8192 {")).toBe(true);
    expect(cap.entries[1]).toMatchObject({ direction: "incoming" });
    expect(cap.entries.at(-1)).toMatchObject({ direction: "error", payload: "stream ended before done" });
  });

  it("Ollama records HTTP errors and connection failures, then rethrows", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ status: 500, body: '{"error":"model x not found"}' }]);
    await expect(collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, req()))).rejects.toThrow("model x not found");
    expect(cap.entries.at(-1)).toMatchObject({ direction: "error" });
    expect(cap.entries.at(-1)?.payload.trim()).toBe('HTTP 500: {"error":"model x not found"}');

    const cap2 = new Capture();
    const failing = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(collect(new OllamaAdapter({ fetcher: failing, debug: cap2 }).chat(ollamaCfg, undefined, req()))).rejects.toThrow("ECONNREFUSED");
    expect(cap2.entries.map((e) => e.direction)).toEqual(["outgoing", "error"]);
    expect(cap2.entries[1].payload).toBe("connection failed: ECONNREFUSED");
  });

  it("negative: Ollama with no debug sink still streams normally", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"ok"},"done":false}', '{"done":true}'] }]);
    const evs = await collect(new OllamaAdapter({ fetcher }).chat(ollamaCfg, undefined, req()));
    expect(evs.some((e) => e.kind === "text")).toBe(true);
  });

  it("OpenAI-compatible records request, each SSE payload and HTTP errors", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['data: {"choices":[{"delta":{"content":"x"}}]}', "data: [DONE]"] }]);
    await collect(new OpenAICompatAdapter({ fetcher, debug: cap }).chat(openaiCfg, "sk", req()));
    expect(cap.entries[0]).toMatchObject({ direction: "outgoing", provider: "openai-compatible" });
    expect(cap.entries[1]).toMatchObject({ direction: "incoming", payload: '{"choices":[{"delta":{"content":"x"}}]}' });

    const cap2 = new Capture();
    const { fetcher: f2 } = fakeFetcher([{ status: 500, body: "boom" }]);
    await expect(collect(new OpenAICompatAdapter({ fetcher: f2, debug: cap2 }).chat(openaiCfg, "sk", req()))).rejects.toThrow(/500/);
    expect(cap2.entries.at(-1)?.payload.trim()).toBe("HTTP 500: boom");
  });

});

describe("Ollama context sizing", () => {
  it("autoNumCtx leaves small prompts alone and sizes large ones within caps", async () => {
    const { autoNumCtx, estimatePromptTokens } = await import("../src/ollama.js");
    expect(autoNumCtx(500)).toBeUndefined();
    expect(autoNumCtx(3000)).toBe(5120);
    expect(autoNumCtx(100_000)).toBe(32768);
    expect(autoNumCtx(3000, 4096)).toBe(4096);
    expect(estimatePromptTokens([{ content: "x".repeat(350) }], undefined)).toBeGreaterThan(100);
  });

  it("records an error when the provider evaluated far fewer tokens than sent", async () => {
    const cap = new Capture();
    const big = "x".repeat(20_000);
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":true,"prompt_eval_count":500,"eval_count":1}'] }]);
    const r = { ...req(), messages: [{ role: "user" as const, content: big }] };
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, r));
    expect(cap.entries[0].payload.startsWith("num_ctx=")).toBe(true);
    expect(cap.entries[0].payload).not.toContain("num_ctx=default");
    expect(cap.entries.some((e) => e.direction === "error" && e.payload.includes("prompt truncated"))).toBe(true);
  });

  it("does not flag truncation when counts match", async () => {
    const cap = new Capture();
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":true,"prompt_eval_count":12,"eval_count":1}'] }]);
    await collect(new OllamaAdapter({ fetcher, debug: cap }).chat(ollamaCfg, undefined, req()));
    expect(cap.entries.some((e) => e.direction === "error")).toBe(false);
  });
});
