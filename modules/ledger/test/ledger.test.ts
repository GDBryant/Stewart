import { describe, expect, it } from "vitest";
import { CostLimit, RunLedger, costOfCall } from "../src/api.js";
import type { HostPort } from "@stewart/kernel";

function fakeHost() {
  const lines: string[] = [];
  const host = { files: { appendLine: async (_p: string, l: string) => void lines.push(l), readLines: async () => lines } } as unknown as HostPort;
  return { host, lines };
}
const entry = (o: Record<string, unknown> = {}) => ({ runId: "r", agentId: "a", model: "m", billing: "priced", inTokens: 10, outTokens: 5, costUsd: 0.5, ...o });

describe("RunLedger", () => {
  it("records, totals per role/agent, and replays after a reload (torn tail skipped)", async () => {
    const { host, lines } = fakeHost();
    const clock = { now: () => 7, setTimeout: () => ({ cancel() {} }) };
    const l = new RunLedger(host, "p", clock);
    await l.record(entry({ roleId: "coder" }));
    await l.record(entry({ costUsd: 0.25 }));
    lines.push('{"runId":"r","costUs');
    const l2 = new RunLedger(host, "p", clock);
    await l2.load();
    const c = l2.cost("r");
    expect(c.costUsd).toBeCloseTo(0.75);
    expect(c.byRole).toEqual({ coder: 0.5, "(direct)": 0.25 });
    expect(l2.cost("other").costUsd).toBe(0);
  });
});

describe("costOfCall", () => {
  const usage = { in: 1_000_000, out: 1_000_000 };
  it("prices by billing mode", () => {
    expect(costOfCall({ billing: "priced", price: { inPerMTok: 1, outPerMTok: 2 } }, usage, undefined)).toBe(3);
    expect(costOfCall({ billing: "free" }, usage, 9)).toBe(0);
    expect(costOfCall({ billing: "reported" }, usage, 0.4)).toBe(0.4);
    expect(costOfCall({ billing: "reported" }, undefined, undefined)).toBe(0);
  });
});

describe("CostLimit", () => {
  it("is disabled at 0, reaches the cap, and raises by one step", () => {
    expect(new CostLimit(0, "stop", 99).reached()).toBe(false);
    const c = new CostLimit(1, "ask");
    c.accrued = 1.2;
    expect(c.reached()).toBe(true);
    expect(c.overshoot()).toBeCloseTo(0.2);
    expect(c.raise()).toBe(2);
    expect(c.reached()).toBe(false);
  });
});
