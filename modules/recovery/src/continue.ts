import type { ChatMessage } from "@stewart/kernel";
import type { Prompt } from "@stewart/interaction";
import { actionsSoFar, detectStuck } from "@stewart/agent-loop";
import type { TaskSpec } from "@stewart/scheduling";

export type ContinueChoice = { kind: "continue" } | { kind: "split" } | { kind: "stop" } | { kind: "text"; text: string };

export function mapContinueAnswer(answer: string): ContinueChoice {
  if (/^continue/i.test(answer)) return { kind: "continue" };
  if (/^split/i.test(answer)) return { kind: "split" };
  if (/^stop/i.test(answer)) return { kind: "stop" };
  return { kind: "text", text: answer };
}

/** Turn-limit question text, capped at ~600 chars; recommended option first. */
export function continueQuestion(opts: {
  spec: TaskSpec;
  turns: number;
  transcript: ChatMessage[];
  maxActions: number;
  canSplit: boolean;
  timeoutMs?: number;
}): Prompt<ContinueChoice> {
  const stuck = detectStuck(opts.transcript);
  const acts = actionsSoFar(opts.transcript, opts.maxActions);
  const desc = opts.spec.task.replace(/\s+/g, " ").slice(0, 120);
  const lines = [
    `Worker hit its turn limit (${opts.turns}) on task ${opts.spec.id}: "${desc}".`,
    `Done so far: ${acts.slice(-5).join("; ") || "nothing yet"}.${acts.length ? ` Last action: ${acts[acts.length - 1]}.` : ""}`,
  ];
  if (stuck.stuck) lines.push(`Looks stuck: ${stuck.reason}`);
  const continueOpt = `Continue (+${opts.turns} turns)`;
  const options = opts.canSplit
    ? stuck.stuck
      ? ["Split into smaller tasks", continueOpt, "Stop this task"]
      : [continueOpt, "Split into smaller tasks", "Stop this task"]
    : [continueOpt, "Stop this task"];
  const question = lines.join("\n").slice(0, 600);
  return { kind: "question", topic: "continue", question, options, timeoutMs: opts.timeoutMs, decode: mapContinueAnswer };
}
