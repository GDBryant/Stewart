import type { ChatMessage } from "@stewart/kernel";
import { applyOutbound, checkOutbound, type Violation } from "@stewart/business-policy";
import type { ManagedChannel } from "@stewart/channels";
import type { EngineEvent } from "./types.js";

type Notice = Extract<EngineEvent, { kind: "policy.notice" }>;

/** Notices for violations; carries rule and position only, never matched text. */
export function noticesOf(channel: string, action: Notice["action"], vs: Violation[]): Notice[] {
  return vs.map((v) => ({ kind: "policy.notice", channel, rule: v.rule, action, where: v.where, msgIndex: v.msgIndex }));
}

const noticed = new WeakSet<object>();

/** Withheld notices once per offending message object (the replacement is re-applied on every request). */
export function freshWithheld(channel: string, sent: ChatMessage[], vs: Violation[]): Notice[] {
  const fresh = vs.filter((v) => {
    const m = sent[v.msgIndex];
    if (!m || noticed.has(m)) return false;
    noticed.add(m);
    return true;
  });
  return noticesOf(channel, "withheld", fresh);
}

/**
 * After a block, replace every user/assistant message in the persisted transcript that trips the blocked rules, so the
 * next request is not blocked again. Scans the transcript itself (outgoing indexes can differ from transcript ones).
 */
export function redactBlocked(transcript: ChatMessage[], blocked: Violation[]): void {
  const rules = [...new Set(blocked.map((v) => v.rule))];
  for (const v of checkOutbound(transcript, rules)) {
    const m = transcript[v.msgIndex];
    if (!m || m.role === "tool" || m.role === "system") continue;
    const content = `[message withheld by business policy: ${v.rule}]`;
    transcript[v.msgIndex] = m.role === "assistant" ? { ...m, content, toolCalls: m.toolCalls?.map((c) => ({ ...c, arguments: {} })) } : { ...m, content };
  }
}

/**
 * Withhold tool results before the transcript is rendered for a provider (`forNative` flattens another engine's tool
 * results into assistant text, where the channel could no longer tell them apart). Returns the copy plus withheld
 * notices; positions count the system prompt as #0, like the channel's own.
 */
export function withholdTools(channel: ManagedChannel, system: string, transcript: ChatMessage[]): { transcript: ChatMessage[]; notices: Notice[] } {
  const rules = [...channel.policyRules];
  if (!rules.length) return { transcript, notices: [] };
  const out = applyOutbound(transcript, rules);
  const sent: ChatMessage[] = [{ role: "system", content: system }, ...transcript];
  return { transcript: out.messages, notices: freshWithheld(channel.cfg.id, sent, out.withheld.map((v) => ({ ...v, msgIndex: v.msgIndex + 1 }))) };
}
