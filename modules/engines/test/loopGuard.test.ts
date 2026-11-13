import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/loopGuard.js";

describe("LoopGuard", () => {
  it("trips when the same call fails twice (argument key order ignored)", () => {
    const g = new LoopGuard();
    g.record({ name: "Run", args: { a: 1, b: 2 }, ok: false, result: "x" });
    expect(g.trip).toBeUndefined();
    g.record({ name: "Run", args: { b: 2, a: 1 }, ok: false, result: "y" });
    expect(g.trip).toContain("same call failed twice");
  });

  it("trips when a successful call returns the same result three times", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 2; i++) g.record({ name: "ReadFile", args: { path: "a" }, ok: true, result: "same" });
    expect(g.trip).toBeUndefined();
    g.record({ name: "ReadFile", args: { path: "a" }, ok: true, result: "same" });
    expect(g.trip).toContain("returned the same result 3 times");
  });

  it("does not trip when the result changes between identical calls", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) g.record({ name: "RunTerminal", args: { command: "npm test" }, ok: true, result: `run ${i}` });
    expect(g.trip).toBeUndefined();
  });

  it("trips after six model turns in which every call failed; a success resets the streak", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 5; i++) {
      g.record({ name: "X", args: { i }, ok: false, result: "e" });
      g.endTurn();
    }
    g.record({ name: "Y", args: {}, ok: true, result: "ok" });
    g.endTurn();
    for (let i = 10; i < 15; i++) {
      g.record({ name: "X", args: { i }, ok: false, result: "e" });
      g.endTurn();
    }
    expect(g.trip).toBeUndefined();
    g.record({ name: "X", args: { i: 99 }, ok: false, result: "e" });
    g.endTurn();
    expect(g.trip).toContain("6 consecutive");
  });

  it("ignores endTurn with no calls", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 10; i++) g.endTurn();
    expect(g.trip).toBeUndefined();
  });
});
