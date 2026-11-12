import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter } from "@stewart/channels";
import { settingsFile } from "@stewart/config";
import { counterIds, fakeHost, systemClock, type HostPort } from "@stewart/kernel";
import { Interaction } from "@stewart/interaction";
import { Permissions } from "@stewart/permissions";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { RunEvent } from "@stewart/protocol";
import { SessionService, type SessionDeps } from "../src/api.js";

function fakeChannel(): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {
      yield { kind: "text", text: "hi" };
      yield { kind: "done" };
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

function scripted(steps: ((turn: EngineTurn) => AsyncGenerator<EngineEvent, void>)[]): Engine {
  let n = 0;
  return { id: "native-loop", run: (turn: EngineTurn) => steps[Math.min(n++, steps.length - 1)](turn) };
}

function config(over: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    channels: [{ id: "c", type: "fake", enabled: true, discoverModels: true, extraModels: [], modelCaps: {} }],
    agents: [{ id: "a", channel: "c", model: "m", effort: "medium" }],
    roles: [{ id: "lead", enabled: true, prompt: "lead", skills: [], tools: [], writePaths: [], turnBudget: 5 }],
    settings: settingsFile.parse({}),
    skills: [],
    errors: [],
    ...over,
  };
}

function harness(over: { engine?: Engine; files?: Record<string, string>; config?: EffectiveConfig } = {}) {
  const { host, files } = fakeHost(over.files ?? {});
  const events: RunEvent[] = [];
  const bus = { emit: (ev: RunEvent) => events.push(ev) };
  const ids = counterIds();
  const interaction = new Interaction({ ids, clock: systemClock, bus });
  const deps: SessionDeps = {
    host,
    bus,
    ids,
    clock: systemClock,
    interaction,
    permissions: new Permissions(interaction),
    channelFor: () => fakeChannel(),
    config: () => over.config ?? config(),
    engineFor: over.engine ? () => over.engine! : undefined,
  };
  const svc = new SessionService(deps);
  const finished = new Promise<RunEvent>((res) => {
    const orig = bus.emit;
    bus.emit = (ev: RunEvent) => {
      orig(ev);
      if (ev.kind === "run.finished") res(ev);
    };
  });
  return { svc, events, host, files, interaction, finished };
}

const answered = new WeakSet<RunEvent>();

function autoAnswer(interaction: Interaction, events: RunEvent[]): void {
  void (async () => {
    for (let i = 0; i < 20000; i++) {
      for (const e of events) {
        if (e.kind !== "ask_user" || answered.has(e)) continue;
        answered.add(e);
        const q = e as { questionId: string; question?: string };
        interaction.resolveAnswer(q.questionId, (q.question ?? "").includes("Approve this plan") ? "Approve" : "Stop");
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
}

function approvePlan(interaction: Interaction, events: RunEvent[]): void {
  autoAnswer(interaction, events);
}

const PLAN_ARGS = {
  goal: "build hello",
  milestones: [
    { title: "print hello", check: { files: ["bin/hello.js"] } },
    { title: "accept name", check: { files: ["bin/hello.js"] } },
  ],
};

describe("plan lifecycle", () => {
  it("plan_write approves, creates baseline, and milestone_done walks the plan to complete", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(PLAN_ARGS, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        const result = await pending;
        turn.transcript.push({ role: "assistant", content: result });
        yield { kind: "write", record: { path: "bin/hello.js", ok: true } };
        const done = turn.tools.find("milestone_done")!;
        const r1 = await done.execute({ id: "M1" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: String(r1) });
        const r2 = await done.execute({ id: "M2" }, null, turn.signal).catch((e) => `ERR ${e.message}`);
        turn.transcript.push({ role: "assistant", content: `R1:${r1} R2:${r2}` });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "bin/hello.js": "console.log('hi')" } });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "build it" });
    const fin = await h.finished;
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.some((e) => e.kind === "plan.approved" && (e as { milestoneCount: number }).milestoneCount === 2)).toBe(true);
    expect(h.events.filter((e) => e.kind === "milestone.done").length).toBe(2);
  });

  it("plan_write declines: returns not approved and no plan is active", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(PLAN_ARGS, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        turn.transcript.push({ role: "assistant", content: String(await pending) });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    void (async () => {
      for (;;) {
        const q = h.events.find((e) => e.kind === "ask_user") as { questionId: string } | undefined;
        if (q) return h.interaction.resolveAnswer(q.questionId, "Revise");
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await h.svc.send({ text: "plan it" });
    const fin = await h.finished;
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.some((e) => e.kind === "plan.approved")).toBe(false);
  });

  it("rejects a milestone with no command or files", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        await expect(write.execute({ goal: "g", milestones: [{ title: "t", check: {} }] }, null, turn.signal)).rejects.toThrow(/check/);
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    autoAnswer(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
  });

  it("milestone_done fails run-check, retries, marks failed at 3 attempts", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute({ goal: "g", milestones: [{ title: "needs file", check: { files: ["missing.txt"] } }] }, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        const done = turn.tools.find("milestone_done")!;
        const r1 = String(await done.execute({ id: "M1" }, null, turn.signal));
        const r2 = String(await done.execute({ id: "M1" }, null, turn.signal));
        const r3 = String(await done.execute({ id: "M1" }, null, turn.signal));
        turn.transcript.push({ role: "assistant", content: `${r1} | ${r2} | ${r3}` });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
    const fail = h.events.find((e) => e.kind === "milestone.failed") as { error: string } | undefined;
    expect(fail?.error).toContain("missing.txt");
  });

  it("milestone_done errors on the wrong id and without a plan", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const done = turn.tools.find("milestone_done")!;
        await expect(done.execute({ id: "M1" }, null, turn.signal)).rejects.toThrow(/no approved plan/);
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    autoAnswer(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
  });

  it("turn ends failed when an approved plan is left incomplete", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(PLAN_ARGS, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        turn.transcript.push({ role: "assistant", content: "half done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    const fin = await h.finished;
    expect(fin).toMatchObject({ status: "failed" });
    expect((fin as { error?: string }).error).toMatch(/^plan incomplete: M1 print hello: /);
  });

  it("auto-passes all pending milestones at turn end when every check passes", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(PLAN_ARGS, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        yield { kind: "write", record: { path: "bin/hello.js", ok: true } };
        turn.transcript.push({ role: "assistant", content: "all done, forgot milestone_done" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "bin/hello.js": "console.log('hi')" } });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    const fin = await h.finished;
    expect(fin).toMatchObject({ status: "done" });
    expect(h.events.filter((e) => e.kind === "milestone.done").length).toBe(2);
  });

  it("auto-pass stops at the first failing milestone and reports its evidence", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(
          { goal: "g", milestones: [{ title: "one", check: { files: ["a.txt"] } }, { title: "two", check: { files: ["b.txt"] } }, { title: "three", check: { files: ["c.txt"] } }] },
          null,
          turn.signal,
        );
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        yield { kind: "write", record: { path: "a.txt", ok: true } };
        turn.transcript.push({ role: "assistant", content: "partial" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "a.txt": "x" } });
    approvePlan(h.interaction, h.events);
    const { sessionId } = await h.svc.send({ text: "go" });
    const fin = await h.finished;
    expect(fin).toMatchObject({ status: "failed" });
    expect((fin as { error?: string }).error).toMatch(/^plan incomplete: M2 two: .*b\.txt/);
    expect(h.events.filter((e) => e.kind === "milestone.done").length).toBe(1);
    const summary = (await h.svc.planFor(sessionId)) as { milestones: { id: string; status: string; checkpoint?: string }[] } | undefined;
    expect(summary?.milestones[0]).toMatchObject({ status: "done" });
    expect(summary?.milestones[0].checkpoint).toBeTruthy();
    expect(summary?.milestones[1]).toMatchObject({ status: "pending", attempts: 0 });
    expect(summary?.milestones[1].checkpoint).toBeUndefined();
  });

  it("hostTools carries plan tools but the project registry excludes .stewart paths", async () => {
    const engine = scripted([
      async function* (turn: EngineTurn) {
        expect(turn.hostTools?.find("plan_write")).toBeDefined();
        expect(turn.hostTools?.find("milestone_done")).toBeDefined();
        expect(turn.tools.find("plan_write")).toBeDefined();
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    autoAnswer(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
  });
});

describe("plan state on disk", () => {
  it("writes .stewart/plan.md and loads it as a summary", async () => {
    let sessionId = "";
    const engine = scripted([
      async function* (turn: EngineTurn) {
        sessionId = turn.sessionId;
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute(PLAN_ARGS, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
    const raw = Object.entries(h.files).find(([p]) => p.endsWith(".stewart/plan.md"));
    expect(raw).toBeDefined();
    const parsed = raw![1];
    expect(parsed).toContain("# Plan: build hello");
    const summary = (await h.svc.planFor(sessionId)) as { status: string; milestones: unknown[] } | undefined;
    expect(summary?.status).toBe("active");
    expect(summary?.milestones.length).toBe(2);
    const resume = await h.svc.resume(sessionId);
    expect(resume.runId).toBeDefined();
  });

  it("resume fails without an active plan", async () => {
    const h = harness({});
    const r = await h.svc.resume("sess-none");
    expect(r).toMatchObject({ ok: false });
  });

  it("revert restores a milestone snapshot and emits run.reverted", async () => {
    let sessionId = "";
    const engine = scripted([
      async function* (turn: EngineTurn) {
        sessionId = turn.sessionId;
        const write = turn.tools.find("plan_write")!;
        const pending = write.execute({ goal: "g", milestones: [{ title: "m1", check: { files: ["f.txt"] } }] }, null, turn.signal);
        await new Promise((r) => setTimeout(r, 5));
        await pending;
        yield { kind: "write", record: { path: "f.txt", ok: true } };
        const done = turn.tools.find("milestone_done")!;
        await done.execute({ id: "M1" }, null, turn.signal);
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ engine, files: { "f.txt": "one" } });
    approvePlan(h.interaction, h.events);
    await h.svc.send({ text: "go" });
    await h.finished;
    const summary = (await h.svc.planFor(sessionId)) as { latest?: string; baseline?: string } | undefined;
    expect(summary?.latest).toBeDefined();
    const r = await h.svc.revert(sessionId, "baseline");
    expect(r.ok).toBe(true);
    expect(h.events.some((e) => e.kind === "run.reverted")).toBe(true);
  });
});
