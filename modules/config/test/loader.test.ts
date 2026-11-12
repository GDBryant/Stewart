import { describe, expect, it } from "vitest";
import { SelfWriteGuard, hashContent, isProjectFile, loadConfig } from "../src/api.js";

const role = (id: string, turns = 10) => `version: 1\nitems:\n  - id: ${id}\n    enabled: true\n    skills: []\n    tools: []\n    writePaths: []\n    turnBudget: ${turns}\n`;

describe("loadConfig", () => {
  it("merges shipped < user < project roles by id, field by field", () => {
    const c = loadConfig({ "roles.yaml": role("r", 20) }, { "roles.yaml": role("r", 30) }, { "roles.yaml": role("r") }, { trusted: true });
    expect(c.errors).toEqual([]);
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0].turnBudget).toBe(30);
  });
  it("ignores the project layer in an untrusted workspace and says so", () => {
    const c = loadConfig({}, { "roles.yaml": role("r") }, {}, { trusted: false });
    expect(c.roles).toEqual([]);
    expect(c.errors.join()).toMatch(/untrusted/);
  });
  it("does not flag an untrusted workspace that carries no roles or skills", () => {
    const c = loadConfig({}, { "settings.yaml": "version: 1\n" }, {}, { trusted: false });
    expect(c.errors).toEqual([]);
  });
  it("reports schema errors per file and keeps going", () => {
    const c = loadConfig({ "roles.yaml": "version: 1\nitems: 5\n" }, undefined, {}, { trusted: true });
    expect(c.errors[0]).toMatch(/^roles.yaml:/);
  });
});

describe("old v2 yaml still parses", () => {
  it("settings with removed keys are stripped, not rejected", () => {
    const old = `version: 1
maxRunHours: 4
maxWorkerTurnsCeiling: 60
budgets: { quick: { turnMultiplier: 0.4 } }
planGate: true
compaction: { prune: true }
leaseWaitSeconds: 300
maxNestedDispatches: 3
maxReplans: 2
askOnTurnLimit: false
continueQuestionTimeoutMinutes: 5
maxRecoveryDepth: 2
maxRecoveriesPerRun: 4
maxSubTasks: 5
recoverySummaryChars: 500
maxActionsInRecoveryBrief: 20
maxContinuations: 2
maxContinueQuestionsPerRun: 4
costLimit: { perRunUsd: 2 }
skillBudgetTokens: 4000
historyRetentionDays: 7
`;
    const c = loadConfig({ "settings.yaml": old }, undefined, {}, { trusted: true });
    expect(c.errors).toEqual([]);
    expect(c.settings.costLimit.perRunUsd).toBe(2);
    expect(c.settings.skillBudgetTokens).toBe(4000);
    expect(c.settings.historyRetentionDays).toBe(7);
    expect("budgets" in c.settings).toBe(false);
  });

  it("roles with fallbackAgent and old role ids load as inert profiles", () => {
    const old = `version: 1
items:
  - id: orchestrator
    enabled: false
    fallbackAgent: a1
    tools: [dispatch, ask_user]
  - id: general-worker
    enabled: false
    skills: [orchestrate]
`;
    const c = loadConfig({ "roles.yaml": old }, undefined, {}, { trusted: true });
    expect(c.errors).toEqual([]);
    expect(c.roles.map((r) => r.id)).toEqual(["orchestrator", "general-worker"]);
    expect("fallbackAgent" in c.roles[0]).toBe(false);
  });

  it("agents with a budget block still parse", () => {
    const old = `version: 1
items:
  - id: a1
    channel: c
    model: m
    budget: { turnFactor: 2 }
`;
    const c = loadConfig({ "agents.yaml": old }, undefined, {}, { trusted: true });
    expect(c.errors).toEqual([]);
    expect(c.agents[0].id).toBe("a1");
  });
});

describe("store helpers", () => {
  it("SelfWriteGuard recognises its own writes only; only roles.yaml is a project file", () => {
    const g = new SelfWriteGuard();
    g.recordWrite("a.yaml", "x");
    expect(g.isSelfWrite("a.yaml", "x")).toBe(true);
    expect(g.isSelfWrite("a.yaml", "y")).toBe(false);
    g.recordDelete("a.yaml");
    expect(g.isSelfWrite("a.yaml", "x")).toBe(false);
    expect(hashContent("x")).toBe(hashContent("x"));
    expect(isProjectFile("roles.yaml")).toBe(true);
    expect(isProjectFile("channels.yaml")).toBe(false);
  });
});
