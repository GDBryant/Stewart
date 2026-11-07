import { describe, expect, it } from "vitest";
import { compactorFor } from "../src/orchestration/roleRunner.js";

function rt(roles: unknown[], agents: unknown[], text = "note", unhealthy = false) {
  return {
    config: { roles, agents },
    signal: new AbortController().signal,
    channelFor: () => ({
      unhealthy,
      chat: async function* () {
        yield { kind: "text", text };
        yield { kind: "done" };
      },
    }),
  } as never;
}
const agent = { id: "a", channel: "c", model: "m" };

describe("compactorFor", () => {
  it("summarizes via the compactor role's agent", async () => {
    const f = compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [agent], "Goal: x"));
    expect(await f!([{ role: "user", content: "hi" }])).toBe("Goal: x");
  });
  it("is undefined without an enabled compactor role", () => {
    expect(compactorFor(rt([], [agent]))).toBeUndefined();
    expect(compactorFor(rt([{ id: "compactor", enabled: false, agent: "a" }], [agent]))).toBeUndefined();
  });
  it("is undefined when the agent is unbound or the channel unhealthy", () => {
    expect(compactorFor(rt([{ id: "compactor", enabled: true }], [agent]))).toBeUndefined();
    expect(compactorFor(rt([{ id: "compactor", enabled: true, agent: "a" }], [agent], "n", true))).toBeUndefined();
  });
});
