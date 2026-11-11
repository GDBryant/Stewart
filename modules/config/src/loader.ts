import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { agentsFile, channelsFile, rolesFile, settingsFile, type AgentDef, type ChannelDef, type RoleDef, type Settings, CONFIG_VERSION } from "./schema.js";

/** Tools unioned into non-empty shipped role tool lists at load, keyed by role id. */
export type RequiredRoleTools = Readonly<Record<string, readonly string[]>>;

/** Raw YAML text per file name, per layer. Host supplies reads + writes. */
export type ConfigLayer = Record<string, string | undefined>;

/** Merged, schema-validated config. Skill resolution and role validation are layered on by the app (`roles-skills`). */
export interface Config {
  channels: ChannelDef[];
  agents: AgentDef[];
  roles: RoleDef[];
  settings: Settings;
  /** Errors surfaced in Settings; last-good config kept on failure. */
  errors: string[];
}

type Item = { id: string } & Record<string, unknown>;

/** Merge user + project lists by id, project fields winning field-by-field. */
function mergeById<T extends Item>(user: T[], project: T[]): T[] {
  const out = new Map<string, T>();
  for (const i of user) out.set(i.id, i);
  for (const i of project) out.set(i.id, { ...out.get(i.id), ...i });
  return [...out.values()];
}

function parseFile<S extends z.ZodTypeAny>(schema: S, name: string, text: string | undefined, errors: string[]): z.infer<S> | undefined {
  if (text === undefined) return undefined;
  try {
    const doc = parseYaml(text);
    if (doc == null) return undefined;
    return schema.parse(migrate(name, doc));
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Per-version migrations; v1 is current, older docs get upgraded key-by-key. */
export function migrate(name: string, doc: unknown): unknown {
  if (doc && typeof doc === "object" && !("version" in doc)) return { version: CONFIG_VERSION, ...(doc as object) };
  return doc;
}

/**
 * Build effective config: shipped defaults < user files < project files.
 * Project layer is applied only in trusted workspaces, and is limited to
 * roles.yaml + skills (channels/agents/secrets are user-level so a repo
 * cannot redirect agents to a foreign endpoint).
 */
function loadLayerFile<S extends z.ZodTypeAny>(schema: S, name: string, texts: (string | undefined)[], errors: string[]): (z.infer<S> | undefined)[] {
  return texts.map((t) => parseFile(schema, name, t, errors));
}

function mergedItems<T extends Item>(docs: ({ items?: T[] } | undefined)[]): T[] {
  return mergeById(docs.flatMap((d) => d?.items ?? []), []);
}

function mergeSettingsLayers(docs: (z.infer<typeof settingsFile> | undefined)[]): Settings {
  const [d0, d1, d2] = docs;
  const base = d0 ?? settingsFile.parse({});
  return {
    ...base,
    ...(d1 ?? {}),
    ...(d2 ?? {}),
    costLimit: { ...base.costLimit, ...(d1?.costLimit ?? {}), ...(d2?.costLimit ?? {}) },
  };
}

/**
 * Tools a shipped role must hold to do its job (supplied by plugged-in features): user roles.yaml snapshots
 * taken before a verb/tool shipped lack them, so they are unioned in at load time
 * (non-empty lists only — an empty list means all/default).
 */
function applyRequiredTools(roles: RoleDef[], requiredByRole: RequiredRoleTools): void {
  for (const r of roles) {
    const required = requiredByRole[r.id];
    if (required && r.tools.length) r.tools = [...new Set([...r.tools, ...required])];
  }
}

/** Options for `loadConfig`: trust gate for the project layer and the shipped-role tool union. */
export interface LoadConfigOptions {
  trusted: boolean;
  requiredRoleTools?: RequiredRoleTools;
}

/** Records (does not throw) when an untrusted workspace carries project config that is being ignored. */
function noteUntrustedProject(project: ConfigLayer | undefined, trusted: boolean, errors: string[]): void {
  if (!trusted && project && (project["roles.yaml"] || project["skills/"])) errors.push("untrusted workspace: project .stewart/ config ignored");
}

export function loadConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, opts: LoadConfigOptions): Config {
  const errors: string[] = [];
  const proj = opts.trusted ? project ?? {} : {};
  noteUntrustedProject(project, opts.trusted, errors);

  const ch = loadLayerFile(channelsFile, "channels.yaml", [defaults["channels.yaml"], user["channels.yaml"]], errors);
  const ag = loadLayerFile(agentsFile, "agents.yaml", [defaults["agents.yaml"], user["agents.yaml"]], errors);
  const rl = loadLayerFile(rolesFile, "roles.yaml", [defaults["roles.yaml"], user["roles.yaml"], proj["roles.yaml"]], errors);
  const st = loadLayerFile(settingsFile, "settings.yaml", [defaults["settings.yaml"], user["settings.yaml"], proj["settings.yaml"]], errors);

  const roles = mergeById(mergeById(rl[0]?.items ?? [], rl[1]?.items ?? []), rl[2]?.items ?? []);
  applyRequiredTools(roles, opts.requiredRoleTools ?? {});

  return { channels: mergedItems(ch), agents: mergedItems(ag), roles, settings: mergeSettingsLayers(st), errors };
}
