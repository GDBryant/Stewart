import { loadConfig as loadBase, type Config as BaseConfig, type ConfigLayer } from "@stewart/config";
import { resolveSkills, type ResolvedSkill } from "@stewart/roles-skills";
import { validateRoles } from "@stewart/roles-skills";

/** Base config plus the skills resolved from the same layers. */
export type Config = BaseConfig & { skills: ResolvedSkill[] };

/** `@stewart/config` merge, then skills and role validation (those live above config in the layer order). */
export function loadConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, trusted: boolean): Config {
  const base = loadBase(user, project, defaults, trusted);
  const skills = resolveSkills(user, trusted ? project : undefined);
  return { ...base, skills, errors: [...base.errors, ...validateRoles(base.roles, base.agents, base.channels)] };
}
