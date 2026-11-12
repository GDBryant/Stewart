import { describe, expect, it } from "vitest";
import type { LoopResult } from "@stewart/agent-loop";
import { finalize, type RunHost } from "../src/runSupport.js";

const completed = { kind: "completed", messages: [{ role: "assistant", content: "report text" }] } as unknown as LoopResult;

function stubHost(order: string[], over: { aborted?: boolean } = {}): RunHost {
  return {
    rt: {
      cost: { reached: () => false },
      leases: { releaseAll: () => order.push("release") },
      signal: { aborted: over.aborted === true },
    },
    dispatchCalls: 1,
    suggestions: [],
    settleTasks: async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("settled");
    },
  } as unknown as RunHost;
}

describe("finalize", () => {
  it("waits for dispatched tasks to settle before releasing leases and answering", async () => {
    const order: string[] = [];
    const out = await finalize(stubHost(order), completed);
    expect(order).toEqual(["settled", "release"]);
    expect(out).toMatchObject({ status: "done", reply: "report text" });
  });

  it("still settles tasks when the run was cancelled, then reports cancelled", async () => {
    const order: string[] = [];
    const out = await finalize(stubHost(order, { aborted: true }), completed);
    expect(order).toEqual(["settled", "release"]);
    expect(out.status).toBe("cancelled");
  });
});
