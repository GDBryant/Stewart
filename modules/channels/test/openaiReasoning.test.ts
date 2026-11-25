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

import { ManagedChannel } from "../src/registry.js";
import { ChannelRegistry } from "../src/registry.js";
import { ChannelService } from "../src/service.js";
import { ChannelError } from "../src/types.js";

const SSE = ['data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}', "data: [DONE]"];
const abort = () => new AbortController().signal;
const chatReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], signal: abort(), ...over });

describe("ChannelService → ManagedChannel (production wiring)", () => {
  async function wired(reasoning: string | undefined, fetches: Parameters<typeof fakeFetcher>[0], modelCaps?: ChannelConfig["modelCaps"]) {
    const f = fakeFetcher(fetches);
    const registry = new ChannelRegistry();
    registry.register("openai-compatible", () => new OpenAICompatAdapter({ fetcher: f.fetcher }));
    const svc = new ChannelService({ registry, adapterDeps: {} });
    const host = { secrets: { get: async () => undefined }, log: () => {} };
    const row = { id: "a", type: "openai-compatible", enabled: true, baseUrl: "https://h", ...(reasoning ? { reasoning } : {}), ...(modelCaps ? { modelCaps } : {}) };
    await svc.rebuild([row], host);
    return { mc: svc.get("a")!, calls: f.calls, svc, host, row };
  }

  it("a channels.yaml row with reasoning: enable_thinking puts the field on the wire for think:false", async () => {
    const { mc, calls } = await wired("enable_thinking", [{ body: SSE }]);
    expect(mc.cfg.reasoning).toBe("enable_thinking");
    expect(mc.reasoningRouting("m")).toBe(true);
    for await (const _ of mc.chat(chatReq({ think: false }))) void _;
    expect(JSON.parse(calls[0].body!).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("without the key nothing is sent and routing is off; a probed false suppresses the field after a reload", async () => {
    const none = await wired(undefined, [{ body: SSE }]);
    expect(none.mc.reasoningRouting("m")).toBe(false);
    for await (const _ of none.mc.chat(chatReq({ think: false }))) void _;
    expect("chat_template_kwargs" in JSON.parse(none.calls[0].body!)).toBe(false);

    const probed = await wired("reasoning_effort", [{ body: SSE }, { body: SSE }], { m: { reasoningControl: false } });
    expect(probed.mc.reasoningRouting("m")).toBe(false);
    for await (const _ of probed.mc.chat(chatReq({ think: false }))) void _;
    expect("reasoning_effort" in JSON.parse(probed.calls[0].body!)).toBe(false);
    // a reload that clears the probe result (fresh row without caps) turns it back on
    await probed.svc.rebuild([{ ...probed.row, modelCaps: {} }], probed.host);
    const reloaded = probed.svc.get("a")!;
    expect(reloaded.reasoningRouting("m")).toBe(true);
    for await (const _ of reloaded.chat(chatReq({ think: false }))) void _;
    expect(JSON.parse(probed.calls[1].body!).reasoning_effort).toBe("none");
  });
});

describe("reasoning field rejected by the provider", () => {
  const mk = (fetches: Parameters<typeof fakeFetcher>[0]) => {
    const f = fakeFetcher(fetches);
    const mc = new ManagedChannel(new OpenAICompatAdapter({ fetcher: f.fetcher }), cfg("reasoning_effort"));
    return { mc, calls: f.calls };
  };
  const run = async (mc: ManagedChannel, req: ChatRequest) => {
    const evs = [];
    for await (const e of mc.chat(req)) evs.push(e);
    return evs;
  };

  it("a 400 on a request that carried the field is retried once without it and remembered", async () => {
    const { mc, calls } = mk([{ status: 400, body: "unknown field reasoning_effort" }, { body: SSE }, { body: SSE }]);
    const evs = await run(mc, chatReq({ effort: "medium" }));
    expect(evs.some((e) => e.kind === "text")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body!).reasoning_effort).toBe("medium");
    expect("reasoning_effort" in JSON.parse(calls[1].body!)).toBe(false);
    expect(mc.reasoningRouting("m")).toBe(false);
    await run(mc, chatReq({ effort: "high", think: false })); // later requests never carry it
    expect(calls).toHaveLength(3);
    expect("reasoning_effort" in JSON.parse(calls[2].body!)).toBe(false);
  });

  it("422 behaves the same; update() forgets the rejection", async () => {
    const { mc, calls } = mk([{ status: 422, body: "bad" }, { body: SSE }, { body: SSE }]);
    await run(mc, chatReq({ think: false }));
    expect(mc.reasoningRouting("m")).toBe(false);
    mc.update({ ...mc.cfg });
    expect(mc.reasoningRouting("m")).toBe(true);
    await run(mc, chatReq({ think: false }));
    expect(JSON.parse(calls[2].body!).reasoning_effort).toBe("none");
  });

  it("other failures are not retried: a 500, a 400 on a request without the field, and a second 400 after the retry", async () => {
    const a = mk([{ status: 500, body: "boom" }]);
    await expect(run(a.mc, chatReq({ effort: "low" }))).rejects.toBeInstanceOf(ChannelError);
    expect(a.calls).toHaveLength(1);
    expect(a.mc.reasoningRouting("m")).toBe(true);
    const b = mk([{ status: 400, body: "bad" }]);
    await expect(run(b.mc, chatReq())).rejects.toMatchObject({ status: 400 }); // no think/effort → no field sent → no retry
    expect(b.calls).toHaveLength(1);
    const c = mk([{ status: 400, body: "bad" }, { status: 400, body: "still bad" }]);
    await expect(run(c.mc, chatReq({ effort: "low" }))).rejects.toMatchObject({ status: 400 });
    expect(c.calls).toHaveLength(2);
  });
});
