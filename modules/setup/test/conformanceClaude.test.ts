import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { ManagedChannel, type ChannelAdapter } from "@stewart/channels";
import type { AgentDef, ChannelDef } from "@stewart/config";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import { qualifyAgent, type QualifyDeps } from "../src/conformance.js";

const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };
const ch: ChannelDef = {
  id: "c", type: "claude-cli", enabled: true, discoverModels: true, extraModels: [],
  modelCaps: { m: { contextTokens: 200000, tools: "native" } },
};
const chUnknown: ChannelDef = { ...ch, modelCaps: { m: { tools: "native" } } };

function channel(): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "claude-cli",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {},
  };
  return new ManagedChannel(adapter, { id: "c", type: "claude-cli", enabled: true, maxParallel: 1 });
}

function scratch(): { host: ReturnType<typeof fakeHost>["host"]; dir: string; files: Record<string, string> } {
  const { host, files } = fakeHost();
  return { host, dir: "/tmp/qual-x", files };
}

const deps = (s: ReturnType<typeof scratch>, engine?: Engine): QualifyDeps => ({
  clock: { now: () => 42 },
  engine,
  scratch: { host: s.host, dir: s.dir },
});

/** Engine that performs the task on the real scratch dir through the shared files map. */
function passingEngine(files: Record<string, string>, dir: string): Engine {
  return {
    id: "claude-code",
    async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
      const approved = await turn.approve(
        { id: "b1", name: "Bash", arguments: { command: "rm -rf /" } },
        { kind: "command", command: "rm -rf /", cwd: "." },
      );
      expect(approved.kind).toBe("rejected");
      files[`${dir}/notes/todo.txt`] = "alpha\nbeta\ngamma\n";
      yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
      yield { kind: "tool.outcome", callId: "w1", ok: true, summary: "3 notes/todo.txt" };
      turn.transcript.push({ role: "assistant", content: "It printed 3" });
      yield { kind: "finished", reason: "stop" };
    },
  };
}

describe("qualifyAgent: claude-cli", () => {
  it("passes a real engine run that edits the file, runs wc and reports 3, then removes scratch files", async () => {
    const s = scratch();
    const q = await qualifyAgent(ch, agent, channel(), deps(s, passingEngine(s.files, s.dir)));
    expect(q).toMatchObject({ passed: true, at: 42, context: 200000 });
    expect(await s.host.files.exists(`${s.dir}/notes/todo.txt`)).toBe(false);
  });

  it("fails without a scratch directory", async () => {
    const q = await qualifyAgent(ch, agent, channel(), { clock: { now: () => 42 } });
    expect(q).toMatchObject({ passed: false, detail: "claude-cli qualification needs a scratch directory" });
  });

  it("fails on wrong file content", async () => {
    const s = scratch();
    const engine: Engine = {
      id: "claude-code",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        s.files[`${s.dir}/notes/todo.txt`] = "alpha\nbeta\nwrong\n";
        yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
        yield { kind: "tool.outcome", callId: "w1", ok: true, summary: "3 notes/todo.txt" };
        turn.transcript.push({ role: "assistant", content: "3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    const q = await qualifyAgent(ch, agent, channel(), deps(s, engine));
    expect(q.passed).toBe(false);
    expect(q.detail).toContain("file not edited to expected content");
  });

  it("fails when no successful wc command ran", async () => {
    const s = scratch();
    const engine: Engine = {
      id: "claude-code",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        s.files[`${s.dir}/notes/todo.txt`] = "alpha\nbeta\ngamma\n";
        yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
        yield { kind: "tool.outcome", callId: "w1", ok: false, summary: "failed" };
        turn.transcript.push({ role: "assistant", content: "3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    expect((await qualifyAgent(ch, agent, channel(), deps(s, engine))).detail).toContain("wc");
  });

  it("approves read-only calls and rejects file previews outside the scratch dir", async () => {
    const s = scratch();
    const engine: Engine = {
      id: "claude-code",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        const read = await turn.approve({ id: "r1", name: "Read", arguments: {} }, { kind: "other" });
        expect(read.kind).toBe("approved");
        const outside = await turn.approve(
          { id: "e1", name: "Edit", arguments: {} },
          { kind: "file", path: "/etc/passwd", before: "x", after: "y" },
        );
        expect(outside).toMatchObject({ kind: "rejected" });
        s.files[`${s.dir}/notes/todo.txt`] = "alpha\nbeta\ngamma\n";
        yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
        yield { kind: "tool.outcome", callId: "w1", ok: true, summary: "3 notes/todo.txt" };
        turn.transcript.push({ role: "assistant", content: "3" });
        yield { kind: "finished", reason: "stop" };
      },
    };
    expect((await qualifyAgent(ch, agent, channel(), deps(s, engine))).passed).toBe(true);
  });

  it("runs the window probe through the engine when the window is unknown", async () => {
    const s = scratch();
    let calls = 0;
    const engine: Engine = {
      id: "claude-code",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        calls++;
        if (calls === 1) {
          const denied = await turn.approve({ id: "b1", name: "Bash", arguments: {} }, { kind: "command", command: "echo x", cwd: "." });
          expect(denied).toMatchObject({ kind: "rejected", reason: expect.stringContaining("Edit") });
          s.files[`${s.dir}/notes/todo.txt`] = "alpha\nbeta\ngamma\n";
          yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
          yield { kind: "tool.outcome", callId: "w1", ok: true, summary: "3" };
          turn.transcript.push({ role: "assistant", content: "3" });
        } else {
          expect(String((turn.transcript[0] as { content: string }).content)).toContain("code word is quillfeather");
          const denied = await turn.approve({ id: "p1", name: "Edit", arguments: {} }, { kind: "file", path: "notes/todo.txt", before: "", after: "" });
          expect(denied.kind).toBe("rejected");
          turn.transcript.push({ role: "assistant", content: "quillfeather" });
        }
        yield { kind: "finished", reason: "stop" };
      },
    };
    const q = await qualifyAgent(chUnknown, agent, channel(), deps(s, engine));
    expect(q).toMatchObject({ passed: true, context: 32000 });
    expect(calls).toBe(2);
  });

  it("fails the probe when the engine reply does not echo the code word", async () => {
    const s = scratch();
    let calls = 0;
    const engine: Engine = {
      id: "claude-code",
      async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
        calls++;
        if (calls === 1) {
          s.files[`${s.dir}/notes/todo.txt`] = "alpha\nbeta\ngamma\n";
          yield { kind: "tool.request", callId: "w1", tool: "Bash", args: { command: "wc -l notes/todo.txt" }, category: "COMMANDS" };
          yield { kind: "tool.outcome", callId: "w1", ok: true, summary: "3" };
          turn.transcript.push({ role: "assistant", content: "3" });
        } else {
          turn.transcript.push({ role: "assistant", content: "no idea" });
        }
        yield { kind: "finished", reason: "stop" };
      },
    };
    const q = await qualifyAgent(chUnknown, agent, channel(), deps(s, engine));
    expect(q.detail).toContain("window probe failed: code word not echoed");
  });

  it("reports the engine error", async () => {
    const s = scratch();
    const engine: Engine = {
      id: "claude-code",
      async *run(): AsyncGenerator<EngineEvent> {
        yield { kind: "finished", reason: "error", error: "cli died" };
      },
    };
    expect((await qualifyAgent(ch, agent, channel(), deps(s, engine))).detail).toBe("engine error: cli died");
  });
});
