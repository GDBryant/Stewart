import type { ChatMessage } from "@stewart/kernel";

export const RULE_IDS = ["passwords", "privacy"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** A content rule: pure text scan. Returns short kind labels, never the matched text. */
export interface Rule {
  id: RuleId;
  /** One line shown in settings: what the rule blocks. */
  describe: string;
  scan(text: string): string[];
}

export type Where = "system" | "user" | "tool" | "assistant";

export interface Violation {
  rule: RuleId;
  where: Where;
  msgIndex: number;
  /** Kind of match (e.g. "private key block"); never the matched text. */
  hint: string;
}

export interface Outbound {
  /** Copy to send: tool results with violations are replaced by a withheld marker. */
  messages: ChatMessage[];
  /** Violations in user/system/assistant content: the request must not be sent. */
  blocked: Violation[];
  /** Tool results replaced in `messages`. */
  withheld: Violation[];
}
