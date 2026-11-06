import type { ToolSpec } from "./types.js";

function sampleValue(schema: unknown): unknown {
  const type = typeof schema === "object" && schema !== null ? (schema as { type?: unknown }).type : undefined;
  switch (type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "example";
  }
}

/** One-line example call for the first tool, built from its required parameters. */
export function shimExampleCall(spec: ToolSpec): string {
  const props = (spec.parameters.properties ?? {}) as Record<string, unknown>;
  const required = (spec.parameters.required as string[] | undefined) ?? [];
  const args = Object.fromEntries(required.map((k) => [k, sampleValue(props[k])]));
  return `<tool_call>${JSON.stringify({ name: spec.name, arguments: args })}</tool_call>`;
}

/**
 * System-prompt block that tells a shim-mode model which tools exist and how to call them.
 * Returns null when there are no tools, so no block is injected.
 */
export function buildToolsBlock(specs: ToolSpec[]): string | null {
  if (specs.length === 0) return null;
  const listing = specs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }));
  return [
    "<tools>",
    "You can call the tools listed below. Available tools (JSON):",
    JSON.stringify(listing),
    "",
    "To call a tool, emit one block per call, with a JSON object inside:",
    '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    "Also accepted: the same JSON wrapped in <call>...</call>, or <function=TOOL_NAME><parameter=ARG>value</parameter></function>.",
    "Rules:",
    "- Use only the tool names listed above. Arguments must match that tool's parameters schema.",
    "- Put only the JSON object inside the tags. Do not wrap calls in code fences.",
    "- After your calls, stop. Results arrive in the next message.",
    `- Example: ${shimExampleCall(specs[0])}`,
    "</tools>",
  ].join("\n");
}
