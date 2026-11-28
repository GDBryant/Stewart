import { describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "../src/api.js";

const roles = (body: string) => `version: 1\nitems:\n${body}`;

describe("loadEffectiveConfig", () => {
  it("adds role-validation errors from the merged layers to the base errors", () => {
    const cfg = loadEffectiveConfig({ "roles.yaml": roles("  - id: general-worker\n    enabled: true\n    agent: nope\n") }, undefined, {}, { trusted: true });
    expect(cfg.errors).toContain("role general-worker: unknown agent 'nope'");
  });

  it("resolves skills next to the base config and returns the base fields", () => {
    const cfg = loadEffectiveConfig({}, undefined, {}, { trusted: true });
    expect(Array.isArray(cfg.skills)).toBe(true);
    expect(cfg.roles).toBeDefined();
    expect(cfg.settings).toBeDefined();
  });

  it("reports no role errors for an empty config", () => {
    expect(loadEffectiveConfig({}, undefined, {}, { trusted: true }).errors).toEqual([]);
  });

  it("ignores project roles in an untrusted workspace and says so", () => {
    const cfg = loadEffectiveConfig({}, { "roles.yaml": roles("  - id: general-worker\n    enabled: true\n    agent: nope\n") }, {}, { trusted: false });
    expect(cfg.errors.some((e) => e.includes("untrusted workspace"))).toBe(true);
    expect(cfg.errors).not.toContain("role general-worker: unknown agent 'nope'");
  });

  const small = {
    "agents.yaml": "version: 1\nitems:\n  - id: small\n    channel: c\n    model: s\n",
    "channels.yaml": "version: 1\nitems:\n  - id: c\n    type: ollama\n    modelCaps:\n      s:\n        qualified:\n          agent: { passed: true, at: 1, version: 2, context: 32000 }\n",
  };

  it("adds the small-window warning and heavyAgent errors to errors", () => {
    const user = { ...small, "roles.yaml": roles("  - id: lead\n    enabled: true\n    agent: small\n    heavyAgent: ghost\n") };
    const cfg = loadEffectiveConfig(user, undefined, {}, { trusted: true });
    expect(cfg.errors.some((e) => e.startsWith("warning: role lead: agent 'small' has a 32000-token window"))).toBe(true);
    expect(cfg.errors).toContain("role lead: unknown heavyAgent 'ghost'");
  });

  it("no warning once runTurnLimit is within 40", () => {
    const user = { ...small, "roles.yaml": roles("  - id: lead\n    enabled: true\n    agent: small\n"), "settings.yaml": "version: 1\nrunTurnLimit: 30\n" };
    expect(loadEffectiveConfig(user, undefined, {}, { trusted: true }).errors.filter((e) => e.startsWith("warning:"))).toEqual([]);
  });

  const distinct = (roleBody: string) => ({
    ...small,
    "agents.yaml": "version: 1\nitems:\n  - id: small\n    channel: c\n    model: s\n  - id: small2\n    channel: c\n    model: s\n  - id: other\n    channel: c\n    model: o\n",
    "channels.yaml": "version: 1\nitems:\n  - id: c\n    type: ollama\n    modelCaps:\n      s:\n        qualified:\n          agent: { passed: true, at: 1, version: 2, context: 32000 }\n      o:\n        qualified:\n          agent: { passed: true, at: 1, version: 2, context: 32000 }\n",
    "roles.yaml": roles(`  - id: planner\n    enabled: true\n    agent: small\n${roleBody}`),
  });

  it("warns in effective config when a distinctFrom role shares the planner's model", () => {
    const cfg = loadEffectiveConfig(distinct("  - id: interrogator\n    enabled: true\n    agent: small\n    distinctFrom: [planner]\n"), undefined, {}, { trusted: true });
    expect(cfg.errors).toContain("warning: role interrogator: shares model c/s with planner (distinctFrom); independent review is weakened — bind a different model");
  });

  it("does not warn in effective config when the distinctFrom role uses another model", () => {
    const cfg = loadEffectiveConfig(distinct("  - id: interrogator\n    enabled: true\n    agent: other\n    distinctFrom: [planner]\n"), undefined, {}, { trusted: true });
    expect(cfg.errors.filter((e) => e.startsWith("warning: role interrogator"))).toEqual([]);
  });

  it("does not warn in effective config for a disabled distinctFrom role", () => {
    const cfg = loadEffectiveConfig(distinct("  - id: interrogator\n    enabled: false\n    agent: small\n    distinctFrom: [planner]\n"), undefined, {}, { trusted: true });
    expect(cfg.errors.filter((e) => e.startsWith("warning: role interrogator"))).toEqual([]);
  });
});
