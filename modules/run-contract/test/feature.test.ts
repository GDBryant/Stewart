import { describe, expect, it } from "vitest";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { orchestratorDefaultToolNames, requiredRoleTools, runPreflight, terminalToolNames, type FeatureRuntime, type RunFeature } from "../src/api.js";

const rt = { runId: "r1", host: {} as never, config: {} as EffectiveConfig } satisfies FeatureRuntime;
const feat = (over: Partial<RunFeature> = {}): RunFeature => ({ id: "f", createRun: () => ({ orchestratorTools: () => [], taskTools: () => [] }), ...over });

describe("feature helpers", () => {
  it("terminalToolNames and orchestratorDefaultToolNames flatten across features", () => {
    const fs = [feat({ terminalTools: ["a"], orchestratorDefaultTools: ["x"] }), feat({ terminalTools: ["b", "c"] })];
    expect(terminalToolNames(fs)).toEqual(["a", "b", "c"]);
    expect(orchestratorDefaultToolNames(fs)).toEqual(["x"]);
  });

  it("returns empty results for no features or undefined", () => {
    for (const fs of [undefined, []]) {
      expect(terminalToolNames(fs)).toEqual([]);
      expect(orchestratorDefaultToolNames(fs)).toEqual([]);
      expect(requiredRoleTools(fs)).toEqual({});
      expect(runPreflight(fs, "hi", rt)).toBeUndefined();
    }
  });

  it("requiredRoleTools unions per role without duplicates", () => {
    const fs = [feat({ requiredRoleTools: { orchestrator: ["A", "B"] } }), feat({ requiredRoleTools: { orchestrator: ["B", "C"], other: ["Z"] } })];
    expect(requiredRoleTools(fs)).toEqual({ orchestrator: ["A", "B", "C"], other: ["Z"] });
  });

  it("runPreflight returns the first refusal and skips features that allow the run", () => {
    const ok = feat({ preflight: () => undefined });
    const no1 = feat({ preflight: (t) => (t.includes("health") ? "reviewer missing" : undefined) });
    const no2 = feat({ preflight: () => "second" });
    expect(runPreflight([ok, no1, no2], "run a health check", rt)).toBe("reviewer missing");
    expect(runPreflight([ok, no1], "something else", rt)).toBeUndefined();
    expect(runPreflight([feat()], "x", rt)).toBeUndefined();
  });
});
