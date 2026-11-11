import { describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "../src/api.js";

const roles = (body: string) => `version: 1\nitems:\n${body}`;

describe("loadEffectiveConfig", () => {
  it("adds role-validation errors from the merged layers to the base errors", () => {
    const cfg = loadEffectiveConfig({ "roles.yaml": roles("  - id: general-worker\n    enabled: true\n    agent: nope\n") }, undefined, {}, { trusted: true });
    expect(cfg.errors).toContain("role general-worker: unknown agent 'nope'");
    expect(cfg.errors).toContain("orchestrator: required when another role is enabled");
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
});
