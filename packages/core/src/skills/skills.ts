import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SKILLS, EXECUTION_CONTRACT, SIDE_EFFECT_TOOLS, type ShippedSkill } from "../defaults/skills.js";
import { DEFAULT_ROLES_YAML } from "../defaults/roles.js";
import type { ConfigLayer } from "../config/loader.js";
import type { RoleDef } from "../config/schema.js";

export interface SkillMeta {
  id: string;
  description: string;
  defaultRoles: string[];
  version: number;
  baseHash?: string;
}

export interface ResolvedSkill {
  id: string;
  description: string;
  defaultRoles: string[];
  version: number;
  body: string;
  source: "shipped" | "user" | "project";
  /** User override differs from the shipped body it was based on. */
  edited: boolean;
  /** Shipped body changed since the user's baseHash — offer the diff. */
  updateAvailable: boolean;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** Parse SKILL.md: YAML frontmatter between --- fences, then body. */
export function parseSkillMd(text: string, fallbackId: string): { meta: SkillMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: { id: fallbackId, description: "", defaultRoles: [], version: 1 }, body: text.trim() };
  const fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  return {
    meta: {
      id: typeof fm.id === "string" ? fm.id : fallbackId,
      description: typeof fm.description === "string" ? fm.description : "",
      defaultRoles: Array.isArray(fm.defaultRoles) ? fm.defaultRoles.filter((r): r is string => typeof r === "string") : [],
      version: typeof fm.version === "number" ? fm.version : 1,
      baseHash: typeof fm.baseHash === "string" ? fm.baseHash : undefined,
    },
    body: m[2].trim(),
  };
}

export function serializeSkillMd(meta: SkillMeta, body: string): string {
  return `---\n${stringifyYaml({ id: meta.id, description: meta.description, defaultRoles: meta.defaultRoles, version: meta.version, ...(meta.baseHash ? { baseHash: meta.baseHash } : {}) }).trim()}\n---\n${body.trim()}\n`;
}

const SKILL_KEY = /^skills\/(.+)\.md$/;

let shippedRoles: RoleDef[] | undefined;

/** Roles in the shipped roles.yaml that tick this skill by default. */
export function shippedDefaultRoles(skillId: string): string[] {
  shippedRoles ??= (parseYaml(DEFAULT_ROLES_YAML) as { items?: RoleDef[] }).items ?? [];
  return shippedRoles.filter((r) => r.skills.includes(skillId)).map((r) => r.id);
}

function layerSkills(layer: ConfigLayer | undefined): { key: string; id: string; text: string }[] {
  if (!layer) return [];
  return Object.entries(layer)
    .map(([key, text]) => {
      const m = SKILL_KEY.exec(key);
      return m && text !== undefined ? { key, id: m[1], text } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * Resolve skills: shipped < user file < project file. Copy-on-write: a user file
 * whose body still matches its baseHash silently tracks the shipped body
 * (auto-upgrade); an edited one keeps its body and shows updateAvailable.
 */
export function resolveSkills(user: ConfigLayer, project: ConfigLayer | undefined): ResolvedSkill[] {
  const shipped = new Map<string, ShippedSkill>(DEFAULT_SKILLS.map((s) => [s.id, s]));
  const out = new Map<string, ResolvedSkill>();
  for (const s of DEFAULT_SKILLS) {
    out.set(s.id, { id: s.id, description: s.description, defaultRoles: shippedDefaultRoles(s.id), version: s.version, body: s.body, source: "shipped", edited: false, updateAvailable: false });
  }
  for (const { id, text } of layerSkills(user)) {
    const { meta, body } = parseSkillMd(text, id);
    const shippedSkill = shipped.get(meta.id);
    if (shippedSkill && meta.baseHash) {
      if (hashBody(body) === meta.baseHash) {
        // Unedited copy: track the shipped body.
        continue;
      }
      out.set(meta.id, {
        id: meta.id, description: meta.description, defaultRoles: meta.defaultRoles, version: meta.version, body,
        source: "user", edited: true, updateAvailable: meta.baseHash !== hashBody(shippedSkill.body),
      });
    } else {
      out.set(meta.id, { id: meta.id, description: meta.description, defaultRoles: meta.defaultRoles, version: meta.version, body, source: "user", edited: false, updateAvailable: false });
    }
  }
  for (const { id, text } of layerSkills(project)) {
    const { meta, body } = parseSkillMd(text, id);
    out.set(meta.id, { id: meta.id, description: meta.description, defaultRoles: meta.defaultRoles, version: meta.version, body, source: "project", edited: false, updateAvailable: false });
  }
  return [...out.values()];
}

export function shippedSkill(id: string): ShippedSkill | undefined {
  return DEFAULT_SKILLS.find((s) => s.id === id);
}

/** Body a user override should record as its baseHash (the shipped body it derives from). */
export function baseHashFor(id: string): string | undefined {
  const s = shippedSkill(id);
  return s ? hashBody(s.body) : undefined;
}

export const CHARS_PER_TOKEN = 4;
export const TRUNCATED_MARKER = "\n[skill truncated — increase skillBudgetTokens]";

/**
 * Compose the role system prompt: role prompt first, then ticked skills in tick
 * order, bounded by budgetTokens. execution-contract is force-included for any
 * role holding write/command tools and cannot be unticked.
 */
export function composeRolePrompt(role: RoleDef, skills: ResolvedSkill[], budgetTokens: number): { prompt: string; truncated: boolean } {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const ticked = [...role.skills];
  const hasWrite = role.tools.some((t) => SIDE_EFFECT_TOOLS.has(t));
  if (hasWrite && !ticked.includes(EXECUTION_CONTRACT)) ticked.push(EXECUTION_CONTRACT);
  const budget = budgetTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  if (role.prompt) parts.push(role.prompt.trim());
  let used = parts.join("\n\n").length;
  let truncated = false;
  for (const id of ticked) {
    const s = byId.get(id);
    if (!s) continue;
    const block = `# Skill: ${s.id}\n${s.body}`;
    if (used + block.length + 2 <= budget) {
      parts.push(block);
      used += block.length + 2;
    } else {
      const room = budget - used - TRUNCATED_MARKER.length - 2;
      if (room > 0) parts.push(block.slice(0, room) + TRUNCATED_MARKER);
      truncated = true;
      break;
    }
  }
  return { prompt: parts.join("\n\n"), truncated };
}
