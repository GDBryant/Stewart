import type { AgentDef } from "@stewart/config";
import { agentRefusal, type EffectiveConfig } from "@stewart/roles-skills";
import type { RoleDef } from "@stewart/config";

/**
 * Plan milestone tasks (`hasBaseline`: they reuse the plan's baseline) of a role with a `heavyAgent` start on that
 * agent when it is eligible (exists, channel enabled, the role accepts it); the normal chain follows. Anything else keeps the chain.
 */
export function heavyFirst(role: RoleDef, chain: AgentDef[], cfg: EffectiveConfig, hasBaseline: boolean): AgentDef[] {
  if (!hasBaseline || !role.heavyAgent || chain[0]?.id === role.heavyAgent) return chain;
  const heavy = cfg.agents.find((a) => a.id === role.heavyAgent);
  if (!heavy || cfg.channels.find((c) => c.id === heavy.channel)?.enabled === false) return chain;
  if (agentRefusal(role, heavy, cfg.channels) !== null) return chain;
  return [heavy, ...chain.filter((a) => a.id !== heavy.id)];
}
