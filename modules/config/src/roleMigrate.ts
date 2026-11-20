/**
 * Legacy role `chain` → `agent`/`secondary`, run as a schema preprocess.
 * A chain whose first entry matches `agent` contributes the next distinct entry as
 * `secondary`; a chain whose first entry differs is stale (the hidden-override bug
 * this replaces) and is dropped. `secondary: ""` normalizes to absent.
 */
export function migrateRoleChain(raw: unknown): unknown {
  const r = roleItem(raw);
  if (!r) return raw;
  const chain = legacyChain(r);
  delete r.chain;
  if (r.secondary === "") delete r.secondary;
  return applyChain(r, chain);
}

function roleItem(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : undefined;
}

function applyChain(r: Record<string, unknown>, chain: string[]): Record<string, unknown> {
  if (!r.agent && chain.length) r.agent = chain[0];
  const agent = typeof r.agent === "string" ? r.agent : undefined;
  if (!agent || r.secondary) return r;
  const next = legacySecondary(agent, chain);
  if (next) r.secondary = next;
  return r;
}

function legacyChain(r: Record<string, unknown>): string[] {
  return Array.isArray(r.chain) ? r.chain.filter((x): x is string => typeof x === "string") : [];
}

function legacySecondary(agent: string, chain: string[]): string | undefined {
  return chain.length && chain[0] === agent ? chain.find((id) => id !== agent) : undefined;
}
