import { describe, expect, it } from "vitest";
import { meetsHardRequirements, modelSizeB, scoreAssignments, type Candidate } from "../src/api.js";

import { fakeFetcher, fakeHost } from "@stewart/kernel";

const c = (model: string, caps: Candidate["caps"] = {}, channelType = "ollama", channel = "c1"): Candidate => ({ channel, channelType, model, caps });
const pick = (role: string, cs: Candidate[]) => scoreAssignments([role], cs).assignments[0];

describe("modelSizeB", () => {
  it("parses sizes from names", () => {
    expect(modelSizeB("gemma4:e4b")).toBe(4);
    expect(modelSizeB("llama3.1:8b")).toBe(8);
    expect(modelSizeB("qwen3:30b-a3b")).toBe(30);
    expect(modelSizeB("gpt-4o")).toBeUndefined();
    expect(modelSizeB("bubble")).toBeUndefined();
  });
});

describe("scoreAssignments", () => {
  it("prefers the larger reasoning model for the orchestrator", () => {
    const a = pick("orchestrator", [c("gemma4:e4b"), c("qwen3:32b", { reasoning: true, tools: "native" })]);
    expect(a.model).toBe("qwen3:32b");
    expect(a.reason).toContain("reasoning");
  });

  it("warns instead of hiding a small orchestrator model", () => {
    const a = pick("orchestrator", [c("gemma4:e4b")]);
    expect(a.model).toBe("gemma4:e4b");
    expect(a.warnings.join()).toMatch(/8B\+ recommended/);
  });

  it("requires vision for image-reader and imageGen for image-writer; leaves them unfilled otherwise", () => {
    const cs = [c("a:8b"), c("v:8b", { vision: true })];
    const r = scoreAssignments(["image-reader", "image-writer"], cs);
    expect(r.assignments.map((x) => `${x.role}:${x.model}`)).toEqual(["image-reader:v:8b"]);
    expect(r.unfilled).toEqual([{ role: "image-writer", reason: "no model with: image generation" }]);
  });

  it("excludes models without tool support from tool roles", () => {
    expect(scoreAssignments(["code-writer"], [c("x:30b", { tools: "none" })]).unfilled[0].role).toBe("code-writer");
    expect(meetsHardRequirements("code-writer", c("x", { tools: "none" }))).toBe(false);
    expect(meetsHardRequirements("code-writer", c("x"))).toBe(true);
  });

  it("reports no models available", () => {
    expect(scoreAssignments(["tester"], []).unfilled).toEqual([{ role: "tester", reason: "no models available" }]);
  });

  it("uses a single model for every role when only one exists", () => {
    const r = scoreAssignments(["orchestrator", "tester", "document-writer"], [c("only:14b")]);
    expect(new Set(r.assignments.map((x) => x.model))).toEqual(new Set(["only:14b"]));
    expect(r.assignments).toHaveLength(3);
  });

  it("spreads load to a near-equal second model", () => {
    const roles = ["general-worker", "tester", "code-writer", "investigator"];
    const r = scoreAssignments(roles, [c("a:14b"), c("b:14b")]);
    expect(new Set(r.assignments.map((x) => x.model)).size).toBe(2);
  });

  it("prefers coding models for code-writer and smaller models for document-writer", () => {
    expect(pick("code-writer", [c("llama3:70b"), c("qwen2.5-coder:32b")]).model).toBe("qwen2.5-coder:32b");
    expect(pick("document-writer", [c("big:70b"), c("small:7b")]).model).toBe("small:7b");
  });

  it("treats hosted models with no size as large and penalises small context", () => {
    const hosted = pick("planner", [c("gpt-x", { tools: "native" }, "openai-compatible")]);
    expect(hosted.warnings).toEqual([]);
    expect(pick("planner", [c("m:16b", { contextTokens: 2048 })]).warnings.join()).toContain("context 2048");
  });
});

describe("perf and cost scoring", () => {
  const perf = (p: Partial<import("../src/channels/types.js").ModelPerf>) => ({ benchedAt: 1, benchVersion: 1, ...p });

  it("hard-filters on measured edit and tool reliability, warns when unknown", () => {
    const badEdit = c("a:30b", { tools: "native", perf: perf({ editOk: false, toolReliability: 1 }) });
    expect(scoreAssignments(["code-writer"], [badEdit]).unfilled[0].reason).toContain("edit bench");
    const flaky = c("b:30b", { tools: "native", perf: perf({ editOk: true, toolReliability: 0.5 }) });
    expect(scoreAssignments(["code-writer"], [flaky]).unfilled[0].reason).toContain("tool reliability");
    const unknown = c("c:30b", { tools: "native" });
    const r = scoreAssignments(["code-writer"], [unknown]);
    expect(r.unfilled).toEqual([]);
    expect(r.assignments[0].warnings.join(" ")).toContain("not measured");
  });

  it("rewards measured speed and reliability in the reason text", () => {
    const fast = c("a:30b", { tools: "native", perf: perf({ tokPerSec: 80, toolReliability: 1, editOk: true }) });
    const r = scoreAssignments(["code-writer"], [fast]);
    expect(r.assignments[0].reason).toContain("80 tok/s");
    expect(r.assignments[0].reason).toContain("tool 3/3");
    expect(r.assignments[0].reason).toContain("edit ok");
  });

  it("weighs interactive roles toward faster models", () => {
    const slowBig = c("big:70b", { tools: "native", reasoning: true, perf: perf({ tokPerSec: 5 }) }, "openai-compatible", "c2");
    const fastSmall = c("small:8b", { tools: "native", perf: perf({ tokPerSec: 90 }) });
    expect(pick("investigator", [slowBig, fastSmall]).model).toBe("small:8b");
  });

  it("penalises cost by sensitivity and reorders on priorities", () => {
    const pricey = { ...c("p:70b", { tools: "native", reasoning: true }, "openai-compatible", "c2"), costTier: "high" as const, costBlended: 20 };
    const free = { ...c("f:8b", { tools: "native" }), costTier: "free" as const, costBlended: 0 };
    expect(pick("investigator", [pricey, free]).model).toBe("f:8b");
    const strong = { ...c("p", { tools: "native", reasoning: true }, "openai-compatible", "c2"), costTier: "high" as const, costBlended: 20 };
    const local = { ...c("f:30b", { tools: "native" }), costTier: "free" as const, costBlended: 0 };
    const costLow = scoreAssignments(["orchestrator"], [strong, local], { priorities: { speed: 2, cost: 1, quality: 2 } });
    const costHigh = scoreAssignments(["orchestrator"], [strong, local], { priorities: { speed: 2, cost: 3, quality: 2 } });
    expect(costLow.assignments[0].model).toBe("p");
    expect(costHigh.assignments[0].model).toBe("f:30b");
  });

  it("warns when a local model likely exceeds memory", () => {
    const huge = c("huge:110b", { tools: "native" });
    const r = scoreAssignments(["tester"], [huge], { hardware: { os: "linux", ramGb: 16 } });
    expect(r.assignments[0].warnings.join(" ")).toContain("GB available");
  });
});

describe("code-health-reviewer assignment", () => {
  it("assigns to a tool-capable model", () => {
    expect(scoreAssignments(["code-health-reviewer"], [c("m:30b", { tools: "native" })]).unfilled).toEqual([]);
  });
  it("is unfilled with no models or no tool support", () => {
    expect(scoreAssignments(["code-health-reviewer"], []).unfilled[0].reason).toBe("no models available");
    expect(scoreAssignments(["code-health-reviewer"], [c("m:30b", { tools: "none" })]).unfilled[0].role).toBe("code-health-reviewer");
  });
});
