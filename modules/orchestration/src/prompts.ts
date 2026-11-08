import type { AgentDef, RoleDef } from "@stewart/config";
import { questionPrompt, type Prompt } from "@stewart/interaction";

export type PlanGateChoice = { kind: "proceed" } | { kind: "revise"; reason: string };

export function planGatePrompt(milestoneCount: number): Prompt<PlanGateChoice> {
  return {
    kind: "question",
    topic: "plan_gate",
    question: `Plan approved by the validator (${milestoneCount} milestones). Proceed?`,
    options: ["Proceed", "Revise"],
    decode: (a) => (a.startsWith("Proceed") ? { kind: "proceed" } : { kind: "revise", reason: a }),
  };
}

export function costLimitPrompt(accrued: number, cap: number, parked: number, hasSuggestions: boolean): Prompt<"continue" | "replace" | "stop"> {
  return {
    kind: "question",
    topic: "cost_limit",
    question: `Cost limit reached: $${accrued.toFixed(2)} of $${cap.toFixed(2)}. ${parked} task(s) parked.`,
    options: ["Continue (+cost cap)", ...(hasSuggestions ? ["Use suggested replacements"] : []), "Stop"],
    decode: (a) => (a.startsWith("Continue") ? "continue" : a.startsWith("Use suggested replacements") ? "replace" : "stop"),
  };
}

export function fallbackPrompt(agent: AgentDef, role: RoleDef, fb: AgentDef): Prompt<"switch" | "park"> {
  return {
    kind: "question",
    topic: "fallback",
    question: `Channel '${agent.channel}' is unhealthy. Switch role '${role.id}' from free agent '${agent.id}' to paid fallback '${fb.id}'?`,
    options: ["Switch", "Park"],
    decode: (a) => (a.startsWith("Switch") ? "switch" : "park"),
  };
}

/** ask_user tool routing: withdrawn answers surface as a fixed note, never an empty string. */
export const NO_ANSWER = "(no answer: prompt withdrawn)";
