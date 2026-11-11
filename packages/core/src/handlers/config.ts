import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_FILE_SCHEMAS, isProjectFile } from "@stewart/config";
import { baseHashFor, serializeSkillMd, shippedDefaultRoles, shippedSkill } from "@stewart/roles-skills";
import { importV1Xml, parseMiniXml } from "@stewart/v1-import";
import type { CoreCtx, ProjectCtx } from "./types.js";

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
  const secrets: Record<string, boolean> = {};
  for (const c of ctx.config.channels) {
    if (c.secretRef && !(c.secretRef in secrets)) secrets[c.secretRef] = (await ctx.host.secrets.get(c.secretRef)) !== undefined;
  }
  return { files, summary, errors, secrets };
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
  checkConfigSchema(schema, p.file, parseConfigYaml(p.yaml));
  await writeConfigLayer(core, ctx, { file: p.file, yaml: p.yaml, layer: p.layer ?? "user" });
  await core.reload(p.projectId);
  return { ok: true };
}

function parseConfigYaml(yaml: string): unknown {
  try {
    return parseYaml(yaml);
  } catch (e) {
    throw new Error(`invalid YAML: ${e instanceof Error ? e.message : e}`);
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

export async function handleConfigImportV1(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; xml: string; apply?: boolean };
  const res = importV1Xml(p.xml, parseMiniXml);
  if (p.apply && Object.keys(res.files).length) {
    for (const [file, yaml] of Object.entries(res.files)) {
      await writeUser(core, file, yaml);
    }
    await core.reload(p.projectId);
  }
  return res;
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

export async function handleRolesAssignAgent(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; agentId: string; wizard?: boolean };
  const ctx = core.ctx(p.projectId);
  if (!ctx.config.agents.some((a) => a.id === p.agentId)) throw new Error(`unknown agent: ${p.agentId}`);
  const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: Record<string, unknown>[] } | null;
  const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
  const byId = new Map(items.map((i) => [String(i.id), i]));
  for (const r of ctx.config.roles) {
    const item = byId.get(r.id) ?? { id: r.id };
    item.agent = p.agentId;
    if (p.wizard) item.enabled = r.id === "orchestrator" || r.id === "general-worker";
    byId.set(r.id, item);
  }
  await writeUser(core, "roles.yaml", stringifyYaml({ version: 1, items: [...byId.values()] }));
  await core.reload(p.projectId);
  return { ok: true };
}

export async function handleSecretSet(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; ref: string; value: string };
  const ctx = core.ctx(p.projectId);
  await ctx.host.secrets.set(p.ref, p.value);
  core.secretValues.set(p.ref, p.value);
  core.channelService.setSecret(p.ref, p.value);
  return { ok: true };
}

export async function handleSecretDelete(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; ref: string };
  const ctx = core.ctx(p.projectId);
  await ctx.host.secrets.delete(p.ref);
  core.secretValues.delete(p.ref);
  core.channelService.setSecret(p.ref, undefined);
  return { ok: true };
}
