import { describe, expect, it } from "vitest";
import { resolveEvalChannel, resolveEvaluator, smokeState } from "../src/wizardDerived.js";
import { isUnmeteredAgent } from "../src/agentExtra.js";
import type { AgentSummary, ChannelSummary } from "../src/bridge.js";

const ch = (id: string) => ({ id } as ChannelSummary);
const pair = (channel: string, model: string) => ({ channel, model });

describe("resolveEvalChannel", () => {
  it("keeps the requested channel when it is offered", () => {
    expect(resolveEvalChannel([ch("a"), ch("b")], "b")).toBe("b");
  });
  it("falls back to the first offered channel when the request is not offered", () => {
    expect(resolveEvalChannel([ch("a"), ch("b")], "zzz")).toBe("a");
  });
  it("returns an empty string when no channel is offered", () => {
    expect(resolveEvalChannel([], "a")).toBe("");
  });
});

describe("resolveEvaluator", () => {
  it("keeps the requested evaluator when it is an option", () => {
    expect(resolveEvaluator([{ v: "x" }, { v: "y" }], "y")).toBe("y");
  });
  it("falls back to the first option otherwise, or empty when there are none", () => {
    expect(resolveEvaluator([{ v: "x" }], "nope")).toBe("x");
    expect(resolveEvaluator([], "nope")).toBe("");
  });
});

describe("smokeState", () => {
  const pairs = [pair("a", "m1"), pair("a", "m2")];
  it("with no smoke run, every pair is eligible and the probe is busy", () => {
    const s = smokeState(undefined, pairs);
    expect(s).toEqual({ eligiblePairs: pairs, probeBusy: true, retryable: false });
  });
  it("after a run, only green pairs are eligible and retry is offered for failed items", () => {
    const smoke = {
      status: "done",
      green: [{ channel: "a", model: "m2" }],
      items: [{ state: "red" }],
    } as never;
    const s = smokeState(smoke, pairs);
    expect(s.eligiblePairs).toEqual([pair("a", "m2")]);
    expect(s.probeBusy).toBe(false);
    expect(s.retryable).toBe(true);
  });
  it("an idle smoke state counts as not run; a running one stays busy", () => {
    expect(smokeState({ status: "idle", green: [], items: [] } as never, pairs).eligiblePairs).toEqual(pairs);
    expect(smokeState({ status: "running", green: [], items: [{ state: "green" }] } as never, pairs).probeBusy).toBe(true);
    expect(smokeState({ status: "done", green: [], items: [{ state: "green" }] } as never, pairs).retryable).toBe(false);
  });
});

describe("isUnmeteredAgent", () => {
  const agent = (over: Partial<AgentSummary>) => ({ id: "x", channel: "c", model: "m", ...over } as AgentSummary);
  it("is true when billing says unmetered", () => {
    expect(isUnmeteredAgent(agent({ billing: "unmetered" }), ch("c"))).toBe(true);
  });
  it("is true for an unbilled agent on a non-aif openai-compatible channel", () => {
    expect(isUnmeteredAgent(agent({}), { id: "lm", type: "openai-compatible" } as ChannelSummary)).toBe(true);
  });
  it("is false for aif, for explicit metered billing, and for other channel types", () => {
    expect(isUnmeteredAgent(agent({}), { id: "aif", type: "openai-compatible" } as ChannelSummary)).toBe(false);
    expect(isUnmeteredAgent(agent({ billing: "metered" }), { id: "lm", type: "openai-compatible" } as ChannelSummary)).toBe(false);
    expect(isUnmeteredAgent(agent({}), undefined)).toBe(false);
  });
});
