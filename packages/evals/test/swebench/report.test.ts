import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRow, formatTable, predictions, summarize, writeResults } from "../../src/swebench/report.js";
import { result } from "./helpers.js";

const three = [
  result(),
  result({ id: "sympy__sympy-2", repo: "sympy/sympy", status: "unresolved", reason: "1 FAIL_TO_PASS and 0 PASS_TO_PASS tests failed", f2p: { passed: 0, total: 1 }, failed: ["test_x"], costUsd: 0.2 }),
  result({ id: "django__django-3", status: "error", reason: "Patch Apply Failed", costUsd: 0 }),
];

describe("swebench report", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("summarizes resolved, unresolved and errors separately, per repo", () => {
    expect(summarize(three)).toEqual({
      resolved: 1,
      unresolved: 1,
      errors: 1,
      total: 3,
      rate: 33.3,
      byRepo: { "django/django": { resolved: 1, total: 2 }, "sympy/sympy": { resolved: 0, total: 1 } },
      costUsd: 0.3235,
    });
    expect(summarize([]).rate).toBe(0);
  });

  it("formats one row per instance with tallies and the run status", () => {
    const row = formatRow(result({ turn: { runId: "r", status: "done", reply: "", costUsd: 0, durationMs: 1, escalations: [] } }));
    expect(row).toMatch(/^RESOLVED\s+django__django-1\s+f2p 1\/1\s+p2p 7\/7\s+run done\s+12s {2}all FAIL_TO_PASS/);
    expect(formatRow(result())).toContain("run -");
  });

  it("the table ends with the per-instance-backed totals line", () => {
    const lines = formatTable("lbl", three).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("lbl: resolved 1/3 (33.3%), unresolved 1, harness errors 1 — django/django 1/2, sympy/sympy 0/1; cost $0.3235");
  });

  it("predictions use the SWE-bench prediction format", () => {
    const lines = predictions("lbl", three).trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ instance_id: "django__django-1", model_name_or_path: "lbl", model_patch: "diff --git a/f b/f\n" });
  });

  it("writes the results file without patches and the predictions file with them", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "swe-res-")), "results");
    dirs.push(dir);
    const meta = { label: "lbl", startedAt: "2026-11-16T10:00:00.000Z", commit: "abc1234", config: "/cfg", dataset: "/d.jsonl", patchSource: "lead" as const };
    const file = await writeResults(dir, meta, three);
    expect(file).toBe(join(dir, "2026-11-16-swebench-lbl.json"));
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.summary.resolved).toBe(1);
    expect(parsed.instances).toHaveLength(3);
    expect(parsed.instances[0]).not.toHaveProperty("patch");
    expect(parsed.instances[1].failed).toEqual(["test_x"]);
    expect(parsed.patchSource).toBe("lead");
    const preds = await readFile(join(dir, "2026-11-16-swebench-lbl.predictions.jsonl"), "utf8");
    expect(preds.split("\n").filter(Boolean)).toHaveLength(3);
  });
});
