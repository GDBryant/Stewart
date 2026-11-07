import { describe, expect, it } from "vitest";
import type { RunEvent } from "@stewart/protocol";
import { counterIds, systemClock, type Clock } from "@stewart/kernel";
import { Interaction } from "../src/interaction.js";

const make = (clock: Clock = systemClock) => {
  const events: RunEvent[] = [];
  const ix = new Interaction({ ids: counterIds(), clock, bus: { emit: (e) => events.push(e) } });
  return { ix, events };
};

describe("Interaction approvals", () => {
  it("emits approval.request and resolves on resolveApproval", async () => {
    const { ix, events } = make();
    const p = ix.approval("r1", "EditFile", { path: "a.ts" }, "EDITS");
    const ev = events[0];
    expect(ev).toMatchObject({ kind: "approval.request", runId: "r1", tool: "EditFile", category: "EDITS" });
    expect(ix.resolveApproval((ev as { approvalId: string }).approvalId, "always")).toBe(true);
    await expect(p).resolves.toBe("always");
  });

  it("resolveApproval returns false for unknown ids", () => {
    const { ix } = make();
    expect(ix.resolveApproval("appr-x", "once")).toBe(false);
  });
});

describe("Interaction ask", () => {
  it("emits ask_user and resolves on resolveAnswer", async () => {
    const { ix, events } = make();
    const p = ix.ask("r1", "continue?", ["Yes", "No"], "worker");
    const ev = events[0];
    expect(ev).toMatchObject({ kind: "ask_user", runId: "r1", question: "continue?", roleId: "worker" });
    expect(ix.resolveAnswer((ev as { questionId: string }).questionId, "Yes")).toBe(true);
    await expect(p).resolves.toBe("Yes");
  });

  it("resolveAnswer returns false for unknown ids", () => {
    const { ix } = make();
    expect(ix.resolveAnswer("q-x", "y")).toBe(false);
  });
});

describe("Interaction askTimed", () => {
  it("resolves undefined and emits question.withdrawn on abort", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    const p = ix.askTimed("r1", "go?", undefined, 60_000, ac.signal, "orchestrator");
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    expect(events.some((e) => e.kind === "question.withdrawn" && (e as { roleId?: string }).roleId === "orchestrator")).toBe(true);
  });

  it("resolves immediately when signal is already aborted and emits nothing", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    ac.abort();
    await expect(ix.askTimed("r1", "go?", undefined, 1, ac.signal)).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("times out via the injected clock and withdraws the card", async () => {
    let now = 0;
    const timers: { fn: () => void; cancelled: boolean }[] = [];
    const clock: Clock = {
      now: () => now,
      setTimeout: (fn: () => void, _ms: number) => {
        const t = { fn, cancelled: false };
        timers.push(t);
        return { cancel: () => { t.cancelled = true; } };
      },
    };
    const { ix, events } = make(clock);
    const p = ix.askTimed("r1", "go?", undefined, 1_000, new AbortController().signal);
    timers[0].fn();
    await expect(p).resolves.toBeUndefined();
    expect(events.some((e) => e.kind === "question.withdrawn")).toBe(true);
    now = 1;
  });

  it("answer before timeout resolves the answer and cancels the timer", async () => {
    let cancelled = false;
    const clock: Clock = { now: () => 0, setTimeout: () => ({ cancel: () => { cancelled = true; } }) };
    const { ix, events } = make(clock);
    const p = ix.askTimed("r1", "go?", undefined, 1_000, new AbortController().signal);
    const ev = events.find((e) => e.kind === "ask_user") as { questionId: string };
    ix.resolveAnswer(ev.questionId, "ok");
    await expect(p).resolves.toBe("ok");
    expect(cancelled).toBe(true);
    expect(events.some((e) => e.kind === "question.withdrawn")).toBe(false);
  });
});
