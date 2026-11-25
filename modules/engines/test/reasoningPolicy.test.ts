import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent, type ChatRequest } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { ToolCall } from "@stewart/kernel";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { collect } from "@stewart/kernel";
import { nativeLoop, type EngineEvent, type EngineTurn } from "../src/api.js";
import { OVERRUN_CHARS, ReasoningPolicy } from "../src/reasoningPolicy.js";

const tool = (name: string, ok = true): Tool => ({
  spec: { name, description: name, parameters: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } },
  requiresApproval: false,
  execute: async () => {
    if (!ok) throw new Error("boom");
    return "ok";
  },
});

function channel(turns: ChatEvent[][], seen: ChatRequest[], reasoning = "reasoning_effort"): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      seen.push(req);
      for (const ev of turns[Math.min(i++, turns.length - 1)]) {
        if (req.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield ev;
      }
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1, reasoning });
}

const agent = { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef;
const calls = (...names: string[]): ChatEvent[] => [{ kind: "tool_calls", calls: names.map((n, i): ToolCall => ({ id: `${n}${i}`, name: n, arguments: {} })) }, { kind: "done" }];
const readN = (n: number): ChatEvent[] => [{ kind: "tool_calls", calls: [{ id: `r${n}`, name: "ReadFile", arguments: { n } }] }, { kind: "done" }];
const stop: ChatEvent[] = [{ kind: "text", text: "done" }, { kind: "done" }];

function turn(ch: ManagedChannel, tools: Tool[], over: Partial<EngineTurn> = {}): EngineTurn {
  return {
    sessionId: "s",
    transcript: [{ role: "user", content: "go" }],
    system: "sys",
    agent,
    channel: ch,
    roleId: "lead",
    tools: new ToolRegistry(tools),
    approve: async () => ({ kind: "approved" }),
    state: {},
    cwd: "/p",
    signal: new AbortController().signal,
    maxTurns: 8,
    ...over,
  };
}

const run = (t: EngineTurn): Promise<EngineEvent[]> => collect(nativeLoop.run(t));

describe("routine-turn reasoning policy", () => {
  it("full effort first, thinking off after successful read outcomes, full after a write or a failure and for the report", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile"), calls("Search"), calls("WriteFile"), calls("ReadFile"), calls("Bad"), stop], seen);
    await run(turn(ch, [tool("ReadFile"), tool("Search"), tool("WriteFile"), tool("Bad", false)], { effort: "medium" }));
    expect(seen.map((r) => r.think)).toEqual([undefined, false, false, undefined, false, undefined]);
    expect(seen[0].effort).toBe("medium");
  });

  it("an explicit role think is authoritative: no routine override", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile"), stop], seen);
    await run(turn(ch, [tool("ReadFile")], { think: true }));
    expect(seen.map((r) => r.think)).toEqual([true, true]);
  });

  it("a channel without a reasoning field is left unchanged", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile"), stop], seen, "none");
    await run(turn(ch, [tool("ReadFile")]));
    expect(seen.map((r) => r.think)).toEqual([undefined, undefined]);
  });

  it("a channel whose probe said unsupported is left unchanged", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile"), stop], seen);
    ch.update({ ...ch.cfg, modelCaps: { m: { reasoningControl: false } } });
    await run(turn(ch, [tool("ReadFile")]));
    expect(seen.map((r) => r.think)).toEqual([undefined, undefined]);
  });

  it("a mixed batch with a non-routine tool keeps full effort", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile", "RunTerminal"), calls("Search"), stop], seen);
    await run(turn(ch, [tool("ReadFile"), tool("Search")]));
    expect(seen.map((r) => r.think)).toEqual([undefined, undefined, false]);
  });

  it("the report-only last turn gets full effort even after routine turns", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([...Array.from({ length: 9 }, (_v, i) => readN(i)), stop], seen);
    await run(turn(ch, [tool("ReadFile")], { maxTurns: 10 }));
    expect(seen).toHaveLength(10);
    expect(seen[8].think).toBe(false);
    expect(seen[9].think).toBeUndefined();
  });

  it("a loop-guard warning turn restores full effort", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([calls("ReadFile"), calls("ReadFile"), stop], seen);
    await run(turn(ch, [tool("ReadFile")]));
    expect(seen.map((r) => r.think)).toEqual([undefined, false, undefined]);
  });
});

describe("reasoning overrun guard", () => {
  const big = "x".repeat(OVERRUN_CHARS + 1);

  it("cuts a request that only reasons past the limit and retries once with thinking off", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([[{ kind: "reasoning", text: big }, { kind: "reasoning", text: "more" }, { kind: "done" }], stop], seen);
    const evs = await run(turn(ch, []));
    expect(seen.map((r) => r.think)).toEqual([undefined, false]);
    expect(evs.find((e) => e.kind === "diag")).toMatchObject({ tag: "reasoning_overrun" });
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "stop" });
    expect(evs.some((e) => e.kind === "text")).toBe(true);
  });

  it("does not cut when content or a tool call arrived, or when reasoning stays under the limit", async () => {
    const seen: ChatRequest[] = [];
    const ch = channel([[{ kind: "text", text: "a" }, { kind: "reasoning", text: big }, { kind: "done" }]], seen);
    const evs = await run(turn(ch, []));
    expect(seen).toHaveLength(1);
    expect(evs.some((e) => e.kind === "diag")).toBe(false);
    const seen2: ChatRequest[] = [];
    await run(turn(channel([[{ kind: "reasoning", text: "short" }, ...stop]], seen2), []));
    expect(seen2).toHaveLength(1);
  });

  it("retries only once per run: a second overrun is not cut", async () => {
    const seen: ChatRequest[] = [];
    const over: ChatEvent[] = [{ kind: "reasoning", text: big }, { kind: "reasoning", text: "z" }, { kind: "done" }];
    const evs = await run(turn(channel([over, calls("ReadFile"), over, stop], seen), [tool("ReadFile")]));
    expect(evs.filter((e) => e.kind === "diag")).toHaveLength(1);
  });

  it("is inactive without a reasoning route or with an explicit role think", async () => {
    for (const [ch, over] of [[channel([[{ kind: "reasoning", text: big }, { kind: "reasoning", text: "z" }, ...stop]], [], "none"), {}], [channel([[{ kind: "reasoning", text: big }, { kind: "reasoning", text: "z" }, ...stop]], []), { think: true }]] as const) {
      const evs = await run(turn(ch, [], over));
      expect(evs.some((e) => e.kind === "diag")).toBe(false);
    }
  });

  it("a user cancel during a watched request still finishes cancelled", async () => {
    const ac = new AbortController();
    const seen: ChatRequest[] = [];
    const ch = channel([[{ kind: "reasoning", text: "a" }, ...stop]], seen);
    ac.abort();
    const evs = await run(turn(ch, [], { signal: ac.signal }));
    expect(evs.at(-1)).toMatchObject({ kind: "finished", reason: "cancelled" });
  });
});

describe("ReasoningPolicy", () => {
  it("observe: empty batch or a warning is not routine", () => {
    const p = new ReasoningPolicy();
    const t = turn(channel([], []), []);
    p.observe([], false);
    expect(p.thinkOff(t, false)).toBe(false);
    p.observe([{ call: { id: "1", name: "Search", arguments: {} }, ok: true }], true);
    expect(p.thinkOff(t, false)).toBe(false);
    p.observe([{ call: { id: "1", name: "Search", arguments: {} }, ok: true }], false);
    expect(p.thinkOff(t, false)).toBe(true);
    expect(p.thinkOff(t, true)).toBe(false);
  });
});
