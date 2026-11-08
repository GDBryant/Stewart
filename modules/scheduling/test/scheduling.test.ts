import { describe, expect, it } from "vitest";
import { LeaseManager, TaskGraph, type TaskSpec } from "../src/api.js";

const spec = (id: string, dependsOn: string[] = []): TaskSpec => ({ id, roleId: "r", title: id, task: id, files: [], dependsOn });

describe("TaskGraph", () => {
  it("readies tasks once dependencies are done", () => {
    const g = new TaskGraph();
    g.add(spec("a"));
    g.add(spec("b", ["a"]));
    expect(g.ready().map((t) => t.id)).toEqual(["a"]);
    g.get("a")!.status = "done";
    expect(g.ready().map((t) => t.id)).toEqual(["b"]);
  });
  it("rejects duplicate ids, unknown deps and cycles", () => {
    const g = new TaskGraph();
    g.add(spec("a", ["b"]));
    g.add(spec("b", ["a"]));
    expect(g.add(spec("a")).ok).toBe(false);
    expect(g.validate().join()).toMatch(/cycle/);
    const h = new TaskGraph();
    h.add(spec("x", ["nope"]));
    expect(h.validate()[0]).toMatch(/unknown dependsOn/);
  });
  it("flags pending tasks blocked by a failed dependency and round-trips JSON", () => {
    const g = new TaskGraph();
    g.add(spec("a"));
    g.add(spec("b", ["a"]));
    g.get("a")!.status = "failed";
    expect(g.blockedByFailure().map((t) => t.id)).toEqual(["b"]);
    expect(g.finished).toBe(false);
    expect(TaskGraph.fromJSON(g.toJSON()).get("a")?.status).toBe("failed");
  });
});

describe("LeaseManager", () => {
  it("grants free paths, queues on conflict, hands over on release", async () => {
    const l = new LeaseManager();
    expect(l.tryAcquire("f", "t1")).toBe(true);
    expect(l.tryAcquire("f", "t2")).toBe(false);
    const p = l.acquire("f", "t2", 1000);
    l.release("t1");
    expect(await p).toEqual({ kind: "granted" });
    expect(l.holder("f")).toBe("t2");
  });
  it("times out a waiter", async () => {
    const l = new LeaseManager();
    l.tryAcquire("f", "t1");
    expect(await l.acquire("f", "t2", 5)).toEqual({ kind: "timeout" });
  });
  it("detects an AB-BA cycle and names the younger task as victim", async () => {
    const l = new LeaseManager();
    l.tryAcquire("a", "t1");
    l.tryAcquire("b", "t2");
    void l.acquire("b", "t1", 1000);
    expect(await l.acquire("a", "t2", 1000)).toEqual({ kind: "cycle", victim: "t2" });
    l.releaseAll();
  });
});
