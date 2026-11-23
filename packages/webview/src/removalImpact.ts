import type { AgentSummary, RoleSummary } from "./bridge.js";

/** What a Settings Remove touches before it happens (for the inline confirm). */
export interface RemovalImpact {
  agents: string[];
  roles: string[];
}

const boundRoles = (agentIds: ReadonlySet<string>, roles: RoleSummary[]): string[] =>
  roles.filter((r) => agentIds.has(r.agent ?? "") || agentIds.has(r.secondary ?? "")).map((r) => r.id);

/**
 * Channel removal drops every agent on it and resets the roles bound to them; agent removal
 * resets the roles bound to it. Pure; mirrors the core cascade in `configCascade.ts`.
 */
export function removalImpact(kind: "channel" | "agent", id: string, agents: AgentSummary[], roles: RoleSummary[]): RemovalImpact {
  const gone = kind === "channel" ? agents.filter((a) => a.channel === id).map((a) => a.id) : [id];
  return { agents: gone, roles: boundRoles(new Set(gone), roles) };
}
