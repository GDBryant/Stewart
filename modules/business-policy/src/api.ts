// Public surface of @stewart/business-policy. Only this file is importable from outside.
export { RULE_IDS } from "./types.js";
export type { Rule, RuleId, Violation, Where, Outbound } from "./types.js";
export { RULES, registry } from "./rules.js";
export { checkOutbound, applyOutbound, describeViolation, withheldMarker } from "./check.js";
