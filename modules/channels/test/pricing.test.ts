import { describe, expect, it } from "vitest";
import { ManagedChannel, OllamaAdapter, OpenAICompatAdapter, ClaudeCliAdapter } from "../src/api.js";
import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest, SpawnFn } from "../src/api.js";
import { fakeFetcher } from "@stewart/kernel";

describe("priceList", () => {
  const cfg = { id: "o", type: "openai-compatible", enabled: true, baseUrl: "https://openrouter.ai/api/v1", maxParallel: 1 };

  it("parses OpenRouter-style pricing into USD per MTok", async () => {
    const { fetcher } = fakeFetcher([
      { body: [JSON.stringify({ data: [{ id: "a", pricing: { prompt: "0.000001", completion: "0.000002" } }, { id: "b" }] })] },
    ]);
    const ch = new ManagedChannel(new OpenAICompatAdapter({ fetcher }), cfg);
    expect(await ch.priceList()).toEqual({ a: { inPerMTok: 1, outPerMTok: 2 } });
  });

  it("returns undefined when the list has no pricing fields, and when the adapter lacks the method", async () => {
    const { fetcher } = fakeFetcher([{ body: [JSON.stringify({ data: [{ id: "a" }] })] }]);
    const ch = new ManagedChannel(new OpenAICompatAdapter({ fetcher }), cfg);
    expect(await ch.priceList()).toBeUndefined();
    const ollama = new ManagedChannel(new OllamaAdapter({ fetcher }), { id: "ol", type: "ollama", enabled: true, baseUrl: "http://x", maxParallel: 1 });
    expect(await ollama.priceList()).toBeUndefined();
  });
});
