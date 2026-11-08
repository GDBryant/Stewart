import { describe, expect, it } from "vitest";
import { EventBus } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import { runHandle } from "../src/handle.js";

const collect = (iter: AsyncIterable<RunEvent>, n: number) => {
  const out: RunEvent[] = [];
  return (async () => {
    for await (const ev of iter) {
      out.push(ev);
      if (out.length >= n) break;
    }
    return out;
  })();
};

describe("runHandle", () => {
  it("buffers events before iteration, filters by runId and ends on run.finished", async () => {
    const bus = new EventBus(() => {}, 0);
    const h = runHandle(bus, "r1");
    bus.emit({ kind: "run.started", runId: "r1", title: "t" });
    bus.emit({ kind: "task.created", runId: "other", taskId: "x", roleId: "r" });
    bus.emit({ kind: "run.finished", runId: "r1", status: "done" });
    const got = await collect(h.events, 10);
    expect(got.map((e) => e.kind)).toEqual(["run.started", "run.finished"]);
  });

  it("streams events emitted after iteration starts and ends on run.reverted", async () => {
    const bus = new EventBus(() => {}, 0);
    const h = runHandle(bus, "r1");
    const done = collect(h.events, 2);
    bus.emit({ kind: "task.created", runId: "r1", taskId: "t1", roleId: "r" });
    bus.emit({ kind: "run.reverted", runId: "r1", filesRestored: ["a.ts"] });
    const got = await done;
    expect(got.map((e) => e.kind)).toEqual(["task.created", "run.reverted"]);
  });
});
