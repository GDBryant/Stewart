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
  const weak: Candidate = { channel: "c1", channelType: "ollama", model: "tiny", caps: { tools: "none" } };
  const cand = new Map([["c1:tiny", weak]]);
  it("passes an unknown candidate and a candidate meeting requirements", () => {
    expect(hardRefusal("planner", "c1", "other", cand)).toBeUndefined();
    const ok = new Map([["c1:tiny", { ...weak, caps: { tools: "native" as const } }]]);
    expect(hardRefusal("planner", "c1", "tiny", ok)).toBeUndefined();
  });
  it("refuses a candidate that fails hard requirements", () => {
    expect(hardRefusal("planner", "c1", "tiny", cand)).toBe("planner: c1:tiny fails hard requirements");
  });
});
