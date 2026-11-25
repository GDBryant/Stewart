import { describe, expect, it } from "vitest";
import type { EngineTurn } from "@stewart/engines";
import { harness, makeConfig, scriptedEngine } from "./harness.js";

async function windowSeen(config = makeConfig()): Promise<number | undefined> {
  let seen: EngineTurn | undefined;
  const engine = scriptedEngine([
    async function* (turn) {
      seen = turn;
      turn.transcript.push({ role: "assistant", content: "done" });
      yield { kind: "text", text: "done" };
      yield { kind: "finished", reason: "stop" };
    },
  ]);
  const h = harness({ engine, config });
  await h.svc.send({ text: "go" });
  await h.waitFor("run.finished");
  return seen?.window;
}

describe("engine turn window", () => {
  it("carries the agent's qualified context window", async () => {
    expect(await windowSeen()).toBe(32000);
  });

  it("is undefined when the window is unknown (no probe, no qualified context)", async () => {
    const base = makeConfig();
    const config = makeConfig({ channels: [{ ...base.channels[0], modelCaps: { m: { qualified: { agent: { passed: true, at: 1, version: 2 } } } } }] });
    expect(await windowSeen(config)).toBeUndefined();
  });
});
