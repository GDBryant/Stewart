import type { AgentDef, ChannelDef } from "../config/schema.js";
import { agentServesRole, roleCapability } from "../roles.js";
import { isCosting } from "./ledger.js";

export interface ParkedRole {
  roleId: string;
  purpose?: string;
  skills?: string[];
}

export interface Replacement {
  role: string;
  agent: string;
  reason: string;
}

function contextTokens(agent: AgentDef, channels: ChannelDef[]): number {
  const caps = channels.find((c) => c.id === agent.channel)?.modelCaps?.[agent.model] as { contextTokens?: number } | undefined;
  return caps?.contextTokens ?? 0;
}

/** Enabled, non-costing agents that meet each parked role's capability needs. */
export function freeCandidates(roles: ParkedRole[], agents: AgentDef[], channels: ChannelDef[]): Record<string, AgentDef[]> {
  const free = agents.filter((a) => !isCosting(a) && channels.some((c) => c.id === a.channel && c.enabled));
  const out: Record<string, AgentDef[]> = {};
  for (const r of roles) out[r.roleId] = free.filter((a) => agentServesRole(a, channels, r.roleId));
  return out;
}

/**
 * Deterministic ranking used when no free agent is available to rank: capability
 * match first (already filtered), then context size, then id for stability.
 */
export function rankDeterministic(candidates: Record<string, AgentDef[]>, channels: ChannelDef[]): Replacement[] {
  const out: Replacement[] = [];
  for (const [role, list] of Object.entries(candidates)) {
    const best = [...list].sort((a, b) => contextTokens(b, channels) - contextTokens(a, channels) || a.id.localeCompare(b.id))[0];
    if (best) out.push({ role, agent: best.id, reason: `deterministic: largest context among free ${roleCapability(role) ?? "capable"} agents` });
  }
  return out;
}

/** Keep only suggestions that name a real candidate for that role; drop inventions. */
export function validateReplacements(suggested: Replacement[], candidates: Record<string, AgentDef[]>): Replacement[] {
  return suggested.filter((s) => (candidates[s.role] ?? []).some((a) => a.id === s.agent));
}

/** Parse `submit_replacements` output defensively (model output, never trusted). */
export function parseReplacements(args: unknown): Replacement[] {
  const list = (args as { replacements?: unknown })?.replacements;
  if (!Array.isArray(list)) return [];
  const out: Replacement[] = [];
  for (const r of list) {
    const o = r as Record<string, unknown>;
    if (typeof o.role !== "string" || typeof o.agent !== "string") continue;
    out.push({ role: o.role, agent: o.agent, reason: typeof o.reason === "string" ? o.reason : "" });
  }
  return out;
}
