import { applyDecisions, effectiveAgent, type RawItems, type SyncDocs } from "./modelSync.js";

/** What a `config.set` items diff resolved to: removed ids, or a single rename. */
export interface IdChange {
  removed: string[];
  renamed?: { from: string; to: string };
}

/** What changed in `agents.yaml` / `roles.yaml` when channels or agents disappeared or were renamed. */
export interface CascadeResult {
  agents: RawItems;
  roles: RawItems;
  /** Agent ids removed (bound to a removed channel, or removed directly). */
  removedAgents: string[];
  /** Role ids whose `agent`/`secondary` was reset (promote surviving secondary, else unbound). */
  resetRoles: string[];
  changed: boolean;
}

/**
 * Classify an items diff: one id gone at an unchanged list length, and the item at that index now
 * carries a new id or an id duplicated in `next` = rename; anything else gone = removal.
 */
export function detectIdChange(prev: RawItems, next: RawItems): IdChange {
  const nextIds = next.map((i) => String(i.id));
  const gone = prev.filter((i) => !nextIds.includes(String(i.id)));
  const removed = gone.map((i) => String(i.id));
  if (gone.length !== 1 || next.length !== prev.length) return { removed };
  const to = nextIds[prev.indexOf(gone[0])];
  const isNew = !prev.some((i) => String(i.id) === to);
  const isDuplicate = nextIds.indexOf(to) !== nextIds.lastIndexOf(to);
  return isNew || isDuplicate ? { removed: [], renamed: { from: removed[0], to } } : { removed };
}

/**
 * Removal cascade, shared by Settings `config.set` and the setup wizard: agents on `gone.channels`
 * plus `gone.agents` are removed; roles binding one via `agent`/`secondary`/legacy `chain` are
 * reset (`applyDecisions` → `unbindRole`). Unknown fields are preserved; `changed` is false when
 * neither file needs rewriting.
 */
export function cascadeRemoval(
  docs: Pick<SyncDocs, "agents" | "roles">,
  gone: { channels?: ReadonlySet<string>; agents?: ReadonlySet<string> },
): CascadeResult {
  const onGoneChannels = docs.agents.filter((a) => gone.channels?.has(String(a.channel))).map((a) => String(a.id));
  const removedAgents = [...new Set([...onGoneChannels, ...(gone.agents ?? [])])];
  const removed = new Set(removedAgents);
  const res = applyDecisions({ agents: docs.agents, roles: docs.roles, channels: [] }, { removeAgents: removed });
  const resetRoles = docs.roles
    .filter((r) => {
      const agent = effectiveAgent(r);
      return (agent !== undefined && removed.has(agent)) || (typeof r.secondary === "string" && removed.has(r.secondary));
    })
    .map((r) => String(r.id));
  return { agents: res.agents, roles: res.roles, removedAgents, resetRoles, changed: res.changed };
}

/**
 * Re-point references after an id rename: `kind: "channel"` rewrites agents' `channel` field;
 * `kind: "agent"` rewrites roles' `agent`/`secondary` (and legacy `chain`). Identity rows kept
 * for untouched items.
 */
export function repointRename(
  docs: Pick<SyncDocs, "agents" | "roles">,
  kind: "channel" | "agent",
  r: { from: string; to: string },
): CascadeResult {
  const agents =
    kind === "channel"
      ? docs.agents.map((a) => (a.channel === r.from ? { ...a, channel: r.to } : a))
      : docs.agents;
  const roles = kind === "agent" ? docs.roles.map((role) => repointRole(role, r)) : docs.roles;
  return {
    agents,
    roles,
    removedAgents: [],
    resetRoles: [],
    changed: agents.some((a, i) => a !== docs.agents[i]) || roles.some((x, i) => x !== docs.roles[i]),
  };
}

function repointRole(role: Record<string, unknown>, r: { from: string; to: string }): Record<string, unknown> {
  const chain = Array.isArray(role.chain) ? role.chain : [];
  const next = { ...role };
  let hit = false;
  if (next.agent === r.from) (next.agent = r.to), (hit = true);
  if (next.secondary === r.from) (next.secondary = r.to), (hit = true);
  if (chain.includes(r.from)) {
    next.chain = chain.map((id) => (id === r.from ? r.to : id));
    hit = true;
  }
  return hit ? next : role;
}
