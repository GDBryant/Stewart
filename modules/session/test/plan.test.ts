import { describe, expect, it } from "vitest";
import type { EngineEvent, EngineTurn } from "@stewart/engines";
import type { RunEvent } from "@stewart/protocol";
import { harness, makeConfig, scriptedEngine, type Harness } from "./harness.js";

const answered = new WeakSet<RunEvent>();

/** Answers ask_user prompts: "Approve" for plan approvals, `stop` for everything else. */
function autoAnswer(h: Harness, stop = "Stop"): void {
  void (async () => {
    for (let i = 0; i < 20000; i++) {
      for (const e of h.events) {
        if (e.kind !== "ask_user" || answered.has(e)) continue;
        answered.add(e);
        const q = e as { questionId: string; question?: string };
        h.interaction.resolveAnswer(q.questionId, (q.question ?? "").includes("Approve this plan") ? "Approve" : stop);
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
}

type Ms = { title: string; detail?: string; check: { command?: string[]; files?: string[] } };

/** Lead step: write the plan, wait for the ask_user approval, then stop. */
function planStep(args: { goal: string; milestones: Ms[] }) {
  return async function* (turn: EngineTurn) {
    const w = turn.tools.find("plan_write")!;
    const pending = w.execute(args, null, turn.signal);
    await new Promise((r) => setTimeout(r, 5));
    turn.transcript.push({ role: "assistant", content: String(await pending) });
    yield { kind: "finished", reason: "stop" };
  };
}

/** Milestone step: assert no plan_write, optionally write files, finish. */
function msStep(opts: { writes?: Record<string, string>; cancelled?: boolean; check?: (turn: EngineTurn) => void } = {}) {
  return async function* (turn: EngineTurn) {
    const h = opts as { h?: Harness };
    if (h.h) expect(turn.tools.find("plan_write")).toBeUndefined();
    for (const [p, c] of Object.entries(opts.writes ?? {})) h.h!.files[p] = c;
    opts.check?.(turn);
    turn.transcript.push({ role: "assistant", content: "milestone done" });
    yield { kind: "finished", reason: opts.cancelled ? ("cancelled" as const) : ("stop" as const) };
  };
}

function planSummaryOf(h: Harness, sessionId: string) {
  return h.svc.planFor(sessionId) as Promise<{ goal: string; status: string; milestones: { id: string; status: string; checkpoint?: string }[] } | undefined>;
}

const TWO_MS: Ms[] = [
  { title: "first", check: { files: ["a.ts"] } },
  { title: "second", check: { command: ["check", "two"] } },
];

describe("code-driven plan", () => {
  it("approves, drives three milestones with checkpoints, finishes done", async () => {
    const ms: Ms[] = [
      { title: "one", check: { files: ["a.ts"] } },
      { title: "two", detail: "make b", check: { command: ["check", "two"] } },
      { title: "three", check: { files: ["c.ts"] } },
    ];
    let h!: Harness;
    const step = (w: Record<string, string>) => async function* (turn: EngineTurn) {
      expect(turn.tools.find("plan_write")).toBeUndefined();
      for (const [p, c] of Object.entries(w)) h.files[p] = c;
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: ms }), step({ "a.ts": "x" }), step({ "b.ts": "x" }), step({ "c.ts": "x" })]) });
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("done");
    expect(h.events.filter((e) => e.kind === "milestone.started").length).toBe(3);
    expect(h.events.filter((e) => e.kind === "milestone.done").length).toBe(3);
    expect(h.procs.filter((p) => p.argv[0] === "check").length).toBe(1);
    const text = h.files[`/p/.stewart/plans/${sessionId}.md`];
    expect(text).toContain("Status: done");
    const summary = await planSummaryOf(h, sessionId);
    expect(summary?.status).toBe("done");
    expect(summary?.milestones.every((m) => m.status === "done" && m.checkpoint)).toBe(true);
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]) as { messages?: { content: string }[] } | { content: string }[];
    const transcript = Array.isArray(stored) ? stored : stored.messages ?? [];
    expect(transcript.some((m) => m.content.includes("Milestone M2 of 3: two") && m.content.includes("Done when: check two"))).toBe(true);
  });

  it("does not drive when the plan is declined", async () => {
    const h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS })]) });
    void (async () => {
      for (let i = 0; i < 20000; i++) {
        for (const e of h.events) {
          if (e.kind === "ask_user" && !answered.has(e)) {
            answered.add(e);
            h.interaction.resolveAnswer((e as { questionId: string }).questionId, "Revise");
          }
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await h.svc.send({ text: "build" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("done");
    expect(h.events.some((e) => e.kind === "plan.approved")).toBe(false);
    expect(h.events.some((e) => e.kind === "milestone.started")).toBe(false);
  });

  it("a failed milestone check escalates to the next agent and then passes", async () => {
    const agents = [
      { id: "a1", channel: "c", model: "m", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m", effort: "medium" as const },
    ];
    const cfg = makeConfig({ agents });
    cfg.roles[0] = { ...cfg.roles[0], chain: ["a1", "a2"] };
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ config: cfg, engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), write, write]) });
    let calls = 0;
    h.setProcHandler((argv) => ({ code: argv[0] === "check" ? (calls++ === 0 ? 1 : 0) : 1 }));
    autoAnswer(h);
    await h.svc.send({ text: "build" });
    const esc = await h.waitFor("run.escalated");
    expect(esc).toMatchObject({ from: "a1", to: "a2" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("done");
    expect(h.events.filter((e) => e.kind === "milestone.done").length).toBe(2);
  });

  it("a milestone that fails the whole chain pauses the plan and fails the run", async () => {
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), write, write]) });
    h.setProcHandler(() => ({ code: 1 }));
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    const fin = (await h.waitFor("run.finished")) as { status: string; error?: string };
    expect(fin.status).toBe("failed");
    expect(fin.error).toContain("milestone M2 failed");
    const failed = h.events.find((e) => e.kind === "milestone.failed") as { milestoneId: string } | undefined;
    expect(failed?.milestoneId).toBe("M2");
    const summary = await planSummaryOf(h, sessionId);
    expect(summary?.status).toBe("paused");
    expect(summary?.milestones.map((m) => m.status)).toEqual(["done", "failed"]);
  });

  it("cancelling mid-milestone pauses the plan and cancels the run", async () => {
    let h!: Harness;
    const cancelled = async function* (turn: EngineTurn) {
      turn.transcript.push({ role: "assistant", content: "x" });
      yield { kind: "finished", reason: "cancelled" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), cancelled]) });
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("cancelled");
    const summary = await planSummaryOf(h, sessionId);
    expect(summary?.status).toBe("paused");
    expect(summary?.milestones.map((m) => m.status)).toEqual(["pending", "pending"]);
  });

  it("resume continues at the failed milestone and completes the plan", async () => {
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), write, write, write]) });
    let calls = 0;
    h.setProcHandler((argv) => ({ code: argv[0] === "check" ? (calls++ === 0 ? 1 : 0) : 1 }));
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("failed");
    const started = h.waitFor("run.started");
    const res = await h.svc.resume(sessionId);
    expect(res.ok).toBe(true);
    expect(await started).toMatchObject({ title: "Resume plan: g" });
    const fin2 = (await h.waitFor("run.finished")) as { status: string };
    expect(fin2.status).toBe("done");
    const summary = await planSummaryOf(h, sessionId);
    expect(summary?.status).toBe("done");
  });

  it("resume without a plan fails fast", async () => {
    const h = harness();
    const res = await h.svc.resume("sess-none");
    expect(res.ok).toBe(false);
  });

  it("two sessions keep separate plan files", async () => {
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    const one: Ms[] = [{ title: "only", check: { files: ["a.ts"] } }];
    h = harness({ engine: scriptedEngine([planStep({ goal: "g1", milestones: one }), write, planStep({ goal: "g2", milestones: one }), write]) });
    autoAnswer(h);
    const a = await h.svc.send({ text: "one" });
    await h.waitFor("run.finished");
    const b = await h.svc.send({ text: "two" });
    await h.waitFor("run.finished");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(h.files[`/p/.stewart/plans/${a.sessionId}.md`]).toContain("Session: " + a.sessionId);
    expect(h.files[`/p/.stewart/plans/${b.sessionId}.md`]).toContain("Session: " + b.sessionId);
  });

  it("a normal turn on a paused plan does not drive milestones", async () => {
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    const answer = async function* (turn: EngineTurn) {
      turn.transcript.push({ role: "assistant", content: "42" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), write, write, answer]) });
    h.setProcHandler(() => ({ code: 1 }));
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    await h.waitFor("run.finished");
    expect(await planSummaryOf(h, sessionId)).toMatchObject({ status: "paused" });
    const count = h.events.filter((e) => e.kind === "milestone.started").length;
    await h.svc.send({ sessionId, text: "question" });
    const fin = (await h.waitFor("run.finished")) as { status: string };
    expect(fin.status).toBe("done");
    expect(h.events.filter((e) => e.kind === "milestone.started").length).toBe(count);
    expect(await planSummaryOf(h, sessionId)).toMatchObject({ status: "paused" });
  });

  it("revert to a checkpoint resets later milestones to pending", async () => {
    let h!: Harness;
    const write = async function* (turn: EngineTurn) {
      h.files["a.ts"] = "x";
      turn.transcript.push({ role: "assistant", content: "did it" });
      yield { kind: "finished", reason: "stop" } as EngineEvent;
    };
    h = harness({ engine: scriptedEngine([planStep({ goal: "g", milestones: TWO_MS }), write, write]) });
    h.setProcHandler(() => ({ code: 1 }));
    autoAnswer(h);
    const { sessionId } = await h.svc.send({ text: "build" });
    await h.waitFor("run.finished");
    const before = (await planSummaryOf(h, sessionId))!;
    expect(before.milestones.map((m) => m.status)).toEqual(["done", "failed"]);
    const r = await h.svc.revert(sessionId, "baseline");
    expect(r.ok).toBe(true);
    const after = (await planSummaryOf(h, sessionId))!;
    expect(after.status).toBe("paused");
    expect(after.milestones.map((m) => m.status)).toEqual(["pending", "pending"]);
  });
});
