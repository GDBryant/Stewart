import { type Json } from "@stewart/kernel";
import { ToolRegistry, type Tool, type ToolPreview } from "./tools/types.js";
import { splitShellPrograms } from "./tools/approvals.js";
import type { AgentDef, ChannelDef, RoleDef } from "./config/schema.js";
import { resolveModelProfile } from "@stewart/models";

/** Glob match: `**` crosses directories, `*` and `?` stay within a segment. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  const re = globToRegex(pattern);
  return re.test(p);
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&");
  const body = esc
    .split("**")
    .map((seg) => seg.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp("^" + body + "$");
}

/** File-writing tools whose `path` arg is checked against role writePaths. */
const PATH_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);

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

export const WRITE_ROLE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "RunTerminal", "GenerateImage"]);
export const READONLY_ROLES = new Set(["orchestrator", "planner", "plan-validator", "investigator", "code-reviewer", "code-health-reviewer", "image-reader"]);

/** Write-capable roles run as workers: eligible for the continue question and splits. */
export function isWriteCapableRole(role: RoleDef): boolean {
  if (READONLY_ROLES.has(role.id)) return false;
  if (role.tools.length === 0) return true;
  return role.tools.some((t) => WRITE_ROLE_TOOLS.has(t));
}

/** Loop turn cap from the role ("unlimited" → effectively unbounded). */
export function roleTurnBudget(role: RoleDef): number {
  return role.turnBudget === "unlimited" ? Number.MAX_SAFE_INTEGER : role.turnBudget;
}

/** Capability an agent must have to serve a role (undefined = any agent). */
export const ROLE_CAPABILITY: Record<string, "vision" | "imageGen"> = {
  "image-reader": "vision",
  "image-writer": "imageGen",
};

export function roleCapability(roleId: string): "vision" | "imageGen" | undefined {
  return ROLE_CAPABILITY[roleId];
}

/** Capability flags for an agent's model, from its channel's modelCaps. */
export function agentCapability(agent: AgentDef, channels: ChannelDef[]): Record<string, boolean> {
  return resolveModelProfile({ channels }, { channel: agent.channel, model: agent.model }).caps as Record<string, boolean>;
}

export function agentServesRole(agent: AgentDef, channels: ChannelDef[], roleId: string): boolean {
  const cap = roleCapability(roleId);
  return !cap || agentCapability(agent, channels)[cap] === true;
}

/**
 * Configuration errors for roles. An enabled role must have an agent bound (no
 * silent fallback), the Orchestrator must be enabled once another role is, and
 * capability roles must point at a capable agent.
 */
export function validateRoles(roles: RoleDef[], agents: AgentDef[], channels: ChannelDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const enabled = roles.filter((r) => r.enabled);
  for (const r of enabled) {
    if (!r.agent) errors.push(`role ${r.id}: enabled but no agent bound`);
    else {
      const agent = byId.get(r.agent);
      if (!agent) errors.push(`role ${r.id}: unknown agent '${r.agent}'`);
      else if (!agentServesRole(agent, channels, r.id)) errors.push(`role ${r.id}: agent '${r.agent}' lacks ${roleCapability(r.id)}`);
    }
    if (r.fallbackAgent) {
      const fb = byId.get(r.fallbackAgent);
      if (!fb) errors.push(`role ${r.id}: unknown fallbackAgent '${r.fallbackAgent}'`);
      else if (!agentServesRole(fb, channels, r.id)) errors.push(`role ${r.id}: fallbackAgent '${r.fallbackAgent}' lacks ${roleCapability(r.id)}`);
    }
  }
  const orchestrator = roles.find((r) => r.id === "orchestrator");
  if (enabled.some((r) => r.id !== "orchestrator") && !orchestrator?.enabled) {
    errors.push("orchestrator: required when another role is enabled");
  }
  return errors;
}
