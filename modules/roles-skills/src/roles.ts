import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";

/** Glob match: `**` crosses directories, `*` and `?` stay within a segment. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  const re = globToRegex(pattern);
  return re.test(p);
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&");
  const body = esc
    .split("**")
    .map((seg) => seg.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp("^" + body + "$");
}

/** Capability an agent must have to serve a role (undefined = any agent). */
export const ROLE_CAPABILITY: Record<string, "vision" | "imageGen"> = {
  "image-reader": "vision",
  "image-writer": "imageGen",
};

export function roleCapability(roleId: string): "vision" | "imageGen" | undefined {
  return ROLE_CAPABILITY[roleId];
}

/** Capability flags for an agent's model, from its channel's modelCaps. */
export function agentCapability(agent: AgentDef, channels: ChannelDef[]): Record<string, boolean> {
  return resolveModelProfile({ channels }, { channel: agent.channel, model: agent.model }).caps as Record<string, boolean>;
}

export function agentServesRole(agent: AgentDef, channels: ChannelDef[], roleId: string): boolean {
  const cap = roleCapability(roleId);
  return !cap || agentCapability(agent, channels)[cap] === true;
}

/**
 * Configuration errors for roles: an enabled role must have an agent bound
 * (except lead, which falls back to the first agent), and capability roles
 * must point at a capable agent.
 */
function roleAgentErrors(r: RoleDef, byId: Map<string, AgentDef>, channels: ChannelDef[]): string[] {
  if (!r.agent) return r.id === "lead" ? [] : [`role ${r.id}: enabled but no agent bound`];
  const agent = byId.get(r.agent);
  if (!agent) return [`role ${r.id}: unknown agent '${r.agent}'`];
  if (!agentServesRole(agent, channels, r.id)) return [`role ${r.id}: agent '${r.agent}' lacks ${roleCapability(r.id)}`];
  return [];
}

export function validateRoles(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const enabled = roles.filter((r) => r.enabled);
  for (const r of enabled) {
    errors.push(...roleAgentErrors(r, byId, channels));
  }
  return errors;
}
