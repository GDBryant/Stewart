import type { ChatMessage } from "@stewart/kernel";
import { applyOutbound } from "@stewart/business-policy";
import { BusinessPolicyError } from "@stewart/channels";
import { unseenRange } from "./claudeLines.js";
import { noticesOf, redactBlocked } from "./policyNotice.js";
import type { EngineEvent, EngineTurn } from "./types.js";

export interface Screened {
  /** Transcript copy with withheld tool results replaced (same indexes as the original). */
  turn: EngineTurn;
  events: EngineEvent[];
}

/**
 * Business policy for what Stewart writes to the CLI: the system prompt, the recap of messages the CLI has not seen,
 * and the user line. Older messages were already sent. A hit in a non-tool message throws BusinessPolicyError (and the
 * offending persisted user/assistant message is redacted); tool-result excerpts are replaced in the copy.
 */
export function screenTurn(turn: EngineTurn): Screened {
  const rules = [...turn.channel.policyRules];
  if (!rules.length) return { turn, events: [] };
  const sent: ChatMessage[] = [{ role: "system", content: turn.system }, ...turn.transcript];
  const { from } = unseenRange(turn);
  const out = applyOutbound(sent, rules);
  const live = (v: { msgIndex: number }) => v.msgIndex === 0 || v.msgIndex - 1 >= from;
  const blocked = out.blocked.filter(live);
  const channel = turn.channel.cfg.id;
  if (blocked.length) {
    redactBlocked(turn.transcript, blocked);
    throw new BusinessPolicyError(channel, blocked);
  }
  const withheld = out.withheld.filter(live);
  return { turn: { ...turn, transcript: out.messages.slice(1) }, events: noticesOf(channel, "withheld", withheld) };
}
