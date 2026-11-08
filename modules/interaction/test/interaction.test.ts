import { describe, expect, it } from "vitest";
import type { Clock } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import { Interaction, approvalPrompt, questionPrompt, type PromptOutcome } from "../src/api.js";

function make(clock?: Clock) {
  const events: RunEvent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const ix = new Interaction({
    ids: { next: ((n) => (p: string) => `${p}-${++n}`)(0) },
    clock: clock ?? { now: () => 0, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { cancel: () => { const i = timers.findIndex((t) => t.fn === fn); if (i >= 0) timers.splice(i, 1); } }; } },
    bus: { emit: (e) => events.push(e) },
  });
  return { ix, events, timers };
}

const tag = { runId: "r1", roleId: "w" };

describe("Interaction approvals", () => {
  it("emits approval.request and resolves with the decoded grant", async () => {
    const { ix, events } = make();
    const p = ix.ask(approvalPrompt("EditFile", { path: "a.ts" }, "EDITS"), tag);
    expect(events[0]).toMatchObject({ kind: "approval.request", runId: "r1", tool: "EditFile", category: "EDITS" });
    const id = (events[0] as { approvalId: string }).approvalId;
    expect(ix.resolveApproval(id, "always")).toBe(true);
    await expect(p).resolves.toEqual({ kind: "answered", value: "always" });
    expect(ix.resolveApproval(id, "once")).toBe(false);
    expect(ix.resolveApproval("unknown", "once")).toBe(false);
  });

  it("resolveApproval matches only the shown approval", async () => {
    const { ix, events } = make();
    void ix.ask(questionPrompt("ask_user", "q?"), tag);
    expect(ix.resolveApproval("appr-1", "once")).toBe(false);
    const p = ix.ask(approvalPrompt("T", {}, "OTHER"), tag);
    void p;
    expect(events).toHaveLength(1);
  });
});

describe("Interaction questions", () => {
  it("emits ask_user, resolves on resolveAnswer, applies decode", async () => {
    const { ix, events } = make();
    const p = ix.ask({ kind: "question", topic: "ask_user", question: "go?", decode: (a: string) => a.toUpperCase() }, tag);
    const id = (events[0] as { questionId: string }).questionId;
    expect(ix.resolveAnswer(id, "yes")).toBe(true);
    await expect(p).resolves.toEqual({ kind: "answered", value: "YES" });
    expect(ix.resolveAnswer(id, "x")).toBe(false);
  });

  it("timer starts only when shown, not at enqueue", async () => {
    const { ix, events, timers } = make();
    const first = ix.ask(questionPrompt("ask_user", "q1"), tag);
    const second = ix.ask(questionPrompt("continue", "q2", undefined, 1_000), tag);
    void first; void second;
    expect(timers).toHaveLength(0);
    ix.resolveAnswer("q-1", "a");
    expect(events).toHaveLength(2);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1_000);
    timers[0].fn();
    await expect(second).resolves.toEqual({ kind: "withdrawn", reason: "timeout" });
    expect(events[2]).toMatchObject({ kind: "question.withdrawn", runId: "r1", questionId: "q-2" });
  });

  it("already-aborted signal resolves cancel without enqueuing", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    ac.abort();
    await expect(ix.ask(questionPrompt("ask_user", "q"), tag, ac.signal)).resolves.toEqual({ kind: "withdrawn", reason: "cancel" });
    expect(events).toHaveLength(0);
    expect(ix.pending()).toHaveLength(0);
  });
});

describe("FIFO queue", () => {
  it("shows one at a time; queued ids do not resolve", async () => {
    const { ix, events } = make();
    const p1 = ix.ask(approvalPrompt("A", {}, "OTHER"), tag);
    const p2 = ix.ask(approvalPrompt("B", {}, "OTHER"), tag);
    expect(events).toHaveLength(1);
    expect(ix.resolveApproval("appr-2", "once")).toBe(false);
    expect(ix.resolveApproval("appr-1", "once")).toBe(true);
    await expect(p1).resolves.toEqual({ kind: "answered", value: "once" });
    expect(events).toHaveLength(2);
    expect((events[1] as { tool: string }).tool).toBe("B");
    expect(ix.resolveApproval("appr-2", "chat")).toBe(true);
    await expect(p2).resolves.toEqual({ kind: "answered", value: "chat" });
  });

  it("abort while queued resolves cancel silently and the queue continues", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    const p1 = ix.ask(questionPrompt("ask_user", "q1"), tag);
    const p2 = ix.ask(questionPrompt("ask_user", "q2"), tag, ac.signal);
    const p3 = ix.ask(questionPrompt("ask_user", "q3"), tag);
    ac.abort();
    await expect(p2).resolves.toEqual({ kind: "withdrawn", reason: "cancel" });
    expect(events).toHaveLength(1);
    ix.resolveAnswer("q-1", "a");
    await p1;
    ix.resolveAnswer("q-3", "b");
    await p3;
  });

  it("abort while shown emits question.withdrawn and advances", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    const p1 = ix.ask(questionPrompt("ask_user", "q1"), tag, ac.signal);
    const p2 = ix.ask(questionPrompt("ask_user", "q2"), tag);
    ac.abort();
    await expect(p1).resolves.toEqual({ kind: "withdrawn", reason: "cancel" });
    expect(events[1]).toMatchObject({ kind: "question.withdrawn", questionId: "q-1" });
    expect(events[2]).toMatchObject({ kind: "ask_user", questionId: "q-2" });
    ix.resolveAnswer("q-2", "b");
    await p2;
  });

  it("abort on a shown approval emits nothing but advances", async () => {
    const { ix, events } = make();
    const ac = new AbortController();
    const p1 = ix.ask(approvalPrompt("A", {}, "OTHER"), tag, ac.signal);
    const p2 = ix.ask(questionPrompt("ask_user", "q2"), tag);
    ac.abort();
    await expect(p1).resolves.toEqual({ kind: "withdrawn", reason: "cancel" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "ask_user", questionId: "q-2" });
    ix.resolveAnswer("q-2", "b");
    await p2;
  });
});

describe("withdraw / pending", () => {
  it("withdraw unknown id returns false; timeout reason is preserved", async () => {
    const { ix, events } = make();
    expect(ix.withdraw("nope", "timeout")).toBe(false);
    const p = ix.ask(questionPrompt("ask_user", "q"), tag);
    expect(ix.withdraw("q-1", "timeout")).toBe(true);
    await expect(p).resolves.toEqual({ kind: "withdrawn", reason: "timeout" });
    expect(events[1]).toMatchObject({ kind: "question.withdrawn" });
  });

  it("pending() lists shown first then FIFO with text and flags", async () => {
    const { ix } = make();
    void ix.ask(approvalPrompt("EditFile", {}, "EDITS"), tag);
    void ix.ask(questionPrompt("plan_gate", "proceed?"), { runId: "r1", roleId: "orchestrator", taskId: "t1" });
    const v = ix.pending();
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: "appr-1", kind: "approval", shown: true, runId: "r1" });
    expect(v[1]).toMatchObject({ id: "q-2", kind: "question", topic: "plan_gate", shown: false, taskId: "t1", text: "proceed?" });
  });
});
