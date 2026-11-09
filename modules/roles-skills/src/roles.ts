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

export const WRITE_ROLE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "RunTerminal", "GenerateImage"]);
export const READONLY_ROLES = new Set(["orchestrator", "planner", "plan-validator", "investigator", "code-reviewer", "code-health-reviewer", "image-reader"]);

/** Write-capable roles run as workers: eligible for the continue question and splits. */
export function isWriteCapableRole(role: RoleDef): boolean {
  if (READONLY_ROLES.has(role.id)) return false;
  if (role.tools.length === 0) return true;
  return role.tools.some((t) => WRITE_ROLE_TOOLS.has(t));
}

/** Loop turn cap from the role ("unlimited" → effectively unbounded). */
export function roleTurnBudget(role: RoleDef): number {
  return role.turnBudget === "unlimited" ? Number.MAX_SAFE_INTEGER : role.turnBudget;
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
 * Configuration errors for roles. An enabled role must have an agent bound (no
 * silent fallback), the Orchestrator must be enabled once another role is, and
 * capability roles must point at a capable agent.
 */
function roleAgentErrors(r: RoleDef, byId: Map<string, AgentDef>, channels: ChannelDef[]): string[] {
  if (!r.agent) return [`role ${r.id}: enabled but no agent bound`];
  const agent = byId.get(r.agent);
  if (!agent) return [`role ${r.id}: unknown agent '${r.agent}'`];
  if (!agentServesRole(agent, channels, r.id)) return [`role ${r.id}: agent '${r.agent}' lacks ${roleCapability(r.id)}`];
  return [];
}

function roleFallbackErrors(r: RoleDef, byId: Map<string, AgentDef>, channels: ChannelDef[]): string[] {
  if (!r.fallbackAgent) return [];
  const fb = byId.get(r.fallbackAgent);
  if (!fb) return [`role ${r.id}: unknown fallbackAgent '${r.fallbackAgent}'`];
  if (!agentServesRole(fb, channels, r.id)) return [`role ${r.id}: fallbackAgent '${r.fallbackAgent}' lacks ${roleCapability(r.id)}`];
  return [];
}

export function validateRoles(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const enabled = roles.filter((r) => r.enabled);
  for (const r of enabled) {
    errors.push(...roleAgentErrors(r, byId, channels));
    errors.push(...roleFallbackErrors(r, byId, channels));
  }
  const orchestrator = roles.find((r) => r.id === "orchestrator");
  if (enabled.some((r) => r.id !== "orchestrator") && !orchestrator?.enabled) {
    errors.push("orchestrator: required when another role is enabled");
  }
  return errors;
}
