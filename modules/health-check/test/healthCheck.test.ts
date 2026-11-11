import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { FeatureRuntime } from "@stewart/run-contract";
import type { Tool } from "@stewart/tools";
import { HEALTH_REPORT, HEALTH_REVIEWER_ROLE, SUBMIT_HEALTH, healthCheckFeature } from "../src/api.js";

const cfg = (reviewerEnabled: boolean) => ({ roles: [{ id: HEALTH_REVIEWER_ROLE, enabled: reviewerEnabled }] }) as unknown as EffectiveConfig;

function setup(files: Record<string, string> = {}, tasks: { id: string; roleId: string; title: string }[] = [], maxOutputChars = 20_000) {
  const fake = fakeHost(files);
  const rt: FeatureRuntime = { runId: "r1", host: fake.host, config: cfg(true) };
  const run = healthCheckFeature.createRun(rt, { tasks: () => tasks, maxOutputChars });
  return { run, files: fake.files };
}
const byName = (tools: Tool[], name: string) => tools.find((t) => t.spec.name === name)!;
const call = (t: Tool, args: unknown) => Promise.resolve(t.execute(args as never, undefined as never, new AbortController().signal));
const report = (path: string, loc: number, score: number, band = "Green") => ({ files: [{ path, loc, score, band }], findings: [], notChecked: [] });

describe("healthCheckFeature definition", () => {
  it("declares the terminal verb, orchestrator default tool and required role tools", () => {
    expect(healthCheckFeature.terminalTools).toEqual([SUBMIT_HEALTH]);
    expect(healthCheckFeature.orchestratorDefaultTools).toEqual([HEALTH_REPORT]);
    expect(healthCheckFeature.requiredRoleTools?.orchestrator).toEqual(["ListCodeFiles", HEALTH_REPORT]);
    expect(healthCheckFeature.requiredRoleTools?.[HEALTH_REVIEWER_ROLE]).toEqual(["ListCodeFiles", SUBMIT_HEALTH, "CodeMetrics", "RunTerminal"]);
  });

  it("preflight refuses a health request without an enabled reviewer, allows it with one, ignores other requests", () => {
    const pre = healthCheckFeature.preflight!;
    const host = { files: fakeHost().host.files };
    expect(pre("check the health of this project", { runId: "r", host, config: cfg(false) })).toContain("is not enabled");
    expect(pre("check the health of this project", { runId: "r", host, config: cfg(true) })).toBeUndefined();
    expect(pre("rename a variable", { runId: "r", host, config: cfg(false) })).toBeUndefined();
  });
});

describe("HealthRun tools", () => {
  it("scopes the verbs: orchestrator gets health_report (live) + submit_health stub, tasks the reverse", async () => {
    const { run } = setup();
    const orch = run.orchestratorTools();
    const task = run.taskTools("t1");
    expect(orch.map((t) => t.spec.name).sort()).toEqual([HEALTH_REPORT, SUBMIT_HEALTH]);
    expect(task.map((t) => t.spec.name).sort()).toEqual([HEALTH_REPORT, SUBMIT_HEALTH]);
    expect(await call(byName(orch, SUBMIT_HEALTH), report("a.ts", 10, 9))).toContain("submitted by dispatched reviewer tasks");
    expect(await call(byName(task, HEALTH_REPORT), {})).toContain("aggregated by the Orchestrator");
  });

  it("submit_health summarises files, worst file and checks; checks-only reports count the checks", async () => {
    const { run } = setup();
    const submit = byName(run.taskTools("t1"), SUBMIT_HEALTH);
    expect(await call(submit, { files: [{ path: "a.ts", loc: 10, score: 9, band: "Green" }, { path: "b.ts", loc: 10, score: 4, band: "Red" }] })).toBe(
      "Health report recorded: 2 files, mean 6.5/10, worst b.ts 4/10",
    );
    const checks = [{ name: "unit", command: "npm test", status: "pass", detail: "ok" }];
    expect(await call(submit, { files: [], checks })).toBe("Project checks recorded: 1");
    expect(await call(submit, { files: [{ path: "c.ts", loc: 10, score: 8, band: "Green" }], checks })).toContain(", checks 1");
  });

  it("health_report says so when nothing was recorded", async () => {
    const { run } = setup();
    expect(await call(byName(run.orchestratorTools(), HEALTH_REPORT), {})).toBe("No health reports recorded.");
  });

  it("health_report merges reports, lists reviewer tasks that never reported, and writes the scratch file", async () => {
    const { run, files } = setup({ "a.ts": "function f() {\n  if (x) return 1\n}" }, [
      { id: "t1", roleId: HEALTH_REVIEWER_ROLE, title: "batch-a" },
      { id: "t2", roleId: HEALTH_REVIEWER_ROLE, title: "batch-b (never reported)" },
      { id: "t3", roleId: "investigator", title: "not a reviewer" },
    ]);
    await call(byName(run.taskTools("t1"), SUBMIT_HEALTH), report("a.ts", 3, 9));
    const out = (await call(byName(run.orchestratorTools(), HEALTH_REPORT), { mode: "score" })) as string;
    expect(out).toContain("Overall: 9/10");
    expect(out).toContain("batch-b (never reported)");
    expect(out).not.toContain("not a reviewer");
    expect(out).toContain("Measured (lexical scan");
    expect(files[".stewart/scratch/health/r1.md"]).toBe(out);
  });

  it("health_report omits the Measured line when no reported file is readable", async () => {
    const { run } = setup({});
    await call(byName(run.taskTools("t1"), SUBMIT_HEALTH), report("missing.ts", 5, 9, "Yellow"));
    const out = (await call(byName(run.orchestratorTools(), HEALTH_REPORT), {})) as string;
    expect(out).not.toContain("Measured (lexical scan");
  });

  it("health_report truncates to the orchestrator output cap and points at the scratch file", async () => {
    const { run, files } = setup({}, [], 120);
    await call(byName(run.taskTools("t1"), SUBMIT_HEALTH), { files: [{ path: "a.ts", loc: 5, score: 9, band: "Green" }], findings: Array.from({ length: 20 }, (_, i) => ({ path: "a.ts", line: i, smell: `long-smell-${i}`, severity: "low", refactor: "split it up" })), notChecked: [] });
    const out = (await call(byName(run.orchestratorTools(), HEALTH_REPORT), {})) as string;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("truncated, see .stewart/scratch/health/r1.md");
    expect(files[".stewart/scratch/health/r1.md"].length).toBeGreaterThan(120);
  });

  it("keeps reports per run: a second run starts empty", async () => {
    const a = setup();
    const b = setup();
    await call(byName(a.run.taskTools("t1"), SUBMIT_HEALTH), report("a.ts", 5, 9));
    expect(await call(byName(b.run.orchestratorTools(), HEALTH_REPORT), {})).toBe("No health reports recorded.");
  });
});
