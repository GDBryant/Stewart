import { describe, expect, it } from "vitest";
import type { Settings } from "@stewart/config";
import { recoveryState } from "../src/api.js";

const settings = {
  maxRecoveryDepth: 2, maxRecoveriesPerRun: 3, maxSubTasks: 4, recoverySummaryChars: 100,
  maxActionsInRecoveryBrief: 5, maxContinuations: 6, maxContinueQuestionsPerRun: 7,
  askOnTurnLimit: true, continueQuestionTimeoutMinutes: 2,
} as Settings;

describe("recoveryState", () => {
  it("maps settings and initialises counters", () => {
    const st = recoveryState(settings);
    expect(st).toMatchObject({ maxRecoveryDepth: 2, maxRecoveriesPerRun: 3, maxSubTasks: 4, recoverySummaryChars: 100, maxActionsInRecoveryBrief: 5, maxContinuations: 6, maxContinueQuestionsPerRun: 7, askOnTurnLimit: true, recoveriesUsed: 0, questionsUsed: 0 });
    expect(st.continueQuestionTimeoutMs).toBe(120_000);
  });

  it("gives each run its own counters", () => {
    const a = recoveryState(settings);
    const b = recoveryState(settings);
    a.recoveriesUsed += 1;
    a.questionsUsed += 2;
    expect(b.recoveriesUsed).toBe(0);
    expect(b.questionsUsed).toBe(0);
  });

  it("converts a zero-minute question timeout to zero ms and keeps askOnTurnLimit false", () => {
    const st = recoveryState({ ...settings, continueQuestionTimeoutMinutes: 0, askOnTurnLimit: false } as Settings);
    expect(st.continueQuestionTimeoutMs).toBe(0);
    expect(st.askOnTurnLimit).toBe(false);
  });
});
