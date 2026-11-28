import { loadConfig as loadBase, type Config as BaseConfig, type ConfigLayer } from "@stewart/config";
import { distinctWarnings } from "./distinct.js";
import { resolveSkills, type ResolvedSkill } from "./skills.js";
import { validateRoles } from "./roles.js";
import { heavyAgentErrors, roleWindowWarnings } from "./roleWindow.js";

/** Base config plus the skills resolved from the same layers. */
export type EffectiveConfig = BaseConfig & { skills: ResolvedSkill[] };

/** Same options as `@stewart/config` loadConfig: `trusted` and optional `requiredRoleTools`. */
export type EffectiveOptions = Parameters<typeof loadBase>[3];

/** `@stewart/config` merge, then skills and role validation (those live above config in the layer order). */
export function loadEffectiveConfig(user: ConfigLayer, project: ConfigLayer | undefined, defaults: ConfigLayer, opts: EffectiveOptions): EffectiveConfig {
  const base = loadBase(user, project, defaults, opts);
  const { trusted } = opts;
  const skills = resolveSkills(user, trusted ? project : undefined);
  const problems = [
    ...validateRoles(base.roles, base.agents, base.channels),
    ...heavyAgentErrors(base.roles, base.agents, base.channels),
    ...roleWindowWarnings(base.roles, base.agents, base.channels, base.settings.runTurnLimit),
    ...distinctWarnings(base.roles, base.agents),
  ];
  return { ...base, skills, errors: [...base.errors, ...problems] };
}
