import type { ToolCall } from "../channels/types.js";

/** What the approval UI shows before a gated tool runs. */
export type ToolPreview =
  | { kind: "file"; path: string; before: string | null; after: string }
  | { kind: "command"; command: string; cwd: string }
  | { kind: "other" };

export type ApprovalCategory = "EDITS" | "COMMANDS" | "OTHER" | (string & {});

export function categoryOf(preview: ToolPreview | null | undefined): ApprovalCategory | null {
  if (!preview) return null;
  if (preview.kind === "file") return "EDITS";
  if (preview.kind === "command") return "COMMANDS";
  if (preview.kind === "other") return "OTHER";
  return null;
}

export type Json = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  parameters: Json;
}

export interface Tool {
  readonly spec: ToolSpec;
  /** Gated tools produce a preview and require approval unless granted. */
  readonly requiresApproval: boolean;
  /** True when execute only waits on the user: no timeout applies. */
  readonly awaitsUser?: boolean;
  preview?(args: Json): Promise<ToolPreview | null>;
  execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string>;
}

export type ToolOutcome =
  | { kind: "success"; content: string }
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

function typeError(value: unknown, schema: Json): string | null {
  const t = schema.type;
  if (typeof t !== "string" && !Array.isArray(t)) return null;
  const types = Array.isArray(t) ? (t as string[]) : [t as string];
  const ok = types.some((ty) => {
    switch (ty) {
      case "string": return typeof value === "string";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "number": return typeof value === "number";
      case "boolean": return typeof value === "boolean";
      case "array": return Array.isArray(value);
      case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
      default: return true;
    }
  });
  return ok ? null : `expected type ${types.join("|")}`;
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();
  readonly tools: Tool[];
  constructor(tools: Tool[]) {
    this.tools = tools;
    for (const t of tools) this.byName.set(t.spec.name, t);
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
