import { describe, expect, it } from "vitest";
import type { RunRuntime, TaskResult } from "@stewart/run-contract";
import { outcomeOf } from "../src/outcome.js";
import type { Run } from "../src/types.js";

const run = (status: Run["status"] = "running"): Run => ({ id: "r1", projectId: "p", status, controller: new AbortController(), startedAt: 0, messages: [], costUsd: 0 });
const rt = (hit = false): RunRuntime => ({ timeCap: { hit, ms: 120_000 } }) as unknown as RunRuntime;
const res = (status: string, summary = "why") => ({ status, summary }) as unknown as TaskResult;

describe("outcomeOf", () => {
  it("maps a cancelled task to cancelled when no time cap fired", () => {
    expect(outcomeOf(run(), rt(false), res("cancelled"))).toEqual({ status: "cancelled", event: "cancelled" });
  });

  it("maps a cancelled run status to cancelled even when the task reports done", () => {
    expect(outcomeOf(run("cancelled"), rt(false), res("done"))).toEqual({ status: "cancelled", event: "cancelled" });
  });

  it("maps a cancellation caused by the time cap to interrupted with the cap message", () => {
    expect(outcomeOf(run(), rt(true), res("cancelled"))).toEqual({ status: "interrupted", event: "stopped", error: "run time limit reached (2min)" });
  });

  it("maps a failed task to failed carrying its summary", () => {
    expect(outcomeOf(run(), rt(), res("failed", "boom"))).toEqual({ status: "failed", event: "failed", error: "boom" });
  });

  it("maps stopped and parked tasks to interrupted carrying the summary", () => {
    expect(outcomeOf(run(), rt(), res("stopped", "turn limit"))).toEqual({ status: "interrupted", event: "stopped", error: "turn limit" });
    expect(outcomeOf(run(), rt(), res("parked", "waiting"))).toEqual({ status: "interrupted", event: "stopped", error: "waiting" });
  });

  it("negative: an unrelated status such as done is not reported as failed or interrupted", () => {
    expect(outcomeOf(run(), rt(), res("done"))).toEqual({ status: "done", event: "done" });
    expect(outcomeOf(run(), rt(), res("done")).error).toBeUndefined();
  });
});
