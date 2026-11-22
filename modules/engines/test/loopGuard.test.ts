import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/loopGuard.js";

const rec = (name: string, args: unknown, ok: boolean, result: string) => ({ name, args, ok, result });

describe("LoopGuard", () => {
  it("warns on the second identical failure and trips on the third (argument key order ignored)", () => {
    const g = new LoopGuard();
    expect(g.record(rec("Run", { a: 1, b: 2 }, false, "x"))).toBeUndefined();
    expect(g.trip).toBeUndefined();
    const warn = g.record(rec("Run", { b: 2, a: 1 }, false, "y"));
    expect(warn).toContain("was already called");
    expect(warn).toContain("One more identical call ends this run");
    expect(g.trip).toBeUndefined();
    g.record(rec("Run", { a: 1, b: 2 }, false, "z"));
    expect(g.trip).toContain("same call failed 3 times");
    expect(g.trip).toContain("Run");
  });

  it("warns exactly on the second identical result and trips on the third", () => {
    const g = new LoopGuard();
    expect(g.record(rec("ReadFile", { path: "a" }, true, "same"))).toBeUndefined();
    expect(g.record(rec("ReadFile", { path: "a" }, true, "same"))).toContain("[Stewart]");
    expect(g.trip).toBeUndefined();
    expect(g.record(rec("ReadFile", { path: "a" }, true, "same"))).toBeUndefined();
    expect(g.trip).toContain("returned the same result 3 times");
  });

  it("does not trip when the result changes between identical calls", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) g.record(rec("RunTerminal", { command: "npm test" }, true, `run ${i}`));
    expect(g.trip).toBeUndefined();
  });

  it("forgets repeats older than the last 12 calls", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 3; i++) {
      g.record(rec("ReadFile", { path: "a" }, true, "same"));
      for (let j = 0; j < 13; j++) g.record(rec("ReadFile", { path: `f${j}.ts` }, true, `c${j}`));
    }
    expect(g.trip).toBeUndefined();
  });

  it("trips on A,B,A,B,A inside the window", () => {
    const g = new LoopGuard();
    for (const [name, args] of [
      ["ReadFile", { path: "a" }],
      ["Search", { query: "q" }],
      ["ReadFile", { path: "a" }],
      ["Search", { query: "q" }],
      ["ReadFile", { path: "a" }],
    ] as const) {
      g.record(rec(name, args, true, "same"));
    }
    expect(g.trip).toContain("returned the same result 3 times");
  });

  it("a successful write call clears the repeat window", () => {
    const g = new LoopGuard();
    g.record(rec("ReadFile", { path: "a" }, true, "same"));
    g.record(rec("ReadFile", { path: "a" }, true, "same"));
    g.record(rec("EditFile", { path: "b" }, true, "edited"));
    g.record(rec("ReadFile", { path: "a" }, true, "same"));
    g.record(rec("ReadFile", { path: "a" }, true, "same"));
    expect(g.trip).toBeUndefined();
  });

  it("trips after six model turns in which every call failed; a success resets the streak", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) {
      g.record(rec("X", { i }, false, "e"));
      g.endTurn();
    }
    g.record(rec("Y", {}, true, "ok"));
    g.endTurn();
    for (let i = 10; i < 15; i++) {
      g.record(rec("X", { i }, false, "e"));
      g.endTurn();
    }
    expect(g.trip).toBeUndefined();
    g.record(rec("X", { i: 99 }, false, "e"));
    g.endTurn();
    expect(g.trip).toContain("6 consecutive");
  });

  it("ignores endTurn with no calls", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 10; i++) g.endTurn();
    expect(g.trip).toBeUndefined();
  });
});
