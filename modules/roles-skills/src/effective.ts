import { loadConfig as loadBase, type Config as BaseConfig, type ConfigLayer } from "@stewart/config";
import { resolveSkills, type ResolvedSkill } from "./skills.js";
import { validateRoles } from "./roles.js";

/** Base config plus the skills resolved from the same layers. */
export type EffectiveConfig = BaseConfig & { skills: ResolvedSkill[] };

/** Same options as `@stewart/config` loadConfig: `trusted` and optional `requiredRoleTools`. */
export type EffectiveOptions = Parameters<typeof loadBase>[3];

/** `@stewart/config` merge, then skills and role validation (those live above config in the layer order). */
export function loadEffectiveConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, opts: EffectiveOptions): EffectiveConfig {
  const base = loadBase(user, project, defaults, opts);
  const { trusted } = opts;
  const skills = resolveSkills(user, trusted ? project : undefined);
  return { ...base, skills, errors: [...base.errors, ...validateRoles(base.roles, base.agents, base.channels)] };
}
