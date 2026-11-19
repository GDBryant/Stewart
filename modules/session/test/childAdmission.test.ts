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
