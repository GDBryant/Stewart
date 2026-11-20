import { passwords } from "./rules/passwords.js";
import { privacy } from "./rules/privacy.js";
import type { Rule, RuleId } from "./types.js";

/** Build the registry; a duplicate id is a programming error. */
export function registry(list: Rule[]): Record<RuleId, Rule> {
  const out = {} as Record<RuleId, Rule>;
  for (const r of list) {
    if (out[r.id]) throw new Error(`duplicate business-policy rule '${r.id}'`);
    out[r.id] = r;
  }
  return out;
}

export const RULES = registry([passwords, privacy]);
