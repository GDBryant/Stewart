import type { Json, ToolCall } from "@stewart/kernel";

export const FAILURE_REASONS: Record<string, string> = {
  "TC-JSON-NO-OBJECT": "block contains no '{' so there is no JSON to read",
  "TC-JSON-INVALID": "JSON could not be decoded, even after repair",
  "TC-JSON-NOT-OBJECT": "JSON decoded but is not an object (expected {...})",
  "TC-NAME-MISSING": "no tool name found (no name/function key and no name before the '{')",
  "TC-GLM-NO-NAME": "GLM-style block has no tool name before the first <arg_key>",
  "TC-FUNC-NO-HEADER": "<function=NAME> header is missing or malformed",
  "TC-ARGS-INVALID": "arguments must be a JSON object",
  "TC-NATIVE-INVALID": "native call must name an offered function with valid arguments",
  "TC-GEMMA-NO-CALL": "Gemma-style block does not start with call:NAME{",
  "TC-GEMMA-INVALID": "Gemma-style arguments are not well-formed",
  "TC-UNKNOWN-TOOL": "tool name is not one of the offered tools",
  "TC-PARSE": "unexpected parse failure",
};

export class ToolCallParseException extends Error {
  constructor(readonly code: string, readonly detail = "") {
    super(code);
    this.name = "ToolCallParseException";
  }
}

/** A call-like block that could not become an executable call. Fed back to the model. */
export interface ParseError {
  code: string;
  message: string;
}

export interface ParseResult {
  clean: string;
  calls: ToolCall[];
  reasoning: string | null;
  errors: ParseError[];
}

export type SchemaMap = Record<string, Json>;

let idCounter = 0;
export function newCallId(): string {
  idCounter = (idCounter + 1) % 0xffffffff;
  return `call_${Date.now().toString(16)}${idCounter.toString(16).padStart(4, "0")}`;
}

export function known(name: string, schema: SchemaMap): boolean {
  return Object.prototype.hasOwnProperty.call(schema, name);
}
