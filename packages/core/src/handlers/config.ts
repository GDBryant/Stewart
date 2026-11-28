import { errorMessage } from "@stewart/kernel";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_FILE_SCHEMAS, isProjectFile } from "@stewart/config";
import { agentRefusal, baseHashFor, resolveActiveLead, serializeSkillMd, shippedDefaultRoles, shippedSkill, DEFAULT_ROLES_YAML } from "@stewart/roles-skills";
import { rolesFile } from "@stewart/config";
import type { RoleDef } from "@stewart/config";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { cascadeConfigSet } from "./configCascade.js";
import { applyChannelSecret, dropChannelSecret } from "./util.js";

async function writeUser(core: CoreCtx, file: string, yaml: string): Promise<void> {
  core.userGuard.recordWrite(file, yaml);
  await core.deps.userConfig.write(file, yaml);
}

async function writeProject(ctx: ProjectCtx, file: string, yaml: string): Promise<void> {
  ctx.projectGuard.recordWrite(file, yaml);
  await ctx.projectStore.write(file, yaml);
}

export async function handleConfigGet(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  const ctx = core.ctx(p.projectId);
  const userFiles = await core.deps.userConfig.read();
  const projectFiles = ctx.trusted ? await ctx.projectStore.read() : {};
  const files = { ...core.defaults, ...userFiles, ...projectFiles };
  const { errors, ...summary } = ctx.config;
  const roleTemplates = rolesFile.parse(parseYaml(DEFAULT_ROLES_YAML)).items;
  const secrets: Record<string, boolean> = {};
  for (const c of ctx.config.channels) {
    if (c.secretRef && !(c.secretRef in secrets)) secrets[c.secretRef] = (await ctx.host.secrets.get(c.secretRef)) !== undefined;
  }
  return { files, summary: { ...summary, roleTemplates }, errors, secrets };
}

export async function handleConfigReload(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; fromWatcher?: boolean };
  const { suppressed } = await core.reload(p.projectId, p.fromWatcher ?? false);
  return { ok: true, suppressed };
}

export async function handleConfigSet(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; file: string; yaml: string; layer?: "user" | "project" };
  const ctx = core.ctx(p.projectId);
  const schema = CONFIG_FILE_SCHEMAS[p.file];
  if (!schema) throw new Error(`unknown config file: ${p.file}`);
  const doc = parseConfigYaml(p.yaml);
  checkConfigSchema(schema, p.file, doc);
  try {
    await writeConfigLayer(core, ctx, { file: p.file, yaml: p.yaml, layer: p.layer ?? "user" });
    if (p.layer !== "project") await cascadeConfigSet(core, ctx, p.file, doc);
  } finally {
    await core.reload(p.projectId);
  }
  return { ok: true };
}

function parseConfigYaml(yaml: string): unknown {
  try {
    return parseYaml(yaml);
  } catch (e) {
    throw new Error(`invalid YAML: ${errorMessage(e)}`);
  }
}

function checkConfigSchema(schema: (typeof CONFIG_FILE_SCHEMAS)[string], file: string, doc: unknown): void {
  const parsed = schema.safeParse(doc ?? {});
  if (!parsed.success) throw new Error(`invalid ${file}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
}

async function writeConfigLayer(
  core: CoreCtx,
  ctx: ProjectCtx,
  o: { file: string; yaml: string; layer: "user" | "project" },
): Promise<void> {
  if (o.layer !== "project") return writeUser(core, o.file, o.yaml);
  if (!ctx.trusted) throw new Error("project config requires a trusted workspace");
  if (!isProjectFile(o.file)) throw new Error(`${o.file} is not allowed at project level`);
  await writeProject(ctx, o.file, o.yaml);
}

export async function handleSkillsSave(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; id: string; body: string; description?: string; layer?: "user" | "project" };
  const ctx = core.ctx(p.projectId);
  const shipped = shippedSkill(p.id);
  const meta = {
    id: p.id,
    description: p.description ?? shipped?.description ?? "",
    defaultRoles: shippedDefaultRoles(p.id),
    version: shipped?.version ?? 1,
    baseHash: p.layer === "project" ? undefined : baseHashFor(p.id),
  };
  const text = serializeSkillMd(meta, p.body);
  if (p.layer === "project") {
    if (!ctx.trusted) throw new Error("project skills require a trusted workspace");
    await writeProject(ctx, `skills/${p.id}.md`, text);
  } else {
    await writeUser(core, `skills/${p.id}.md`, text);
  }
  await core.reload(p.projectId);
  return { ok: true };
}

export async function handleSkillsReset(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; id: string };
  const file = `skills/${p.id}.md`;
  const ctx = core.ctx(p.projectId);
  core.userGuard.recordDelete(file);
  ctx.projectGuard.recordDelete(file);
  if (core.deps.userConfig.delete) await core.deps.userConfig.delete(file);
  await ctx.projectStore.delete?.(file);
  await core.reload(p.projectId);
  return { ok: true };
}

export async function handleRolesReset(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; roleId?: string };
  const ctx = core.ctx(p.projectId);
  const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: { id?: string }[] } | null;
  const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
  const next = p.roleId ? items.filter((i) => i.id !== p.roleId) : [];
  await writeUser(core, "roles.yaml", stringifyYaml({ version: 1, items: next }));
  await core.reload(p.projectId);
  return { ok: true };
}

/** Writes every shipped role missing from the user's roles.yaml into it (existing rows untouched); replies with the added ids. */
export async function handleRolesAddDefaults(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  const ctx = core.ctx(p.projectId);
  const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: { id?: string }[] } | null;
  const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
  const have = new Set(items.map((i) => i.id));
  const shipped = (parseYaml(core.defaults["roles.yaml"] ?? "") as { items?: { id?: string }[] } | null)?.items ?? [];
  const missing = shipped.filter((r) => r && !have.has(r.id));
  if (missing.length) {
    await writeUser(core, "roles.yaml", stringifyYaml({ version: 1, items: [...items, ...missing] }));
    await core.reload(p.projectId);
  }
  return { ok: true, added: missing.map((r) => r.id) };
}

/**
 * Assign one agent to every role in the write set. Non-wizard: the live roster only — an empty roster
 * gains no rows. Wizard: missing shipped templates are seeded as verbatim copies first (the wizard's
 * in-memory candidates), every written row is bound, and exactly `lead` is enabled — the minimum
 * population the lifecycle requires; other seeded rows stay inert until the user enables and binds them.
 */
export async function handleRolesAssignAgent(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; agentId: string; wizard?: boolean };
  const ctx = core.ctx(p.projectId);
  const agent = ctx.config.agents.find((a) => a.id === p.agentId);
  if (!agent) throw new Error(`unknown agent: ${p.agentId}`);
  const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: Record<string, unknown>[] } | null;
  const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
  const byId = new Map(items.map((i) => [String(i.id), i]));
  const ids = p.wizard ? seededWizardIds(core, ctx.config.roles, byId) : ctx.config.roles.map((r) => r.id);
  const writeRows = ids.map((id) => effectiveWizardRow(core, byId, id, p));
  const resolution = resolveActiveLead(writeRows as RoleDef[]);
  const why = resolution ? agentRefusal(resolution.role, agent, ctx.config.channels) : null;
  if (why) throw new Error(`agent ${p.agentId} cannot serve ${resolution!.role.id}: ${why}`);
  for (const row of writeRows) byId.set(String(row.id), row as Record<string, unknown>);
  if (!ids.length && !items.length) return { ok: true };
  await writeUser(core, "roles.yaml", stringifyYaml({ version: 1, items: [...byId.values()] }));
  await core.reload(p.projectId);
  return { ok: true };
}

/** Wizard write set: the live roster ids plus every shipped template id missing from it. */
function seededWizardIds(core: CoreCtx, roster: { id: string }[], byId: Map<string, Record<string, unknown>>): string[] {
  const have = new Set([...roster.map((r) => r.id), ...byId.keys()]);
  const shipped = (parseYaml(core.defaults["roles.yaml"] ?? "") as { items?: { id?: string }[] } | null)?.items ?? [];
  const out = roster.map((r) => r.id);
  for (const t of shipped) {
    const id = String(t.id ?? "");
    if (id && !have.has(id)) out.push(id);
  }
  return out;
}

/** One row of the write set: the user row when present, else the shipped template copy; agent bound, chain dropped, wizard enables only lead. */
function effectiveWizardRow(core: CoreCtx, byId: Map<string, Record<string, unknown>>, id: string, p: { agentId: string; wizard?: boolean }): Record<string, unknown> {
  const shipped = (parseYaml(core.defaults["roles.yaml"] ?? "") as { items?: Record<string, unknown>[] } | null)?.items ?? [];
  const base = byId.get(id) ?? shipped.find((t) => String(t.id ?? "") === id) ?? { id };
  const item: Record<string, unknown> = { ...base, id };
  item.agent = p.agentId;
  delete item.chain;
  if (item.secondary === p.agentId) delete item.secondary;
  if (p.wizard) item.enabled = id === "lead";
  return item;
}

export async function handleSecretSet(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; ref: string; value: string };
  await applyChannelSecret(core, core.ctx(p.projectId), p.ref, p.value);
  return { ok: true };
}

export async function handleSecretDelete(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; ref: string };
  await dropChannelSecret(core, core.ctx(p.projectId), p.ref);
  return { ok: true };
}
