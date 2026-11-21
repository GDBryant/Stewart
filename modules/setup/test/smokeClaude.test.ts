import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { Engine, EngineEvent, EngineTurn } from "@stewart/engines";
import { smokeClaude } from "../src/smokeClaude.js";

const never = new AbortController().signal;
const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };

function channel(): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "claude-cli",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* () {},
  };
  return new ManagedChannel(adapter, { id: "c", type: "claude-cli", enabled: true, maxParallel: 1 });
}

function engine(events: (EngineEvent | "hang" | Error)[], inspect?: (turn: EngineTurn) => void): Engine {
  return {
    id: "claude-code",
    caps: { ownTools: true, ownContext: true },
    async *run(turn: EngineTurn): AsyncGenerator<EngineEvent> {
      inspect?.(turn);
      for (const e of events) {
        if (turn.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (e === "hang") await new Promise(() => {});
        if (e instanceof Error) throw e;
        yield e;
      }
    },
    complete: async () => ({ ok: true, value: {} }),
  };
}

const req = (e: Engine, dir = "/tmp/smoke-x") => ({ engine: e, agent, channel: channel(), dir });

describe("smokeClaude", () => {
  it("green on a text reply and finished:stop; transcript-only replies also count", async () => {
    const r = await smokeClaude(req(engine([{ kind: "text", text: "OK" }, { kind: "finished", reason: "stop" }])), { signal: never });
    expect(r.state).toBe("green");

    const transcriptOnly: Engine = {
      id: "claude-code",
      caps: { ownTools: true, ownContext: true },
      async *run(turn: EngineTurn) {
        turn.transcript.push({ role: "assistant", content: "OK" });
        yield { kind: "finished", reason: "stop" };
      },
      complete: async () => ({ ok: true, value: {} }),
    };
    expect((await smokeClaude(req(transcriptOnly), { signal: never })).state).toBe("green");
  });

  it("red on engine-error finish, missing finish, empty reply, tool-only output and a throwing run", async () => {
    const e1 = await smokeClaude(req(engine([{ kind: "finished", reason: "error", error: "spawn failed" }])), { signal: never });
    expect(e1).toMatchObject({ state: "red", reason: "engine error: spawn failed" });
    const e2 = await smokeClaude(req(engine([{ kind: "text", text: "hi" }])), { signal: never });
    expect(e2).toMatchObject({ state: "red", reason: "stream ended without completion" });
    const e3 = await smokeClaude(req(engine([{ kind: "finished", reason: "stop" }])), { signal: never });
    expect(e3).toMatchObject({ state: "red", reason: "empty response" });
    const e4 = await smokeClaude(
      req(engine([{ kind: "tool.request", callId: "t", tool: "Bash", args: {}, category: "COMMANDS" }, { kind: "finished", reason: "stop" }])),
      { signal: never },
    );
    expect(e4).toMatchObject({ state: "red", reason: "tool calls but no text" });
    const boom = engine([new Error("spawn boom")]);
    expect((await smokeClaude(req(boom), { signal: never })).state).toBe("red");
  });

  it("orange on timeout, aborted on outer cancel", async () => {
    const t = await smokeClaude(req(engine(["hang"])), { signal: never, timeoutMs: 15 });
    expect(t.state).toBe("orange");
    expect(t.reason).toContain("15ms");
    const ctrl = new AbortController();
    const p = smokeClaude(req(engine(["hang"])), { signal: ctrl.signal, timeoutMs: 5000 });
    setTimeout(() => ctrl.abort(), 5);
    expect((await p).state).toBe("aborted");
  });

  it("runs a no-tools turn in the scratch dir, capped at 2 turns, every call denied", async () => {
    let seen: EngineTurn | undefined;
    const e = engine([{ kind: "finished", reason: "stop" }], (t) => {
      seen = t;
    });
    await smokeClaude(req(e, "/tmp/smoke-dir"), { signal: never });
    expect(seen?.cwd).toBe("/tmp/smoke-dir");
    expect(seen?.maxTurns).toBe(2);
    expect(seen?.tools.specs).toHaveLength(0);
    expect(seen?.transcript).toEqual([{ role: "user", content: "Reply with exactly: OK" }]);
    await expect(seen!.approve({ id: "t1", name: "Bash", arguments: { command: "ls" } }, { kind: "other" })).resolves.toMatchObject({ kind: "rejected" });
  });
});
