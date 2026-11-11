# @stewart/roles-skills

- Purpose: Role and skill definitions, validation, tool filter, prompt composition, effective config
- Surface: `src/api.ts`
- Owns: `roles.ts` (globs, `isWriteCapableRole`, `validateRoles`, `roleTurnBudget`), `skills.ts` (copy-on-write skills, `composeRolePrompt`, `serializeSkillMd`), `effective.ts` (`loadEffectiveConfig` = config loader + skills + role validation, returns `EffectiveConfig`), `defaults/*`
- Depends on: `@stewart/config`, `@stewart/models`, `yaml` (lower layers only; `scripts/layers.json`)
- Fake it: Build an `EffectiveConfig` via `loadEffectiveConfig` from YAML strings; roles as `RoleDef` literals
