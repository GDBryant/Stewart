import { describe, expect, it } from "vitest";
import { OllamaAdapter } from "../src/ollama.js";
import { OpenAICompatAdapter } from "../src/openai.js";
import { ManagedChannel } from "../src/registry.js";
import { fakeFetcher, collect } from "@stewart/kernel";
import type { ChatRequest } from "../src/types.js";

const req = (signal = new AbortController().signal): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal });

describe("OllamaAdapter", () => {
  it("streams NDJSON text, tool calls and usage", async () => {
    const { fetcher, calls } = fakeFetcher([
      {
        body: [
          '{"message":{"content":"hel"},"done":false}',
          '{"message":{"content":"lo","tool_calls":[{"function":{"name":"ReadFile","arguments":{"path":"a.ts"}}}]},"done":false}',
          '{"done":true,"prompt_eval_count":10,"eval_count":5,"done_reason":"stop"}',
        ],
      },
    ]);
    const evs = await collect(new OllamaAdapter({ fetcher }).chat({ id: "o", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 }, undefined, req()));
    expect(evs.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("")).toBe("hello");
    const tc = evs.find((e) => e.kind === "tool_calls");
    expect(tc && (tc as { calls: { name: string }[] }).calls[0].name).toBe("ReadFile");
    const done = evs.at(-1);
    expect(done?.kind === "done" && done.usage?.in).toBe(10);
    expect(calls[0].url).toBe("http://x/api/chat");
  });

  it("fails on malformed NDJSON and error lines (v1 semantics)", async () => {
    const { fetcher } = fakeFetcher([{ body: ["not json"] }]);
    await expect(collect(new OllamaAdapter({ fetcher }).chat({ id: "o", type: "ollama", enabled: true, maxParallel: 1 }, undefined, req()))).rejects.toThrow(/malformed/);
    const { fetcher: f2 } = fakeFetcher([{ body: ['{"error":"model x not found"}'] }]);
    await expect(collect(new OllamaAdapter({ fetcher: f2 }).chat({ id: "o", type: "ollama", enabled: true, maxParallel: 1 }, undefined, req()))).rejects.toThrow("model x not found");
  });

  it("lists models unioned with extraModels", async () => {
    const { fetcher } = fakeFetcher([{ body: '{"models":[{"name":"a"},{"name":"b"}]}' }]);
    const models = await new OllamaAdapter({ fetcher }).listModels({ id: "o", type: "ollama", enabled: true, extraModels: ["c"], maxParallel: 1 });
    expect(models).toEqual(["a", "b", "c"]);
  });
});

describe("OpenAICompatAdapter", () => {
  it("streams SSE deltas and reassembles streamed tool args", async () => {
    const { fetcher } = fakeFetcher([
      {
        body: [
          'data: {"choices":[{"delta":{"content":"he"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"EditFile","arguments":"{\\"pa"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
          "data: [DONE]",
        ],
      },
    ]);
    const evs = await collect(new OpenAICompatAdapter({ fetcher }).chat({ id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h/v1", maxParallel: 4 }, "sk", req()));
    const tc = evs.find((e) => e.kind === "tool_calls") as { calls: { name: string; arguments: { path: string } }[] } | undefined;
    expect(tc?.calls[0].name).toBe("EditFile");
    expect(tc?.calls[0].arguments.path).toBe("x");
  });

  it("throws ChannelError 429 with retry-after", async () => {
    const { fetcher } = fakeFetcher([{ status: 429, headers: { "retry-after": "2" } }]);
    const a = new OpenAICompatAdapter({ fetcher });
    await expect(collect(a.chat({ id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h", maxParallel: 4 }, undefined, req()))).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
  });
});

describe("ManagedChannel", () => {
  const mk = (fetches: { status?: number; body?: string[] }[], maxParallel = 1) => {
    const { fetcher } = fakeFetcher(fetches);
    return new ManagedChannel(new OllamaAdapter({ fetcher }), { id: "o", type: "ollama", enabled: true, maxParallel });
  };

  it("opens circuit breaker after 5 consecutive failures", async () => {
    const ch = mk([{ status: 500 }]);
    for (let i = 0; i < 5; i++) await expect(collect(ch.chat(req()))).rejects.toThrow();
    expect(ch.unhealthy).toBe(true);
    await expect(collect(ch.chat(req()))).rejects.toThrow(/unhealthy/);
  });

  it("backs off on 429 without counting as failure", async () => {
    const ch = mk([{ status: 429, body: [] }, { status: 429, body: [] }, { body: ['{"done":true}'] }], 1);
    // First two attempts 429 (no failure counted), third succeeds
    await expect(collect(ch.chat(req()))).rejects.toMatchObject({ status: 429 });
    await expect(collect(ch.chat(req()))).rejects.toMatchObject({ status: 429 });
    const evs = await collect(ch.chat(req()));
    expect(ch.unhealthy).toBe(false);
    expect(evs.at(-1)?.kind).toBe("done");
  });

  it("queues beyond maxParallel", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"done":true}'] }, { body: ['{"done":true}'] }]);
    const ch = new ManagedChannel(new OllamaAdapter({ fetcher }), { id: "o", type: "ollama", enabled: true, maxParallel: 1 });
    const r1 = collect(ch.chat(req()));
    const r2 = collect(ch.chat(req()));
    const [a, b] = await Promise.all([r1, r2]);
    expect(a.at(-1)?.kind).toBe("done");
    expect(b.at(-1)?.kind).toBe("done");
  });
});
