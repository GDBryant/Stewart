import type { Json, ToolCall, ToolSpec } from "@stewart/kernel";
import { splitShellPrograms, type ApprovalCategory, type ToolPreview } from "@stewart/permissions";
import type { RoleDef } from "@stewart/config";
import { decide, PATH_TOOLS, checkReadOnlyCommand, roleIsReadOnly, type Action } from "./policy.js";

export { checkReadOnlyCommand, roleIsReadOnly, PATH_TOOLS } from "./policy.js";

export interface Tool {
  readonly spec: ToolSpec;
  /** Gated tools produce a preview and require approval unless granted. */
  readonly requiresApproval: boolean;
  /** Explicit approval category override (e.g. MCP:<server>, TRACKER, GIT). */
  readonly category?: ApprovalCategory;
  /** True when execute only waits on the user: no timeout applies. */
  readonly awaitsUser?: boolean;
  /** True when execute runs other work that has its own limits (delegate, plan approval, milestone checks): the per-call tool timeout does not apply; cancellation still does. */
  readonly noTimeout?: boolean;
  /** Consecutive calls may run concurrently (session verbs such as delegate). */
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

/**
 * Weaker models often send an array argument as a JSON string (`"[\"a\",\"b\"]"`). Replace such a value, in place,
 * with the parsed array when the schema declares an array; anything else is left for validation to reject.
 */
export function coerceArrayArgs(args: Json, schema: Json): void {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  for (const [key, value] of Object.entries(args)) {
    if (props[key]?.type !== "array" || typeof value !== "string" || !value.trimStart().startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) args[key] = parsed as Json[];
    } catch {
      // not JSON: validateArgs reports the type error
    }
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
    const err = validateValue(value, prop, `argument '${key}' for ${name}`);
    if (err) return err;
  }
  return null;
}

function validateValue(value: unknown, schema: Json, label: string): string | null {
  const typeErr = typeError(value, schema);
  if (typeErr) return `${label}: ${typeErr}`;
  if (!enumMatches(value, schema)) return `${label}: value not in enum`;
  return validateNested(value, schema, label);
}

function enumMatches(value: unknown, schema: Json): boolean {
  const en = schema.enum as unknown[] | undefined;
  return !en || en.some((e) => JSON.stringify(e) === JSON.stringify(value));
}

/** Array items and nested object properties. */
function validateNested(value: unknown, schema: Json, label: string): string | null {
  const items = schema.items as Json | undefined;
  if (Array.isArray(value) && items && typeof items === "object") {
    const err = validateItems(value, items, label);
    if (err) return err;
  }
  if (typeMatches("object", value) && (schema.properties || schema.required)) {
    return validateArgs(value as Json, schema, label.replace(/^argument '([^']+)' for (.*)$/, "$2"));
  }
  return null;
}

function validateItems(values: unknown[], items: Json, label: string): string | null {
  for (const el of values) {
    const err = validateValue(el, items, label);
    if (err) return err;
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

function actionFor(tool: Tool, args: Json): Action {
  if (PATH_TOOLS.has(tool.spec.name) && typeof args.path === "string") return { kind: "write", path: args.path };
  if (tool.spec.name === "RunTerminal" && typeof args.command === "string") return { kind: "command", command: args.command };
  return { kind: "other" };
}

function guardRole(tool: Tool, role: RoleDef): Tool {
  const check = (args: Json) => {
    const d = decide(role, actionFor(tool, args));
    if (!d.allow) throw new Error(d.reason);
  };
  const basePreview = tool.preview?.bind(tool);
  const baseExec = tool.execute.bind(tool);
  return {
    ...tool,
    async preview(args: Json): Promise<ToolPreview | null> {
      check(args);
      return basePreview ? basePreview(args) : null;
    },
    async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string | { text: string; images?: string[] }> {
      check(args);
      return baseExec(args, preview, signal);
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
    return new ToolRegistry(allowed.map((t) => guardRole(t, role)));
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
    coerceArrayArgs(call.arguments as Json, tool.spec.parameters);
    return validateArgs(call.arguments as Json, tool.spec.parameters, call.name);
  }
  get specs(): ToolSpec[] {
    return this.tools.map((t) => t.spec);
  }
}
