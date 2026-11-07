import type { Json, ToolCall, ToolSpec } from "@stewart/kernel";

/** What the approval UI shows before a gated tool runs. */
export type ToolPreview =
  | { kind: "file"; path: string; before: string | null; after: string }
  | { kind: "command"; command: string; cwd: string }
  | { kind: "other"; category?: ApprovalCategory };

export type ApprovalCategory = "EDITS" | "COMMANDS" | "OTHER" | (string & {});

export function categoryOf(preview: ToolPreview | null | undefined, tool?: { category?: ApprovalCategory }): ApprovalCategory | null {
  if (tool?.category) return tool.category;
  if (!preview) return null;
  if (preview.kind === "file") return "EDITS";
  if (preview.kind === "command") return "COMMANDS";
  if (preview.kind === "other") return preview.category ?? "OTHER";
  return null;
}

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
    this.tools = [...tools];
    for (const t of tools) this.byName.set(t.spec.name, t);
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
