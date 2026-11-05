import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { agentsFile, channelsFile, rolesFile, settingsFile, type AgentDef, type ChannelDef, type RoleDef, type Settings, CONFIG_VERSION } from "./schema.js";

/** Raw YAML text per file name, per layer. Host supplies reads + writes. */
export type ConfigLayer = Record<string, string | undefined>;

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
export function loadConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, trusted: boolean): Config {
  const errors: string[] = [];
  const proj = trusted ? project ?? {} : {};
  if (!trusted && project && (project["roles.yaml"] || project["skills/"])) errors.push("untrusted workspace: project .stewart/ config ignored");

  const ch = [parseFile(channelsFile, "channels.yaml", defaults["channels.yaml"], errors), parseFile(channelsFile, "channels.yaml", user["channels.yaml"], errors)];
  const ag = [parseFile(agentsFile, "agents.yaml", defaults["agents.yaml"], errors), parseFile(agentsFile, "agents.yaml", user["agents.yaml"], errors)];
  const rl = [
    parseFile(rolesFile, "roles.yaml", defaults["roles.yaml"], errors),
    parseFile(rolesFile, "roles.yaml", user["roles.yaml"], errors),
    parseFile(rolesFile, "roles.yaml", proj["roles.yaml"], errors),
  ];
  const st = [parseFile(settingsFile, "settings.yaml", defaults["settings.yaml"], errors), parseFile(settingsFile, "settings.yaml", user["settings.yaml"], errors), parseFile(settingsFile, "settings.yaml", proj["settings.yaml"], errors)];

  const channels = mergeById([...(ch[0]?.items ?? []), ...(ch[1]?.items ?? [])], []);
  const agents = mergeById([...(ag[0]?.items ?? []), ...(ag[1]?.items ?? [])], []);
  const roles = mergeById(mergeById(rl[0]?.items ?? [], rl[1]?.items ?? []), rl[2]?.items ?? []);

  const base = st[0] ?? settingsFile.parse({});
  const settings: Settings = { ...base, ...(st[1] ?? {}), ...(st[2] ?? {}), costLimit: { ...base.costLimit, ...(st[1]?.costLimit ?? {}), ...(st[2]?.costLimit ?? {}) } };

  return { channels, agents, roles, settings, errors };
}
