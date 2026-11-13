import type { AgentDef, ChannelDef, RoleDef } from "@stewart/config";
import { chainErrors } from "./chain.js";

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

/**
 * Configuration errors for roles: an enabled role may leave `agent` unset
 * (it falls back to the lead's resolved agent), but a bound agent must exist
 * and serve the role's capability.
 */
function roleAgentErrors(r: RoleDef, byId: Map<string, AgentDef>): string[] {
  if (!r.agent) return [];
  const agent = byId.get(r.agent);
  if (!agent) return [`role ${r.id}: unknown agent '${r.agent}'`];
  return [];
}

export function validateRoles(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const enabled = roles.filter((r) => r.enabled);
  for (const r of enabled) {
    errors.push(...roleAgentErrors(r, byId));
    errors.push(...chainErrors(r, agents, channels));
  }
  return errors;
}
