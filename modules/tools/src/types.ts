import type { Json, ToolCall, ToolSpec } from "@stewart/kernel";
import { splitShellPrograms, type ApprovalCategory, type ToolPreview } from "@stewart/permissions";
import type { RoleDef } from "@stewart/config";
import { matchGlob } from "@stewart/roles-skills";

export interface Tool {
  readonly spec: ToolSpec;
  /** Gated tools produce a preview and require approval unless granted. */
  readonly requiresApproval: boolean;
  /** Explicit approval category override (e.g. MCP:<server>, TRACKER, GIT). */
  readonly category?: ApprovalCategory;
  /** True when execute only waits on the user: no timeout applies. */
  readonly awaitsUser?: boolean;
  /** Core-handled orchestration verb: never a channel side effect. */
  readonly coreHandled?: boolean;
  /** Consecutive calls may run concurrently (orchestration verbs only). */
  readonly parallel?: boolean;
  preview?(args: Json): Promise<ToolPreview | null>;
  /** Text result, or text plus base64 image payloads (`data:` URIs) for vision models. */
  execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string | { text: string; images?: string[] }>;
}

/** External tool provider plugin seam (e.g. MCP server). */
export interface ToolProvider {
  readonly id: string;
  readonly category?: ApprovalCategory;
  tools(): Tool[];
}

export type ToolOutcome =
  | { kind: "success"; content: string; images?: string[] }
  | { kind: "failure"; message: string }
  | { kind: "rejected"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "uncertain"; reason: string };

export const UNCERTAIN_PREFIX = "Outcome uncertain:";
export const NOT_ANSWERED_CANCELLED = "Not answered: cancelled";

export function outcomeMessage(o: ToolOutcome): string {
  switch (o.kind) {
    case "success": return o.content;
    case "failure": return `Error: ${o.message}`;
    case "rejected": return `Rejected by user: ${o.reason}`;
    case "invalid": return `Invalid tool call: ${o.reason}`;
    case "uncertain": return `${UNCERTAIN_PREFIX} ${o.reason}`;
  }
}

/** Minimal JSON-Schema subset validator (required, properties, type, enum, additionalProperties). */
export function validateArgs(args: Json, schema: Json, name: string): string | null {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = (schema.required as string[] | undefined) ?? [];
  for (const req of required) if (!(req in args)) return `missing required argument '${req}' for ${name}`;
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unexpected argument '${key}' for ${name}`;
      continue;
    }
    const typeErr = typeError(value, prop);
    if (typeErr) return `argument '${key}' for ${name}: ${typeErr}`;
    const en = prop.enum as unknown[] | undefined;
    if (en && !en.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `argument '${key}' for ${name}: value not in enum`;
  }
  return null;
}

function typeMatches(ty: string, value: unknown): boolean {
  switch (ty) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return true;
  }
}

function typeError(value: unknown, schema: Json): string | null {
  const t = schema.type;
  if (typeof t !== "string" && !Array.isArray(t)) return null;
  const types = Array.isArray(t) ? (t as string[]) : [t as string];
  const ok = types.some((ty) => typeMatches(ty, value));
  return ok ? null : `expected type ${types.join("|")}`;
}

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

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();
  readonly tools: Tool[];
  constructor(tools: Tool[]) {
    this.tools = [...tools];
    for (const t of tools) this.byName.set(t.spec.name, t);
  }
  /**
   * The role's effective registry: tools filtered to its list (enforced in core,
   * not just the prompt). Empty tools list means unrestricted. Write tools are
   * wrapped so a path outside `writePaths` fails before the preview is produced.
   */
  for(role: RoleDef): ToolRegistry {
    const allowed = role.tools.length ? this.tools.filter((t) => role.tools.includes(t.spec.name)) : this.tools;
    return new ToolRegistry(allowed.map((t) => guardInvestigatorTerminal(guardWritePaths(t, role.writePaths), role.id)));
  }
  registerProvider(provider: ToolProvider): void {
    const defaultCat: ApprovalCategory = provider.category ?? `MCP:${provider.id}`;
    for (const raw of provider.tools()) {
      const cat = raw.category ?? defaultCat;
      const wrapped: Tool = {
        ...raw,
        category: cat,
        preview: raw.preview
          ? raw.preview.bind(raw)
          : raw.requiresApproval
            ? async () => ({ kind: "other", category: cat })
            : undefined,
        execute: raw.execute.bind(raw),
      };
      this.tools.push(wrapped);
      this.byName.set(wrapped.spec.name, wrapped);
    }
  }
  find(name: string): Tool | undefined {
    return this.byName.get(name);
  }
  validate(call: ToolCall): string | null {
    const tool = this.byName.get(call.name);
    if (!tool) return `unknown tool '${call.name}'`;
    return validateArgs(call.arguments as Json, tool.spec.parameters, call.name);
  }
  get specs(): ToolSpec[] {
    return this.tools.map((t) => t.spec);
  }
}
