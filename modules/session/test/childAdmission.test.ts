import { describe, expect, it } from "vitest";
import { settingsFile } from "@stewart/config";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import { harness, makeConfig, scriptedEngine } from "./harness.js";

const reviewer = { id: "reviewer", enabled: true, prompt: "You review.", skills: ["code-health"], tools: ["ReadFile"], writePaths: [], turnBudget: 5 };

async function* readOnce(id = "r"): AsyncGenerator<EngineEvent, void> {
  yield { kind: "tool.request", callId: id, tool: "ReadFile", args: { path: "src/a.ts" }, category: "READ" };
  yield { kind: "tool.outcome", callId: id, ok: true, summary: "ok" };
}

/** Lead delegates `n` reviewers at once; returns the peak number of children running concurrently. */
async function peak(n: number, limit: number): Promise<{ peak: number; events: string[] }> {
  const config = makeConfig({ roles: [makeConfig().roles[0], reviewer], settings: { ...settingsFile.parse({}), runTurnLimit: 2000 } });
  let active = 0;
  let max = 0;
  const child = async function* (turn: EngineTurn): AsyncGenerator<EngineEvent, void> {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    yield* readOnce();
    turn.transcript.push({ role: "assistant", content: "src/a.ts:1 — fine" });
    yield { kind: "finished", reason: "stop" };
  };
  const lead = async function* (turn: EngineTurn): AsyncGenerator<EngineEvent, void> {
    const tool = turn.tools.find("delegate")!;
    await Promise.all(Array.from({ length: n }, (_, i) => tool.execute({ role: "reviewer", task: `review ${i}` }, null, turn.signal)));
    turn.transcript.push({ role: "assistant", content: "done" });
    yield { kind: "finished", reason: "stop" };
  };
  const base = scriptedEngine([lead, ...Array.from({ length: n }, () => child)]);
  const engine: Engine = base;
  const h = harness({ config, engine, files: { "src/a.ts": "x" } });
  h.channel.update({ ...h.channel.cfg, maxParallel: limit });
  await h.svc.send({ text: "go" });
  await h.waitFor("run.finished", 5000);
  return { peak: max, events: h.events.map((e) => e.kind) };
}

describe("delegate admission per channel", () => {
  it("runs one delegated task at a time on a maxParallel:1 channel; the others stay pending", async () => {
    const r = await peak(3, 1);
    expect(r.peak).toBe(1);
    expect(r.events.filter((k) => k === "task.created")).toHaveLength(3);
    expect(r.events.filter((k) => k === "task.done")).toHaveLength(3);
    const firstStart = r.events.indexOf("task.started");
    expect(r.events.slice(0, firstStart).filter((k) => k === "task.created").length).toBeGreaterThan(1);
  });

  it("runs delegated tasks together when the channel allows it", async () => {
    expect((await peak(3, 3)).peak).toBe(3);
  });
});

describe("child agent label", () => {
  it("labels task.started with the first eligible agent, not role.agent", async () => {
    const q = { agent: { passed: true, at: 1, version: 2, context: 32000 } };
    const channels = [{ id: "c", type: "fake", enabled: true, discoverModels: true, extraModels: [], modelCaps: { m1: {}, m2: { qualified: q } } }];
    const agents = [
      { id: "a1", channel: "c", model: "m1", effort: "medium" as const },
      { id: "a2", channel: "c", model: "m2", effort: "medium" as const },
    ];
    const childRole = { ...reviewer, agent: "a1", secondary: "a2" };
    const lead = { ...makeConfig().roles[0], agent: "a2" };
    const config = makeConfig({ channels, agents, roles: [lead, childRole] });
    let childAgentId = "";
    const engine = scriptedEngine([
      async function* (turn: EngineTurn) {
        const tool = turn.tools.find("delegate")!;
        await tool.execute({ role: "reviewer", task: "review x" }, null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "done" });
        yield { kind: "finished", reason: "stop" };
      },
      async function* (turn: EngineTurn) {
        childAgentId = turn.agent.id;
        turn.transcript.push({ role: "assistant", content: "ok" });
        yield { kind: "finished", reason: "stop" };
      },
    ]);
    const h = harness({ config, engine, files: { "src/a.ts": "x" } });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished", 5000);
    expect(childAgentId).toBe("a2");
    expect(h.events.find((e) => e.kind === "task.started")).toMatchObject({ agentId: "a2" });
  });
});

describe("role think setting", () => {
  async function seen(think: boolean | undefined): Promise<EngineTurn> {
    const lead = { ...makeConfig().roles[0], ...(think === undefined ? {} : { think }) };
    let got: EngineTurn | undefined;
    const step = async function* (turn: EngineTurn): AsyncGenerator<EngineEvent, void> {
      got = turn;
      turn.transcript.push({ role: "assistant", content: "ok" });
      yield { kind: "finished", reason: "stop" };
    };
    const h = harness({ config: makeConfig({ roles: [lead] }), engine: scriptedEngine([step]) });
    await h.svc.send({ text: "go" });
    await h.waitFor("run.finished", 5000);
    return got!;
  }

  it("passes role.think to the engine turn", async () => {
    expect((await seen(false)).think).toBe(false);
    expect((await seen(true)).think).toBe(true);
  });

  it("leaves think unset when the role does not set it", async () => {
    expect("think" in (await seen(undefined))).toBe(false);
  });
});
