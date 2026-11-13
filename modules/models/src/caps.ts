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

/** native = provider tool calling seen; none = provider says no tools; unknown = not established (qualification decides). */
export type ToolsMode = "native" | "unknown" | "none";

/** Result of one qualification run (CONFORMANCE_VERSION-stamped). */
export interface Qual {
  passed: boolean;
  at: number;
  version: number;
  detail?: string;
  /** Verified minimum context window in tokens (set by the window probe or a known window). */
  context?: number;
}

/** Oldest qualification record version still accepted; older records must be re-run. */
export const QUAL_MIN_VERSION = 2;

/** True when the record qualifies the model now: passed, and not older than the current suite version. */
export function qualPassed(q: Qual | undefined): boolean {
  return q?.passed === true && q.version >= QUAL_MIN_VERSION;
}

export type ModelCaps = {
  tools: ToolsMode;
  vision: boolean;
  reasoning: boolean;
  imageGen: boolean;
  contextTokens: number;
  numCtx?: number;
  perf?: ModelPerf;
  qualified?: { agent?: Qual; function?: Qual };
};

export const DEFAULT_CAPS: ModelCaps = { tools: "unknown", vision: false, reasoning: false, imageGen: false, contextTokens: 32768 };

/** Anything that carries per-model caps (a channel config or a channel definition). */
export interface CapsSource {
  modelCaps?: Record<string, Partial<ModelCaps>>;
}

/** The caps the user set for one model, as written: an absent field means unknown, never a default. */
export function userCaps(source: CapsSource | undefined, model: string): Partial<ModelCaps> {
  return source?.modelCaps?.[model] ?? {};
}

/** Effective caps for one model: `DEFAULT_CAPS` under the user's fields (undefined fields never override). */
export function capsFor(source: CapsSource | undefined, model: string): ModelCaps {
  const out: ModelCaps = { ...DEFAULT_CAPS };
  for (const [k, v] of Object.entries(userCaps(source, model))) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Whether the cost limit can see this agent's spend at all. */
export function isCosting(agent: { billing?: string }): boolean {
  return agent.billing === "reported" || agent.billing === "priced" || agent.billing === undefined;
}
