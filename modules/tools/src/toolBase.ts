import type { HostPort, Json, ToolSpec } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import { ProjectPaths } from "./projectPaths.js";
import { type Tool } from "./types.js";

export function arg(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing '${key}'`);
  return v;
}

export function optInt(args: Json, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

export function optBool(args: Json, key: string): boolean {
  return args[key] === true;
}

export function schema(props: Record<string, Json>, required: string[]): Json {
  return { type: "object", properties: props, required, additionalProperties: false };
}

export const str: Json = { type: "string" };
export const int: Json = { type: "integer" };
export const bool: Json = { type: "boolean" };

export abstract class ProjectTool implements Tool {
  constructor(protected host: Pick<HostPort, "diag" | "files" | "proc">, protected paths: ProjectPaths) {}
  abstract spec: ToolSpec;
  abstract requiresApproval: boolean;
  readonly awaitsUser = false;
  abstract execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string | { text: string; images?: string[] }>;
}
