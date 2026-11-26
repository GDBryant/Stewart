import type { RoleDef } from "@stewart/config";
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

function skillLine(s: ResolvedSkill): string {
  return `- ${s.id}: ${s.description || s.body.split("\n")[0]}`;
}

/** Exploration discipline appended to every lead prompt (also for roles.yaml files written before this rule existed). */
export const EXPLORATION_RULES =
  "# Exploration\nFind code with Search and FindFiles, not shell sweeps: never loop over every jar or file with unzip, find -exec or xargs. Batch independent reads in one turn (read-only tools run concurrently). If a few targeted searches do not find it, report what you found and ask the user instead of probing further. For a project or folder health check, load_skill project-health first, get the file batches from health_batches and delegate them; never write scripts or batch files yourself.";

/** lead.prompt + exploration rules + one-line skill index + bounded project notes. Skill bodies load via the load_skill tool. */
export async function systemPrompt(host: Pick<HostPort, "files" | "workspace">, lead: RoleDef, config: EffectiveConfig): Promise<string> {
  const skills = lead.skills
    .map((id) => config.skills.find((s) => s.id === id))
    .filter((s): s is ResolvedSkill => !!s);
  const index = skills.map(skillLine).join("\n");
  const notes = (await loadProjectContext(host)).slice(0, PROJECT_NOTES_CAP);
  return `${lead.prompt ?? ""}\n\n${EXPLORATION_RULES}\n\n# Skills\n${index ? `${index}\n` : ""}Load one with load_skill before following it.${notes}`;
}
