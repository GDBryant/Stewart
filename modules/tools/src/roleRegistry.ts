import type { Json } from "@stewart/kernel";
import type { RoleDef } from "@stewart/config";
import { matchGlob } from "@stewart/roles-skills";
import { splitShellPrograms, type ToolPreview } from "@stewart/permissions";
import { ToolRegistry, type Tool } from "./types.js";

/** File-writing tools whose `path` arg is checked against role writePaths. */
export const PATH_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);

const INVESTIGATOR_READONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "find", "grep", "rg", "git",
  "pwd", "which", "echo", "uname", "printenv", "diff", "du", "df",
]);
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe",
]);

export function checkInvestigatorCommand(command: string): void {
  if (/[><]/.test(command)) {
    throw new Error(`command '${command}' is not allowed for read-only role investigator`);
  }
  const progs = splitShellPrograms(command);
  if (!progs || !progs.every((p) => INVESTIGATOR_READONLY_PROGRAMS.has(p))) {
    throw new Error(`command '${command}' is not allowed for read-only role investigator`);
  }
  for (const seg of command.split(/[|;&\n]+/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (words[0] === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) {
        throw new Error(`git subcommand '${sub ?? ""}' is not allowed for read-only role investigator`);
      }
    }
  }
}

function guardInvestigatorTerminal(tool: Tool, roleId: string): Tool {
  if (roleId !== "investigator" || tool.spec.name !== "RunTerminal") return tool;
  const basePreview = tool.preview?.bind(tool);
  const baseExec = tool.execute.bind(tool);
  return {
    ...tool,
    async preview(args: Json): Promise<ToolPreview | null> {
      if (typeof args.command === "string") checkInvestigatorCommand(args.command);
      return basePreview ? basePreview(args) : null;
    },
    async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string | { text: string; images?: string[] }> {
      if (typeof args.command === "string") checkInvestigatorCommand(args.command);
      return baseExec(args, preview, signal);
    },
  };
}

function guardWritePaths(tool: Tool, writePaths: string[]): Tool {
  if (!PATH_TOOLS.has(tool.spec.name) || !tool.preview) return tool;
  const base = tool.preview.bind(tool);
  return {
    spec: tool.spec,
    requiresApproval: tool.requiresApproval,
    category: tool.category,
    awaitsUser: tool.awaitsUser,
    coreHandled: tool.coreHandled,
    parallel: tool.parallel,
    execute: tool.execute.bind(tool),
    async preview(args: Json): Promise<ToolPreview | null> {
      const p = args.path;
      if (writePaths.length && typeof p === "string" && !writePaths.some((g) => matchGlob(g, p))) {
        throw new Error(`path '${p}' is outside this role's writePaths`);
      }
      return base(args);
    },
  };
}

/**
 * The role's effective registry: tools filtered to its list (enforced in core,
 * not just the prompt). Empty tools list means unrestricted. Write tools are
 * wrapped so a path outside `writePaths` fails before the preview is produced.
 */
export function roleRegistry(registry: ToolRegistry, role: RoleDef): ToolRegistry {
  const allowed = role.tools.length ? registry.tools.filter((t) => role.tools.includes(t.spec.name)) : registry.tools;
  return new ToolRegistry(allowed.map((t) => guardInvestigatorTerminal(guardWritePaths(t, role.writePaths), role.id)));
}
