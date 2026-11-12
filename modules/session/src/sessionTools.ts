import { questionPrompt, type Interaction } from "@stewart/interaction";
import { NOT_ANSWERED_CANCELLED, type Tool } from "@stewart/tools";
import type { ResolvedSkill } from "@stewart/roles-skills";

/** `load_skill({id})`: returns one skill's body on demand; unknown id lists the resolvable ids. */
export function loadSkillTool(skills: ResolvedSkill[]): Tool {
  return {
    spec: {
      name: "load_skill",
      description: "Load the full text of a skill listed in the system prompt.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    requiresApproval: false,
    execute: async (args) => {
      const id = String(args.id ?? "");
      const s = skills.find((x) => x.id === id);
      if (!s) throw new Error(`unknown skill '${id}'. Available: ${skills.map((x) => x.id).join(", ") || "none"}`);
      return `# Skill: ${s.id}\n${s.body}`;
    },
  };
}

/** `ask_user({question, options?})`: a question card on the shared Interaction; no timeout applies. */
export function askUserTool(interaction: Interaction, runId: string): Tool {
  return {
    spec: {
      name: "ask_user",
      description: "Ask the user a question and wait for the answer.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    requiresApproval: false,
    awaitsUser: true,
    execute: async (args, _preview, signal) => {
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : undefined;
      const o = await interaction.ask(questionPrompt("ask_user", String(args.question), options), { runId, roleId: "lead" }, signal);
      return o.kind === "answered" ? o.value : NOT_ANSWERED_CANCELLED;
    },
  };
}

/** What the lead declared for this turn's check: a command that must exit 0, extra files that must exist. */
export interface DeclaredCheck {
  command?: string[];
  files?: string[];
}

/** `set_check({command?, files?})`: the lead states how code should verify this turn; the command needs approval. */
export function setCheckTool(declared: { value?: DeclaredCheck }): Tool {
  return {
    spec: {
      name: "set_check",
      description: "Declare how this turn is verified by code after you stop: a command (argv array) that must exit 0 (tests, typecheck, lint), and optionally files that must exist.",
      parameters: {
        type: "object",
        properties: { command: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    requiresApproval: true,
    preview: async (args) => {
      const argv = Array.isArray(args.command) ? (args.command as unknown[]).map(String) : [];
      return { kind: "command", command: argv.join(" "), cwd: "." };
    },
    execute: async (args) => {
      const command = Array.isArray(args.command) ? (args.command as unknown[]).map(String).filter(Boolean) : undefined;
      const files = Array.isArray(args.files) ? (args.files as unknown[]).map(String).filter(Boolean) : undefined;
      if (!command?.length) throw new Error("set_check needs a command (argv array)");
      declared.value = { command, files: files?.length ? files : undefined };
      return "check set";
    },
  };
}
