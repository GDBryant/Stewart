// Public surface of @stewart/roles-skills. Only this file is importable from outside.
export {
  matchGlob, ROLE_CAPABILITY, roleCapability, agentCapability, agentServesRole, validateRoles,
} from "./roles.js";
export {
  hashBody, parseSkillMd, serializeSkillMd, shippedDefaultRoles, resolveSkills, shippedSkill, baseHashFor,
} from "./skills.js";
export type { SkillMeta, ResolvedSkill } from "./skills.js";
export { DEFAULT_ROLES_YAML } from "./defaults/roles.js";
export { DEFAULT_SKILLS } from "./defaults/skills.js";
export type { ShippedSkill } from "./defaults/skills.js";
export { loadEffectiveConfig } from "./effective.js";
export type { EffectiveConfig, EffectiveOptions } from "./effective.js";
