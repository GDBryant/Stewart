import { describe, expect, it } from "vitest";
import type { RoleDef } from "@stewart/config";
import { resolveActiveLead } from "../src/activeLead.js";

const role = (id: string, over: Partial<RoleDef> = {}): RoleDef =>
  ({ id, enabled: true, kind: "agent", skills: [], tools: [], writePaths: [], turnBudget: 25, distinctFrom: [], ...over }) as RoleDef;

describe("resolveActiveLead", () => {
  it("an enabled agent-kind lead row wins", () => {
    const r = resolveActiveLead([role("lead"), role("planner")]);
    expect(r?.role.id).toBe("lead");
    expect(r?.fallback).toBe(false);
  });

  it("lead disabled: the first enabled agent-kind row after it leads", () => {
    const r = resolveActiveLead([role("lead", { enabled: false }), role("planner"), role("builder")]);
    expect(r?.role.id).toBe("planner");
    expect(r?.reason).toBe("lead-disabled");
  });

  it("lead disabled with nothing after it: the first enabled agent-kind row overall leads", () => {
    const r = resolveActiveLead([role("planner"), role("lead", { enabled: false })]);
    expect(r?.role.id).toBe("planner");
  });

  it("lead deleted: the first enabled agent-kind row leads", () => {
    const r = resolveActiveLead([role("planner"), role("builder")]);
    expect(r?.role.id).toBe("planner");
    expect(r?.reason).toBe("lead-deleted");
  });

  it("a function-kind lead row never leads; the next enabled agent-kind row does", () => {
    const r = resolveActiveLead([role("lead", { kind: "function" }), role("planner")]);
    expect(r?.role.id).toBe("planner");
    expect(r?.reason).toBe("lead-not-agent");
  });

  it("function-kind roles are never lead candidates", () => {
    const r = resolveActiveLead([role("util", { kind: "function" })]);
    expect(r).toBeUndefined();
  });

  it("no enabled agent-kind role: no active lead", () => {
    expect(resolveActiveLead([])).toBeUndefined();
    expect(resolveActiveLead([role("lead", { enabled: false })])).toBeUndefined();
    expect(resolveActiveLead([role("lead"), role("p", { enabled: false })]).role.id).toBe("lead");
  });

  it("a disabled lead with only function-kind rows after it falls to the first agent-kind row overall", () => {
    const r = resolveActiveLead([role("lead", { enabled: false }), role("util", { kind: "function" }), role("planner")]);
    expect(r?.role.id).toBe("planner");
  });
});
