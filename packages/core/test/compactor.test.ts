import { describe, expect, it } from "vitest";
import { compactionFor, compactorFor } from "../src/orchestration/roleRunner.js";

const recorded: Record<string, unknown>[] = [];
let capped = false;
const accrued = { accrued: 0, reached: () => capped };
function rt(roles: unknown[], agents: unknown[], text = "note", unhealthy = false) {
  return {
    runId: "r1",
    ledger: { record: async (e: Record<string, unknown>) => void recorded.push(e) },
    cost: accrued,
    config: { roles, agents },
    signal: new AbortController().signal,
    channelFor: () => ({
      unhealthy,
      chat: async function* () {
        yield { kind: "text", text };
        yield { kind: "done", usage: { in: 10, out: 5 }, costUsd: 0.5 };
      },
    }),
  } as never;
}
const agent = { id: "a", channel: "c", model: "m" };

describe("compactorFor", () => {
  it("summarizes via the compactor role's agent", async () => {
    const f = compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [agent], "Goal: x"));
    expect(await f!([{ role: "user", content: "hi" }])).toBe("Goal: x");
  });
  it("meters each call to the ledger under role compactor and accrues cost", async () => {
    recorded.length = 0;
    accrued.accrued = 0;
    const f = compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [{ ...agent, billing: "reported" }]), "t1");
    await f!([{ role: "user", content: "hi" }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ roleId: "compactor", taskId: "t1", inTokens: 10, outTokens: 5 });
    expect(accrued.accrued).toBeCloseTo(0.5);
  });
  it("does not call a paid compactor once the cost cap is reached", async () => {
    recorded.length = 0;
    capped = true;
    const f = compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [{ ...agent, billing: "reported" }]));
    expect(await f!([{ role: "user", content: "hi" }])).toBe("");
    expect(recorded).toHaveLength(0);
    capped = false;
  });
  it("is undefined without an enabled compactor role", () => {
    expect(compactorFor(rt([], [agent]))).toBeUndefined();
    expect(compactorFor(rt([{ id: "compactor", enabled: false, agent: "a" }], [agent]))).toBeUndefined();
  });
  it("is undefined when the agent is unbound or the channel unhealthy", () => {
    expect(compactorFor(rt([{ id: "compactor", enabled: true }], [agent]))).toBeUndefined();
    expect(compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [agent], "n", true))).toBeUndefined();
  });
});

describe("compactionFor", () => {
  const withSettings = (compaction: unknown, roles: unknown[] = [{ id: "compactor", enabled: true, agent: "a" }]) => {
    const r = rt(roles, [agent]) as unknown as { config: Record<string, unknown> };
    r.config.settings = { compaction };
    return r as never;
  };
  it("reflects the prune and summarize flags", () => {
    const on = compactionFor(withSettings({ prune: true, summarize: true }));
    expect(on.prune).toBe(true);
    expect(on.summarize).toBeTypeOf("function");
  });
  it("is off by default and when no compactor role exists", () => {
    expect(compactionFor(withSettings({ prune: false, summarize: false }))).toEqual({ prune: false, summarize: undefined });
    expect(compactionFor(withSettings({ prune: false, summarize: true }, [])).summarize).toBeUndefined();
  });
});
