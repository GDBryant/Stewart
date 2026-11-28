import type { AgentDef, RoleDef } from "@stewart/config";
import { roleChainIds } from "./chain.js";

const keyOf = (a: AgentDef) => `${a.channel}/${a.model}`;

/** Primary agent of a role: first id of roleChainIds, resolved in agents; undefined when none. */
export function primaryAgent(role: RoleDef, roles: RoleDef[], agents: AgentDef[]): AgentDef | undefined {
  const id = roleChainIds(role, roles, agents)[0];
  return agents.find((a) => a.id === id);
}

/** Agents the role must avoid: primary agents of its enabled `distinctFrom` roles, as "channel/model" keys. Unknown ids are ignored. */
export function avoidedModels(role: RoleDef, roles: RoleDef[], agents: AgentDef[]): Set<string> {
  const out = new Set<string>();
  for (const id of role.distinctFrom ?? []) {
    const other = roles.find((r) => r.id === id);
    if (!other || other.enabled === false || other.id === role.id) continue;
    const p = primaryAgent(other, roles, agents);
    if (p) out.add(keyOf(p));
  }
  return out;
}

/** `warning: …` strings for enabled roles whose primary agent shares a model with a distinctFrom role. */
export function distinctWarnings(roles: RoleDef[], agents: AgentDef[]): string[] {
  const out: string[] = [];
  // Enabled roles' primary-agent model keys by role id; disabled or agent-less roles have none.
  const keyById = new Map<string, string>();
  for (const r of roles) {
    if (r.enabled === false) continue;
    const p = primaryAgent(r, roles, agents);
    if (p) keyById.set(r.id, keyOf(p));
  }
  for (const role of roles) {
    const mineKey = keyById.get(role.id);
    if (!mineKey) continue;
    for (const id of role.distinctFrom ?? []) {
      if (id === role.id) continue;
      if (keyById.get(id) === mineKey) {
        out.push(`warning: role ${role.id}: shares model ${mineKey} with ${id} (distinctFrom); independent review is weakened — bind a different model`);
      }
    }
  }
  return out;
}

/** First chain agent not in `avoid`; otherwise the first chain agent plus `independent: false`. Empty chain → no agent, `independent: true`. */
export function pickIndependent(chain: AgentDef[], avoid: Set<string>): { agent?: AgentDef; independent: boolean } {
  if (!chain.length) return { agent: undefined, independent: true };
  const fresh = chain.find((a) => !avoid.has(keyOf(a)));
  if (fresh) return { agent: fresh, independent: true };
  return { agent: chain[0], independent: false };
}
