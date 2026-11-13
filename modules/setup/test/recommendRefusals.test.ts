import { describe, expect, it } from "vitest";
import { asStr, hardRefusal, modelRefusal, roleRefusal } from "../src/recommendRefusals.js";
import type { Candidate } from "../src/api.js";

describe("asStr", () => {
  it("passes strings through and blanks everything else", () => {
    expect(asStr("planner")).toBe("planner");
    expect(asStr(3)).toBe("");
    expect(asStr(undefined)).toBe("");
  });
});

describe("roleRefusal", () => {
  it("accepts a known role and refuses an unknown or empty one", () => {
    const roles = new Set(["planner"]);
    expect(roleRefusal("planner", roles)).toBeUndefined();
    expect(roleRefusal("nope", roles)).toBe("nope: unknown role");
    expect(roleRefusal("", roles)).toBe("?: unknown role");
  });
});

describe("modelRefusal", () => {
  const byId = new Map([["c1", { models: ["m1"] }]]);
  it("accepts a discovered channel:model", () => {
    expect(modelRefusal("planner", "c1", "m1", byId)).toBeUndefined();
  });
  it("refuses an unknown channel or an undiscovered model", () => {
    expect(modelRefusal("planner", "c9", "m1", byId)).toBe("planner: unknown channel 'c9'");
    expect(modelRefusal("planner", "c1", "m9", byId)).toBe("planner: unknown model 'm9' on c1");
  });
});

describe("hardRefusal", () => {
  const qualified = { agent: { passed: true, at: 1, version: 1 } };
  const weak: Candidate = { channel: "c1", channelType: "ollama", model: "tiny", caps: { tools: "none", qualified } };
  const cand = new Map([["c1:tiny", weak]]);
  it("passes a qualified candidate meeting requirements; refuses one never probed", () => {
    expect(hardRefusal("planner", { channel: "c1", model: "other" }, cand)).toBe("planner: c1:other was not probed");
    const ok = new Map([["c1:tiny", { ...weak, caps: { tools: "native" as const, qualified } }]]);
    expect(hardRefusal("planner", { channel: "c1", model: "tiny" }, ok)).toBeUndefined();
  });
  it("refuses a candidate that fails hard requirements, naming why", () => {
    expect(hardRefusal("planner", { channel: "c1", model: "tiny" }, cand)).toBe("planner: c1:tiny fails hard requirements (no tool support)");
  });
  it("applies the role's kind and needs: unqualified, vision, small window", () => {
    const plain = new Map([["c1:m", { channel: "c1", channelType: "ollama", model: "m", caps: { tools: "native" as const } } as Candidate]]);
    expect(hardRefusal("x", { channel: "c1", model: "m" }, plain)).toContain("not qualified as agent");
    const q = new Map([["c1:m", { channel: "c1", channelType: "ollama", model: "m", caps: { tools: "native" as const, qualified, contextTokens: 8000 } } as Candidate]]);
    expect(hardRefusal("x", { channel: "c1", model: "m" }, q)).toContain("context 8000 < 32000");
    expect(hardRefusal("x", { channel: "c1", model: "m" }, q, { needs: { minContext: 4000, vision: true } })).toContain("no vision");
    expect(hardRefusal("x", { channel: "c1", model: "m" }, q, { kind: "function" })).toContain("not qualified as function");
  });
});
