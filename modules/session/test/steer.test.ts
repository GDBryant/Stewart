import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter } from "@stewart/channels";
import type { ChatMessage } from "@stewart/kernel";
import { runFunction, type Engine, type EngineEvent, type EngineTurn } from "@stewart/engines";
import { STEWART_GUIDANCE_MARKER } from "@stewart/protocol";
import { harness, makeConfig, fakeChannel } from "./harness.js";

function gate(): { release(): void; promise: Promise<void> } {
  let release!: () => void;
  return { release: () => release(), promise: new Promise<void>((r) => (release = r)) };
}

function gatedEngine(body: (turn: EngineTurn, g: { promise: Promise<void> }) => AsyncGenerator<EngineEvent, void>): { engine: Engine; g: { promise: Promise<void>; release(): void } } {
  const g = gate();
  const engine: Engine = {
    id: "native-loop",
    caps: { ownTools: false, ownContext: false },
    run: (turn) => body(turn, g),
    complete: runFunction,
  };
  return { engine, g };
}

describe("SessionService.steer", () => {
  it("drains an accepted steer into the transcript with the guidance marker before the next model turn", async () => {
    const seen: ChatMessage[][] = [];
    const { engine, g } = gatedEngine(async function* (turn, g) {
      await turn.beforeModelTurn?.();
      await g.promise;
      await turn.beforeModelTurn?.();
      seen.push([...turn.transcript]);
      turn.transcript.push({ role: "assistant", content: "done" });
      yield { kind: "finished", reason: "stop" };
    });
    const h = harness({ engine });
    const { runId, sessionId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    expect(h.svc.steer(runId, "use file b instead", ["data:image/png;base64,aGk="])).toEqual({ ok: true });
    g.release();
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
    const guided = seen[0].filter((m) => m.content.startsWith(STEWART_GUIDANCE_MARKER));
    expect(guided).toHaveLength(1);
    expect(guided[0].content).toBe(`${STEWART_GUIDANCE_MARKER}use file b instead`);
    expect(guided[0].images).toEqual(["data:image/png;base64,aGk="]);
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    expect(stored.messages.some((m: { content: string }) => m.content === `${STEWART_GUIDANCE_MARKER}use file b instead`)).toBe(true);
  });

  it("drains multiple steers FIFO", async () => {
    const seen: ChatMessage[][] = [];
    const { engine, g } = gatedEngine(async function* (turn, g) {
      await g.promise;
      await turn.beforeModelTurn?.();
      seen.push([...turn.transcript]);
      turn.transcript.push({ role: "assistant", content: "done" });
      yield { kind: "finished", reason: "stop" };
    });
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    h.svc.steer(runId, "first");
    h.svc.steer(runId, "second");
    g.release();
    await h.waitFor("run.finished");
    const guided = seen[0].filter((m) => m.content.startsWith(STEWART_GUIDANCE_MARKER)).map((m) => m.content);
    expect(guided).toEqual([`${STEWART_GUIDANCE_MARKER}first`, `${STEWART_GUIDANCE_MARKER}second`]);
  });

  it("a steer accepted while ask_user is pending drains at the model turn after the answer", async () => {
    const channel = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "q1", name: "ask_user", arguments: { question: "pick", options: ["a", "b"] } }] }, { kind: "done" }],
      [{ kind: "text", text: "picked" }, { kind: "done" }],
    ]);
    const h = harness({ channel });
    const { runId, sessionId } = await h.svc.send({ text: "ask" });
    const ask = await h.waitFor("ask_user");
    expect(h.svc.steer(runId, "lean toward b")).toEqual({ ok: true });
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "b");
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    const roles = stored.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(stored.messages[3].content).toBe(`${STEWART_GUIDANCE_MARKER}lean toward b`);
  });

  it("an undrained steer requeues as a literal session turn ahead of later sends (done run)", async () => {
    const { engine, g } = gatedEngine(async function* (turn, g) {
      await g.promise;
      turn.transcript.push({ role: "assistant", content: "done" });
      yield { kind: "finished", reason: "stop" };
    });
    const h = harness({ engine });
    const { runId, sessionId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    h.svc.steer(runId, "/bogus stays literal");
    g.release();
    await h.waitFor("run.finished");
    await h.waitFor("run.started");
    await h.waitFor("run.finished");
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    const users = stored.messages.filter((m: { role: string }) => m.role === "user").map((m: { content: string }) => m.content);
    expect(users).toEqual(["go", "/bogus stays literal"]);
  });

  it("requeues undrained steers after a failed run too", async () => {
    const g = gate();
    let n = 0;
    const engine: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: runFunction,
      async *run(turn: EngineTurn) {
        if (n++ > 0) {
          turn.transcript.push({ role: "assistant", content: "ok" });
          yield { kind: "finished", reason: "stop" };
          return;
        }
        await g.promise;
        yield { kind: "finished", reason: "error", error: "boom" };
      },
    };
    const h = harness({ engine });
    const { runId, sessionId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    h.svc.steer(runId, "still try this");
    g.release();
    const ask = await h.waitFor("ask_user");
    h.interaction.resolveAnswer((ask as { questionId: string }).questionId, "Stop");
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "failed" });
    await h.waitFor("run.started");
    await h.waitFor("run.finished");
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    const users = stored.messages.filter((m: { role: string }) => m.role === "user").map((m: { content: string }) => m.content);
    expect(users[users.length - 1]).toBe("still try this");
  });

  it("a cancelled run discards undrained steers", async () => {
    const h = harness({
      engine: {
        id: "native-loop",
        caps: { ownTools: false, ownContext: false },
        complete: runFunction,
        async *run(turn: EngineTurn) {
          while (!turn.signal.aborted) await new Promise((r) => setTimeout(r, 5));
          yield { kind: "finished", reason: "cancelled" };
        },
      },
    });
    const { runId, sessionId } = await h.svc.send({ text: "long" });
    await h.waitFor("run.started");
    await new Promise((r) => setTimeout(r, 20));
    h.svc.steer(runId, "never read");
    h.svc.cancel(runId);
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "cancelled" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.events.filter((e) => e.kind === "run.started")).toHaveLength(1);
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    expect(stored.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(1);
  });

  it("rejects steering when the live engine owns its context", async () => {
    let began!: () => void;
    const beganP = new Promise<void>((r) => (began = r));
    const g = gate();
    const engine: Engine = {
      id: "claude-code",
      caps: { ownTools: true, ownContext: true },
      complete: runFunction,
      async *run(turn: EngineTurn) {
        began();
        await g.promise;
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "go" });
    await beganP;
    expect(h.svc.steer(runId, "mid-run")).toEqual({ ok: false, reason: "engine unsupported" });
    g.release();
    await h.waitFor("run.finished");
  });

  it("a steer accepted during a native attempt stays queued when the run escalates to an own-context engine, then requeues", async () => {
    const chan = (id: string, type: string) => {
      const adapter: ChannelAdapter = { type, listModels: async () => ["m"], probeCaps: async () => ({}), chat: async function* () {} };
      return new ManagedChannel(adapter, { id, type, enabled: true, maxParallel: 8 });
    };
    const g1 = gate();
    const g2 = gate();
    let began2!: () => void;
    const began2P = new Promise<void>((r) => (began2 = r));
    const native: Engine = {
      id: "native-loop",
      caps: { ownTools: false, ownContext: false },
      complete: runFunction,
      async *run(turn: EngineTurn) {
        await g1.promise;
        turn.transcript.push({ role: "assistant", content: "tried" });
        yield { kind: "finished", reason: "error", error: "boom" };
      },
    };
    const own: Engine = {
      id: "claude-code",
      caps: { ownTools: true, ownContext: true },
      complete: runFunction,
      async *run(turn: EngineTurn) {
        began2();
        await g2.promise;
        turn.transcript.push({ role: "assistant", content: "done by cli" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const base = makeConfig();
    const config = makeConfig({
      channels: [
        base.channels[0],
        { id: "c2", type: "ownctx", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } } } } },
      ],
      agents: [
        { id: "a", channel: "c", model: "m", effort: "medium" },
        { id: "b", channel: "c2", model: "m", effort: "medium" },
      ],
      roles: [{ ...base.roles[0], agent: "a", secondary: "b" }],
    });
    const h = harness({
      config,
      channelFor: (id) => (id === "c2" ? chan("c2", "ownctx") : chan("c", "fake")),
      engineFor: (type) => (type === "ownctx" ? own : native),
    });
    const { runId, sessionId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    expect(h.svc.steer(runId, "mid-run steer")).toEqual({ ok: true });
    g1.release();
    await began2P;
    expect(h.svc.steer(runId, "too late for the cli")).toEqual({ ok: false, reason: "engine unsupported" });
    g2.release();
    expect(await h.waitFor("run.finished")).toMatchObject({ status: "done" });
    await h.waitFor("run.started");
    await h.waitFor("run.finished");
    const stored = JSON.parse(h.files[`/tmp/st/history/${sessionId}.json`]);
    const users = stored.messages.filter((m: { role: string }) => m.role === "user").map((m: { content: string }) => m.content);
    expect(users).toContain("mid-run steer");
  });

  it("reports steer limit, empty, unknown run and cancelled run", async () => {
    const { engine, g } = gatedEngine(async function* (_turn, g) {
      await g.promise;
      yield { kind: "finished", reason: "stop" };
    });
    const h = harness({ engine });
    const { runId } = await h.svc.send({ text: "go" });
    await h.waitFor("run.started");
    expect(h.svc.steer("run-nope", "x")).toEqual({ ok: false, reason: "run not active" });
    expect(h.svc.steer(runId, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(h.svc.steer(runId, "", ["data:image/png;base64,aGk="])).toEqual({ ok: true });
    for (let i = 0; i < 19; i++) expect(h.svc.steer(runId, `s${i}`).ok).toBe(true);
    expect(h.svc.steer(runId, "one too many")).toEqual({ ok: false, reason: "steer limit" });
    h.svc.cancel(runId);
    expect(h.svc.steer(runId, "too late")).toEqual({ ok: false, reason: "run cancelled" });
    g.release();
    await h.waitFor("run.finished");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.svc.steer(runId, "gone")).toEqual({ ok: false, reason: "run not active" });
  });
});
