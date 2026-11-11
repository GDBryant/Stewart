import { loadConfig as loadBase, type Config as BaseConfig, type ConfigLayer } from "@stewart/config";
import { resolveSkills, type ResolvedSkill } from "./skills.js";
import { validateRoles } from "./roles.js";

/** Base config plus the skills resolved from the same layers. */
export type EffectiveConfig = BaseConfig & { skills: ResolvedSkill[] };

/** `@stewart/config` merge, then skills and role validation (those live above config in the layer order). */
export function loadEffectiveConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, trusted: boolean): EffectiveConfig {
  const base = loadBase(user, project, defaults, trusted);
  const skills = resolveSkills(user, trusted ? project : undefined);
  return { ...base, skills, errors: [...base.errors, ...validateRoles(base.roles, base.agents, base.channels)] };
}
