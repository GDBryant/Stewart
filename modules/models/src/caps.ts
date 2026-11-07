/** Measured model behaviour from the opt-in bench suite. Absent field = unknown, never zero. */
export interface ModelPerf {
  ttftMs?: number;
  tokPerSec?: number;
  /** 0..1: share of 3 trials that produced a valid tool call on the configured tools path. */
  toolReliability?: number;
  jsonOk?: boolean;
  editOk?: boolean;
  benchedAt: number;
  benchVersion: number;
}

export type ToolsMode = "native" | "shim" | "none";

export type ModelCaps = {
  tools: ToolsMode;
  vision: boolean;
  reasoning: boolean;
  imageGen: boolean;
  contextTokens: number;
  numCtx?: number;
  perf?: ModelPerf;
};

export const DEFAULT_CAPS: ModelCaps = { tools: "shim", vision: false, reasoning: false, imageGen: false, contextTokens: 32768 };

/** Whether the cost limit can see this agent's spend at all. */
export function isCosting(agent: { billing?: string }): boolean {
  return agent.billing === "reported" || agent.billing === "priced" || agent.billing === undefined;
}
