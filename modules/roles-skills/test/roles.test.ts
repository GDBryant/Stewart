import { describe, expect, it } from "vitest";
import { agentServesRole, matchGlob, validateRoles } from "../src/api.js";
import type { RoleDef } from "@stewart/config";

const role = (over: Partial<RoleDef> = {}): RoleDef => ({
  id: "r", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: 25, ...over,
});

describe("matchGlob", () => {
  it("matches ** across directories and * within a segment", () => {
    expect(matchGlob("docs/**", "docs/a/b/c.md")).toBe(true);
    expect(matchGlob("docs/**", "src/a.md")).toBe(false);
    expect(matchGlob("*.md", "README.md")).toBe(true);
    expect(matchGlob("*.md", "docs/README.md")).toBe(false);
    expect(matchGlob("CHANGELOG*", "CHANGELOG.md")).toBe(true);
    expect(matchGlob("assets/*.svg", "assets/x.svg")).toBe(true);
    expect(matchGlob("assets/*.svg", "assets/a/b.svg")).toBe(false);
  });
});

describe("validateRoles", () => {
  const agent = (over: Record<string, unknown> = {}) =>
    ({ id: "a1", channel: "c1", model: "m", effort: "medium", ...over }) as never;
  const channel = (caps: Record<string, Record<string, unknown>> = {}) =>
    ({ id: "c1", type: "ollama", enabled: true, discoverModels: true, extraModels: [], modelCaps: caps }) as never;
  const visionAgent = agent({ id: "va", model: "v" });

  it("accepts an enabled role with no agent bound (falls back to the lead's agent)", () => {
    expect(validateRoles([role({ id: "general-worker" })], [agent()], [channel()])).toEqual([]);
  });

  it("flags an unknown agent; old role ids validate without an orchestrator", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "nope" })], [agent()], [channel()]);
    expect(errs).toContain("role general-worker: unknown agent 'nope'");
    const ok = validateRoles([role({ id: "general-worker", agent: "a1" })], [agent()], [channel()]);
    expect(ok).toEqual([]);
  });

  it("enforces role capabilities on the bound agent", () => {
    const chans = [channel({ v: { vision: true } })];
    const errs = validateRoles([role({ id: "image-reader", agent: "a1" })], [agent(), visionAgent], chans);
    expect(errs).toContain("role image-reader: agent 'a1' lacks vision");
    const ok = validateRoles([role({ id: "image-reader", agent: "va" })], [agent(), visionAgent], chans);
    expect(ok).toEqual([]);
    expect(agentServesRole(visionAgent, chans, "image-writer")).toBe(false);
  });

  it("lead may be enabled with no agents configured", () => {
    expect(validateRoles([role({ id: "lead" })], [], [])).toEqual([]);
  });

  it("disabled roles produce no errors", () => {
    expect(validateRoles([role({ id: "code-writer", enabled: false })], [], [])).toEqual([]);
  });
});


