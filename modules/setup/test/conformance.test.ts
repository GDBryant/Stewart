import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef, ChannelDef } from "@stewart/config";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import { qualifyAgent, qualifyFunction, agentBlockReason, CONFORMANCE_VERSION, type QualifyDeps } from "../src/conformance.js";

const deps: QualifyDeps = { clock: { now: () => 42 } };
const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };
const chan = (mc: Record<string, unknown> = {}, type = "ollama"): ChannelDef => ({
  id: "c", type, enabled: true, discoverModels: true, extraModels: [],
  modelCaps: { m: { contextTokens: 40000, tools: "native", ...mc } as ChannelDef["modelCaps"] extends Record<string, infer V> ? V : never },
});

function channelWith(turns: ChatEvent[][], type = "fake"): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type,
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {
      for (const ev of turns[Math.min(i++, turns.length - 1)]) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type, enabled: true, maxParallel: 1 });
}

/** Engine scripted to perform the sandbox task the way a passing model would. */
function passingEngine(): Engine {
  return {
    id: "fake",
    async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
      const rf = turn.tools.find("ReadFile")!;
      const ef = turn.tools.find("EditFile")!;
      const rt = turn.tools.find("RunTerminal")!;
      await rf.execute({ path: "notes/todo.txt" }, null, turn.signal);
      const ea = { path: "notes/todo.txt", old_string: "beta\n", new_string: "beta\ngamma\n" };
      await ef.execute(ea, (await ef.preview?.(ea)) ?? null, turn.signal);
      const ra = { command: "wc -l notes/todo.txt" };
      await rt.execute(ra, (await rt.preview?.(ra)) ?? null, turn.signal);
      turn.transcript.push({ role: "assistant", content: "It printed 3" });
      yield { kind: "finished", reason: "stop" };
    },
  };
}

describe("agentBlockReason", () => {
  it("blocks models without native tools or with small context", () => {
    expect(agentBlockReason(chan({ tools: "none" }), "m")).toContain("native tools");
    expect(agentBlockReason(chan({ contextTokens: 8000 }), "m")).toContain("context 8000");
    expect(agentBlockReason(chan(), "m")).toBeNull();
  });
});

describe("qualifyAgent", () => {
  it("passes when the model edits the file, runs wc and reports 3", async () => {
    const q = await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: passingEngine() });
    expect(q).toMatchObject({ passed: true, at: 42, version: CONFORMANCE_VERSION });
  });

  it("reports the engine finished reason instead of criteria on engine failure", async () => {
    const dead: Engine = {
      id: "fake",
      async *run(): AsyncGenerator<EngineEvent> {
        yield { kind: "finished", reason: "turn_limit" };
      },
    };
    const q = await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: dead });
    expect(q).toMatchObject({ passed: false, detail: "engine turn_limit" });
    const err: Engine = {
      id: "fake",
      async *run(): AsyncGenerator<EngineEvent> {
        yield { kind: "finished", reason: "error", error: "boom" };
      },
    };
    expect((await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: err })).detail).toBe("engine error: boom");
  });

  it("appends the actual file content to the file criterion", async () => {
    const wrong: Engine = {
      id: "fake",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        const ea = { path: "notes/todo.txt", old_string: "beta\n", new_string: "beta\n\ngamma\n" };
        const ef = turn.tools.find("EditFile")!;
        await ef.execute(ea, (await ef.preview?.(ea)) ?? null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const q = await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: wrong });
    expect(q.passed).toBe(false);
    expect(q.detail).toContain('file not edited to expected content: "alpha\\nbeta\\n\\ngamma\\n"');
  });

  it("fails with the first failed criterion: file, wc, then reply", async () => {
    const lazy: Engine = {
      id: "fake",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        const rt = turn.tools.find("RunTerminal")!;
        const ra = { command: "wc -l notes/todo.txt" };
        await rt.execute(ra, (await rt.preview?.(ra)) ?? null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "printed 3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    expect((await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: lazy })).detail).toContain("file not edited to expected content");
    const noWc: Engine = {
      id: "fake",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        const ef = turn.tools.find("EditFile")!;
        const ea = { path: "notes/todo.txt", old_string: "beta\n", new_string: "beta\ngamma\n" };
        await ef.execute(ea, (await ef.preview?.(ea)) ?? null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "printed 3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    expect((await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: noWc })).detail).toContain("wc");
    const badReply: Engine = {
      id: "fake",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        const ef = turn.tools.find("EditFile")!;
        const rt = turn.tools.find("RunTerminal")!;
        const ea = { path: "notes/todo.txt", old_string: "beta\n", new_string: "beta\ngamma\n" };
        await ef.execute(ea, (await ef.preview?.(ea)) ?? null, turn.signal);
        const ra = { command: "wc -l notes/todo.txt" };
        await rt.execute(ra, (await rt.preview?.(ra)) ?? null, turn.signal);
        turn.transcript.push({ role: "assistant", content: "no number" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    expect((await qualifyAgent(chan(), agent, channelWith([]), { ...deps, engine: badReply })).detail).toContain("3");
  });

  it("fails without running when the model cannot serve agents", async () => {
    const q = await qualifyAgent(chan({ tools: "none" }), agent, channelWith([]), deps);
    expect(q).toMatchObject({ passed: false, detail: expect.stringContaining("native tools") });
  });

  it("passes claude-cli channels by engine type without running", async () => {
    const q = await qualifyAgent(chan({}, "claude-cli"), agent, channelWith([], "claude-cli"), deps);
    expect(q).toMatchObject({ passed: true, detail: "claude-code engine" });
  });
});

describe("qualifyFunction", () => {
  it("passes on the exact JSON object, bare or fenced", async () => {
    const bare = await qualifyFunction(agent, channelWith([[{ kind: "text", text: '{"sum":42,"word":"trawets"}' }]]), deps);
    expect(bare.passed).toBe(true);
    const fenced = await qualifyFunction(agent, channelWith([[{ kind: "text", text: '```json\n{"sum":42,"word":"trawets"}\n```' }]]), deps);
    expect(fenced.passed).toBe(true);
  });

  it("fails on bad JSON and on wrong values", async () => {
    const bad = await qualifyFunction(agent, channelWith([[{ kind: "text", text: "not json" }]]), deps);
    expect(bad).toMatchObject({ passed: false, detail: expect.stringContaining("JSON") });
    const wrong = await qualifyFunction(agent, channelWith([[{ kind: "text", text: '{"sum":41,"word":"trawets"}' }]]), deps);
    expect(wrong).toMatchObject({ passed: false, detail: expect.stringContaining("wrong values") });
  });
});
