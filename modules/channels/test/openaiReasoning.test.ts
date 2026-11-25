import { describe, expect, it } from "vitest";
import { OpenAICompatAdapter } from "../src/openai.js";
import { probeReasoningControl, reasoningBody, reasoningRouting, reasoningTokensOf, type ProbePost } from "../src/openaiReasoning.js";
import { collect, fakeFetcher } from "@stewart/kernel";
import type { ChannelConfig, ChatRequest } from "../src/types.js";

const cfg = (reasoning?: string, modelCaps?: ChannelConfig["modelCaps"]): ChannelConfig => ({ id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h", maxParallel: 4, reasoning, modelCaps });
const body = (c: ChannelConfig, r: Partial<ChatRequest>) => reasoningBody(c, { model: "m", ...r });

describe("reasoningBody", () => {
  it("none (default or unknown value) sends nothing", () => {
    expect(body(cfg(), { think: false })).toEqual({});
    expect(body(cfg("none"), { think: false, effort: "high" })).toEqual({});
    expect(body(cfg("bogus"), { think: false })).toEqual({});
  });

  it("reasoning_effort: think false is the off value and beats effort; effort maps through, max → high; unset sends nothing", () => {
    const c = cfg("reasoning_effort");
    expect(body(c, { think: false, effort: "high" })).toEqual({ reasoning_effort: "none" });
    expect(body(c, { effort: "low" })).toEqual({ reasoning_effort: "low" });
    expect(body(c, { effort: "medium" })).toEqual({ reasoning_effort: "medium" });
    expect(body(c, { effort: "max" })).toEqual({ reasoning_effort: "high" });
    expect(body(c, {})).toEqual({});
  });

  it("enable_thinking: think false → false; think true or effort high/max → true; low/medium/unset send nothing", () => {
    const c = cfg("enable_thinking");
    expect(body(c, { think: false, effort: "max" })).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(body(c, { think: true })).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(body(c, { effort: "high" })).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(body(c, { effort: "low" })).toEqual({});
    expect(body(c, {})).toEqual({});
  });

  it("never sends the field when the probe says unsupported; probe true or unprobed still sends", () => {
    expect(body(cfg("reasoning_effort", { m: { reasoningControl: false } }), { think: false })).toEqual({});
    expect(reasoningRouting(cfg("reasoning_effort", { m: { reasoningControl: false } }), "m")).toBe(false);
    expect(body(cfg("reasoning_effort", { m: { reasoningControl: true } }), { think: false })).toEqual({ reasoning_effort: "none" });
    expect(body(cfg("reasoning_effort", { other: { reasoningControl: false } }), { think: false })).toEqual({ reasoning_effort: "none" });
  });
});

describe("wire", () => {
  it("the chat body carries the configured field, and nothing for a none channel", async () => {
    const { fetcher, calls } = fakeFetcher([{ body: ["data: [DONE]"] }, { body: ["data: [DONE]"] }]);
    const a = new OpenAICompatAdapter({ fetcher });
    const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }], think: false, signal: new AbortController().signal };
    await collect(a.chat(cfg("reasoning_effort"), undefined, req));
    expect(JSON.parse(calls[0].body!).reasoning_effort).toBe("none");
    await collect(a.chat(cfg("none"), undefined, req));
    expect("reasoning_effort" in JSON.parse(calls[1].body!)).toBe(false);
  });
});

describe("reasoningTokensOf", () => {
  it("reads top-level and nested counts, else 0", () => {
    expect(reasoningTokensOf({ usage: { reasoning_tokens: 5 } })).toBe(5);
    expect(reasoningTokensOf({ usage: { completion_tokens_details: { reasoning_tokens: 7 } } })).toBe(7);
    expect(reasoningTokensOf({ usage: {} })).toBe(0);
    expect(reasoningTokensOf(undefined)).toBe(0);
  });
});

describe("probeReasoningControl", () => {
  const post = (...rs: { status: number; reasoning?: number }[]): ProbePost => {
    let i = 0;
    return async () => {
      const r = rs[i++];
      return { status: r.status, json: { usage: { reasoning_tokens: r.reasoning ?? 0 } } };
    };
  };
  const c = cfg("reasoning_effort");

  it("true when the off request reports fewer reasoning tokens", async () => {
    expect(await probeReasoningControl(c, "m", post({ status: 200, reasoning: 300 }, { status: 200, reasoning: 0 }))).toBe(true);
  });

  it("false when the off request does not cut them or is rejected", async () => {
    expect(await probeReasoningControl(c, "m", post({ status: 200, reasoning: 300 }, { status: 200, reasoning: 300 }))).toBe(false);
    expect(await probeReasoningControl(c, "m", post({ status: 200, reasoning: 300 }, { status: 400 }))).toBe(false);
  });

  it("undefined when nothing to control (no baseline reasoning), the baseline failed, or the post throws", async () => {
    expect(await probeReasoningControl(c, "m", post({ status: 200, reasoning: 0 }))).toBeUndefined();
    expect(await probeReasoningControl(c, "m", post({ status: 500 }))).toBeUndefined();
    expect(await probeReasoningControl(c, "m", async () => Promise.reject(new Error("x")))).toBeUndefined();
  });

  it("the off request carries the off field even when the model is marked unsupported", async () => {
    const sent: Record<string, unknown>[] = [];
    await probeReasoningControl(cfg("reasoning_effort", { m: { reasoningControl: false } }), "m", async (b) => {
      sent.push(b);
      return { status: 200, json: { usage: { reasoning_tokens: sent.length === 1 ? 9 : 0 } } };
    });
    expect(sent[1].reasoning_effort).toBe("none");
    expect("reasoning_effort" in sent[0]).toBe(false);
  });
});

describe("OpenAICompatAdapter.probeCaps reasoning", () => {
  const ok = (usage: object, tool = false) => JSON.stringify({ choices: [{ message: tool ? { tool_calls: [] } : {} }], usage });

  it("adds reasoningControl for a channel with a reasoning field", async () => {
    const { fetcher } = fakeFetcher([{ body: ok({}, true) }, { body: ok({ reasoning_tokens: 200 }) }, { body: ok({ reasoning_tokens: 0 }) }]);
    const caps = await new OpenAICompatAdapter({ fetcher }).probeCaps(cfg("reasoning_effort"), undefined, "m");
    expect(caps).toEqual({ tools: "native", reasoningControl: true });
  });

  it("does not probe reasoning on a none channel, and omits the key when inconclusive", async () => {
    const { fetcher, calls } = fakeFetcher([{ body: ok({}, true) }]);
    expect(await new OpenAICompatAdapter({ fetcher }).probeCaps(cfg("none"), undefined, "m")).toEqual({ tools: "native" });
    expect(calls).toHaveLength(1);
    const f2 = fakeFetcher([{ body: ok({}, true) }, { body: ok({}) }]);
    expect(await new OpenAICompatAdapter({ fetcher: f2.fetcher }).probeCaps(cfg("reasoning_effort"), undefined, "m")).toEqual({ tools: "native" });
  });
});
