import { describe, expect, it } from "vitest";
import { agentServesRole, matchGlob, roleTurnBudget, validateRoles } from "../src/api.js";
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

  it("flags an enabled role with no agent bound", () => {
    expect(validateRoles([role({ id: "general-worker" })], [agent()], [channel()])).toContain(
      "role general-worker: enabled but no agent bound",
    );
  });

  it("flags an unknown agent and fallback agent", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "nope", fallbackAgent: "gone" })], [agent()], [channel()]);
    expect(errs).toContain("role general-worker: unknown agent 'nope'");
    expect(errs).toContain("role general-worker: unknown fallbackAgent 'gone'");
  });

  it("requires the orchestrator once another role is enabled", () => {
    const errs = validateRoles([role({ id: "general-worker", agent: "a1" })], [agent()], [channel()]);
    expect(errs).toContain("orchestrator: required when another role is enabled");
    const ok = validateRoles([role({ id: "orchestrator", agent: "a1" }), role({ id: "general-worker", agent: "a1" })], [agent()], [channel()]);
    expect(ok).toEqual([]);
  });

  it("enforces role capabilities on agent and fallback agent", () => {
    const chans = [channel({ v: { vision: true } })];
    const errs = validateRoles(
      [role({ id: "orchestrator", agent: "a1" }), role({ id: "image-reader", agent: "a1", fallbackAgent: "va" })],
      [agent(), visionAgent],
      chans,
    );
    expect(errs).toContain("role image-reader: agent 'a1' lacks vision");
    const ok = validateRoles(
      [role({ id: "orchestrator", agent: "a1" }), role({ id: "image-reader", agent: "va" })],
      [agent(), visionAgent],
      chans,
    );
    expect(ok).toEqual([]);
    expect(agentServesRole(visionAgent, chans, "image-writer")).toBe(false);
  });

  it("disabled roles produce no errors", () => {
    expect(validateRoles([role({ id: "code-writer", enabled: false })], [], [])).toEqual([]);
  });
});

describe("roleTurnBudget", () => {
  it("maps numbers and unlimited", () => {
    expect(roleTurnBudget(role({ turnBudget: 7 }))).toBe(7);
    expect(roleTurnBudget(role({ turnBudget: "unlimited" }))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
