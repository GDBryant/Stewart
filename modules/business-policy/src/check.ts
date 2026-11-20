import type { ChatMessage } from "@stewart/kernel";
import { RULES } from "./rules.js";
import type { Outbound, RuleId, Violation, Where } from "./types.js";

/** Text parts of one message: content plus assistant tool-call arguments. */
function textOf(m: ChatMessage): string {
  if (m.role !== "assistant" || !m.toolCalls?.length) return m.content;
  return [m.content, ...m.toolCalls.map((c) => JSON.stringify(c.arguments))].join("\n");
}

function scanMessage(m: ChatMessage, msgIndex: number, rules: RuleId[]): Violation[] {
  const text = textOf(m);
  const where: Where = m.role;
  const out: Violation[] = [];
  for (const id of rules) for (const hint of RULES[id].scan(text)) out.push({ rule: id, where, msgIndex, hint });
  return out;
}

/** Violations in the outgoing messages (text only; images are not inspected). Never carries matched text. */
export function checkOutbound(messages: ChatMessage[], rules: RuleId[]): Violation[] {
  if (!rules.length) return [];
  return messages.flatMap((m, i) => scanMessage(m, i, rules));
}

export function withheldMarker(rules: RuleId[]): string {
  return `[output withheld by business policy: ${[...new Set(rules)].join(", ")}]`;
}

/** Split violations by kind and replace offending tool results in a copy; the input is not mutated. */
export function applyOutbound(messages: ChatMessage[], rules: RuleId[]): Outbound {
  const found = checkOutbound(messages, rules);
  const withheld = found.filter((v) => v.where === "tool");
  const blocked = found.filter((v) => v.where !== "tool");
  const hitTools = new Set(withheld.map((v) => v.msgIndex));
  const out = messages.map((m, i): ChatMessage => {
    if (m.role !== "tool" || !hitTools.has(i)) return m;
    return { ...m, content: withheldMarker(withheld.filter((v) => v.msgIndex === i).map((v) => v.rule)) };
  });
  return { messages: out, blocked, withheld };
}

/** Human-readable evidence line; no matched text. */
export function describeViolation(v: Violation): string {
  return `${v.rule} in ${v.where} #${v.msgIndex} (${v.hint})`;
}
