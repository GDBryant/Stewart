import { describe, expect, it } from "vitest";
import { ChildLimiter } from "../src/childLimits.js";
import { functionSchema, parseCheck, strings } from "../src/delegateArgs.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ChildLimiter", () => {
  it("runs at most 4 tasks at once and queues the rest", async () => {
    const l = new ChildLimiter();
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 9 }, () => l.limited(async () => { active++; peak = Math.max(peak, active); await tick(); active--; })));
    expect(peak).toBe(4);
  });

  it("releases the slot when a task throws", async () => {
    const l = new ChildLimiter();
    for (let i = 0; i < 6; i++) await expect(l.limited(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(l.limited(async () => "ok")).resolves.toBe("ok");
  });

  it("lets readers share but gives a writer exclusive access, blocking later readers", async () => {
    const l = new ChildLimiter();
    const log: string[] = [];
    const reader = (n: string) => l.asReader(async () => { log.push(`${n}+`); await tick(); log.push(`${n}-`); });
    const r1 = reader("r1");
    const w = l.asWriter(async () => { log.push("w+"); await tick(); log.push("w-"); });
    const r2 = reader("r2");
    await Promise.all([r1, w, r2]);
    expect(log).toEqual(["r1+", "r1-", "w+", "w-", "r2+", "r2-"]);
  });

  it("frees the writer lock after a failing writer", async () => {
    const l = new ChildLimiter();
    await expect(l.asWriter(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(l.asReader(async () => 1)).resolves.toBe(1);
  });
});

describe("delegate args", () => {
  it("strings drops empties and returns undefined when none", () => {
    expect(strings(["a", "", 2])).toEqual(["a", "2"]);
    expect(strings([])).toBeUndefined();
    expect(strings("a")).toBeUndefined();
  });

  it("parseCheck accepts absent, object and rejects other shapes", () => {
    expect(parseCheck(undefined)).toBeUndefined();
    expect(parseCheck({})).toBeUndefined();
    expect(parseCheck({ files: ["a"], command: ["ls"] })).toEqual({ files: ["a"], command: ["ls"] });
    expect(() => parseCheck([])).toThrow("check must be an object");
    expect(() => parseCheck("x")).toThrow("check must be an object");
  });

  it("functionSchema requires an object", () => {
    expect(functionSchema({ type: "object" })).toEqual({ type: "object" });
    for (const bad of [undefined, null, [], "s"]) expect(() => functionSchema(bad)).toThrow("schema");
  });
});
