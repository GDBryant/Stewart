import { describe, expect, it } from "vitest";
import { HealthTracker } from "../src/healthJobs.js";
import type { ChildDeps, ChildJob } from "../src/childTypes.js";

const job = (taskId: string, scope?: string[], report: "text" | "health" = "health"): ChildJob => ({ role: { id: "reviewer" } as ChildJob["role"], taskId, task: `t-${taskId}`, report, scope });
const deps = { runId: "r1", host: { files: { read: async () => ({ content: "x" }), writeAtomic: async () => {} } } } as unknown as ChildDeps;
const res = (status: "done" | "failed", error?: string) => ({ status, reply: "", error }) as never;

describe("HealthTracker", () => {
  it("has no verdict without health jobs and ignores text jobs", () => {
    const h = new HealthTracker(deps);
    h.start(job("a", undefined, "text"));
    expect(h.healthVerdict()).toBeUndefined();
  });

  it("is partial while a scope is unchecked and clears once it is rechecked", () => {
    const h = new HealthTracker(deps);
    h.start(job("a", ["src/a.ts"]));
    h.start(job("b", ["src/a.ts"]));
    h.mark(job("a", ["src/a.ts"]), res("failed", "bad"));
    expect(h.healthVerdict()).toContain("0/1 scopes checked");
    h.mark(job("b", ["src/a.ts"]), res("done"));
    expect(h.healthVerdict()).toBeUndefined();
  });

  it("a failed scope-less checks task keeps coverage partial", () => {
    const h = new HealthTracker(deps);
    h.start(job("c"));
    h.fail(job("c"), "crash");
    expect(h.healthVerdict()).toContain("1 delegated task(s) failed");
  });

  it("report rejects when nothing ran, and keep ignores replies without a json block or with bad json", async () => {
    const h = new HealthTracker(deps);
    await expect(h.report()).rejects.toThrow("no health reports");
    h.keep("a", "no block");
    h.keep("a", "```json\n{bad\n```");
    await expect(h.report()).rejects.toThrow("no health reports");
  });
});
