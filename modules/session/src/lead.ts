import type { AgentDef, RoleDef } from "@stewart/config";
import type { HostPort } from "@stewart/kernel";
import { loadProjectContext } from "@stewart/context";
import type { EffectiveConfig, ResolvedSkill } from "@stewart/roles-skills";

const PROJECT_NOTES_CAP = 8000;

/** The session's role; throws when the shipped `lead` entry was removed or disabled. */
export function leadRole(config: EffectiveConfig): RoleDef {
  const r = config.roles.find((r) => r.id === "lead");
  if (!r) throw new Error("role 'lead' not configured");
  if (!r.enabled) throw new Error("role 'lead' is disabled");
  return r;
}

/** Agent for the lead turn: lead's own binding, else the first configured agent. */
export function leadAgent(config: EffectiveConfig, lead: RoleDef): AgentDef {
  for (const id of [lead.agent, config.agents[0]?.id]) {
    const a = config.agents.find((x) => x.id === id);
    if (a) return a;
  }
  throw new Error("no agent configured: add one in agents.yaml or bind one to the lead role");
}

function skillLine(s: ResolvedSkill): string {
  return `- ${s.id}: ${s.description || s.body.split("\n")[0]}`;
}

/** lead.prompt + one-line skill index + bounded project notes. Skill bodies load via the load_skill tool. */
export async function systemPrompt(host: Pick<HostPort, "files" | "workspace">, lead: RoleDef, config: EffectiveConfig): Promise<string> {
  const skills = lead.skills
    .map((id) => config.skills.find((s) => s.id === id))
    .filter((s): s is ResolvedSkill => !!s);
  const index = skills.map(skillLine).join("\n");
  const notes = (await loadProjectContext(host)).slice(0, PROJECT_NOTES_CAP);
  return `${lead.prompt ?? ""}\n\n# Skills\n${index ? `${index}\n` : ""}Load one with load_skill before following it.${notes}`;
}
