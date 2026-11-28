import type { RoleDef } from "@stewart/config";

export interface LeadResolution {
  role: RoleDef;
  /** True when the active lead is a fallback row rather than an enabled agent-kind `lead`. */
  fallback: boolean;
  /** Why the fallback row leads, for the visible label. */
  reason?: "lead-disabled" | "lead-not-agent" | "lead-deleted";
}

const isAgentKind = (r: RoleDef): boolean => (r.kind ?? "agent") === "agent";

/**
 * The active lead, resolved once per user turn over the effective role list (user rows in file
 * order, then project-only rows appended). `lead` is the preferred id, not a requirement:
 *  1. an enabled agent-kind `lead` row wins;
 *  2. otherwise, when a `lead` row exists but is disabled or not agent-kind, the first enabled
 *     agent-kind row after it leads, or the first enabled agent-kind row overall when none follows;
 *  3. when no `lead` row exists at all, the first enabled agent-kind row leads;
 *  4. when no agent-kind row is enabled there is no active lead — chat is unavailable.
 * Function-kind roles are utilities and never lead.
 */
export function resolveActiveLead(roles: RoleDef[]): LeadResolution | undefined {
  const enabledAgents = roles.filter((r) => r.enabled && isAgentKind(r));
  const lead = roles.find((r) => r.id === "lead");
  if (lead && lead.enabled && isAgentKind(lead)) return { role: lead, fallback: false };
  if (!enabledAgents.length) return undefined;
  if (!lead) return { role: enabledAgents[0], fallback: true, reason: "lead-deleted" };
  const at = roles.indexOf(lead);
  const after = enabledAgents.find((r) => roles.indexOf(r) > at);
  const reason = !lead.enabled ? "lead-disabled" : "lead-not-agent";
  return { role: after ?? enabledAgents[0], fallback: true, reason };
}
