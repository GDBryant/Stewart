// Public surface of @stewart/roles-skills. Only this file is importable from outside.
export {
  matchGlob, WRITE_ROLE_TOOLS, READONLY_ROLES, isWriteCapableRole, roleTurnBudget, ROLE_CAPABILITY,
  roleCapability, agentCapability, agentServesRole, validateRoles,
} from "./roles.js";
export {
  hashBody, parseSkillMd, serializeSkillMd, shippedDefaultRoles, resolveSkills, shippedSkill, baseHashFor,
  composeRolePrompt, CHARS_PER_TOKEN, TRUNCATED_MARKER,
} from "./skills.js";
export type { SkillMeta, ResolvedSkill } from "./skills.js";
export { DEFAULT_ROLES_YAML } from "./defaults/roles.js";
export { DEFAULT_SKILLS, EXECUTION_CONTRACT, SIDE_EFFECT_TOOLS } from "./defaults/skills.js";
export type { ShippedSkill } from "./defaults/skills.js";
export { loadConfig } from "./effective.js";
export type { Config } from "./effective.js";
