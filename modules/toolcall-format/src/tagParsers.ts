import type { Json } from "@stewart/kernel";
import { cleanJsonBlock, decodeJsonObject, isObj, strictDecode } from "./jsonRepair.js";
import { ToolCallParseException, known, type SchemaMap } from "./types.js";

const PREFIX_NAME_RE = /^[A-Za-z_][\w.\-:]*$/;
const GEMMA_STR = '<|"|>';
const GEMMA_KEY_RE = /([{,]\s*)([A-Za-z_]\w*)\s*:/g;
const GEMMA_NAME_RE = /^\s*call:([A-Za-z_][\w.\-:]*)\s*\{/;

function toolProperties(schema: SchemaMap, name: string): Json {
  const props = known(name, schema) ? schema[name]?.["properties"] : undefined;
  return isObj(props) ? props : {};
}

function coerce(value: string, schemaProps: Json, key: string): unknown {
  const prop = schemaProps[key];
  const ptype = isObj(prop) ? prop["type"] : undefined;
  switch (ptype) {
    case "integer":
    case "number":
    case "array":
    case "object":
      try {
        return strictDecode(value);
      } catch {
        return value;
      }
    case "boolean": {
      const v = value.trim().toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
      return value;
    }
    default:
      return value;
  }
}

function trimOneNewline(v0: string): string {
  let v = v0;
  if (v.startsWith("\n")) v = v.slice(1);
  if (v.endsWith("\n")) v = v.slice(0, v.length - 1);
  return v;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Name of a JSON call: `name`, then a string `function`, then `function_name`. */
function jsonCallName(obj: Json, fn: unknown): string | undefined {
  return stringOrUndefined(obj["name"]) ?? stringOrUndefined(fn) ?? stringOrUndefined(obj["function_name"]);
}

function findJsonToolName(obj0: Json, prefix: string): [string, Json] {
  const fnRaw = obj0["function"];
  const obj = isObj(fnRaw) ? fnRaw : obj0;
  const name = jsonCallName(obj, isObj(fnRaw) ? undefined : fnRaw);
  if (name == null) {
    // No name: a prefix that is a valid tool name makes the whole object its arguments.
    if (PREFIX_NAME_RE.test(prefix)) return [prefix, { arguments: obj }];
    throw new ToolCallParseException("TC-NAME-MISSING");
  }
  if (name === "") throw new ToolCallParseException("TC-NAME-MISSING");
  return [name, obj];
}

function jsonCallArguments(obj: Json): Json {
  const hasArgs = "arguments" in obj || "parameters" in obj || "args" in obj;
  let args: unknown = hasArgs
    ? (obj["arguments"] ?? obj["parameters"] ?? obj["args"])
    : Object.fromEntries(Object.entries(obj).filter(([k]) => !["name", "function", "function_name"].includes(k)));
  if (typeof args === "string") {
    try {
      args = strictDecode(args);
    } catch {
      throw new ToolCallParseException("TC-ARGS-INVALID");
    }
  }
  if (!isObj(args)) throw new ToolCallParseException("TC-ARGS-INVALID");
  return args;
}

function parseJsonCall(raw: string, schema: SchemaMap): [string, Json] {
  const [obj, prefix] = decodeJsonObject(cleanJsonBlock(raw));
  const [name, obj2] = findJsonToolName(obj, prefix);
  return [name, jsonCallArguments(obj2)];
}

/**
 * Gemma tool-call body: `call:NAME{key:<|"|>value<|"|>,n:3}`. Strings are wrapped in <|"|>,
 * keys are bare. Converted to JSON segment by segment, never via repairJson.
 */
export function parseGemma(raw: string): [string, Json] {
  const m = GEMMA_NAME_RE.exec(raw);
  if (!m) throw new ToolCallParseException("TC-GEMMA-NO-CALL");
  const brace = m.index + m[0].length - 1;
  const close = raw.lastIndexOf("}");
  if (close < brace) throw new ToolCallParseException("TC-GEMMA-INVALID");
  return [m[1], decodeGemmaObject(raw.slice(brace, close + 1))];
}

function decodeGemmaObject(body: string): Json {
  const parts = body.split(GEMMA_STR);
  // An even delimiter count leaves a string unclosed.
  if (parts.length % 2 === 0) throw new ToolCallParseException("TC-GEMMA-INVALID");
  let out = "";
  parts.forEach((seg, k) => {
    out += k % 2 === 1 ? JSON.stringify(seg) : seg.replace(GEMMA_KEY_RE, '$1"$2":');
  });
  let obj: unknown;
  try {
    obj = strictDecode(out);
  } catch {
    throw new ToolCallParseException("TC-GEMMA-INVALID");
  }
  if (!isObj(obj)) throw new ToolCallParseException("TC-ARGS-INVALID");
  return obj;
}

const PARAM_RE = /<parameter=([^>]*)>([\s\S]*?)<\/parameter>/g;
const FUNC_HEADER_RE = /<function=([^>]*)>/;

function parseFunctionBlock(raw: string, schema: SchemaMap): [string, Json] {
  const m = FUNC_HEADER_RE.exec(raw);
  if (!m) throw new ToolCallParseException("TC-FUNC-NO-HEADER");
  const name = m[1].trim();
  const props = toolProperties(schema, name);
  const args: Json = {};
  PARAM_RE.lastIndex = 0;
  const body = raw.slice(m.index + m[0].length);
  let pm: RegExpExecArray | null;
  while ((pm = PARAM_RE.exec(body))) {
    const key = pm[1].trim();
    args[key] = coerce(trimOneNewline(pm[2]), props, key);
  }
  return [name, args];
}

const GLM_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*(?:<arg_value>)?([\s\S]*?)(?:<\/arg_value>|(?=<arg_key>)|$)/g;
const GLM_BAD_KEY_RE = /(?:<\/arg_key>\s*)?<arg_value>([^<]*?)<\/arg_value>/g;

function parseGlmBlock(raw0: string, schema: SchemaMap): [string, Json] {
  const raw = raw0.replace(GLM_BAD_KEY_RE, (_m, g1: string) => `<arg_key>${g1}</arg_key>`);
  const parts = raw.trim().split("<arg_key>");
  const name = parts[0].trim();
  const rest = parts.length > 1 ? parts.slice(1).join("<arg_key>") : "";
  if (name === "" || name.startsWith("<")) throw new ToolCallParseException("TC-GLM-NO-NAME");
  const props = toolProperties(schema, name);
  const args: Json = {};
  GLM_ARG_RE.lastIndex = 0;
  const body = `<arg_key>${rest}`;
  let m: RegExpExecArray | null;
  while ((m = GLM_ARG_RE.exec(body))) {
    const key = m[1].trim();
    args[key] = coerce(trimOneNewline(m[2]), props, key);
  }
  return [name, args];
}

export function parseBlock(raw: string, schema: SchemaMap): [string, Json] {
  if (raw.includes("<function=")) return parseFunctionBlock(raw, schema);
  if (raw.includes("<arg_key>") || raw.includes("</arg_key>")) return parseGlmBlock(raw, schema);
  return parseJsonCall(raw, schema);
}

const EXEC_TOOL = "RunTerminal";
const EXEC_ALIASES = new Set([
  "execute_command", "run_command", "execute_commands", "execute", "exec", "bash", "shell",
  "run_shell", "run_terminal_cmd", "terminal", "run_commands",
]);

function commandList(args: Json): string[] | null {
  const cmds = args["commands"] ?? args["command"] ?? args["cmd"];
  let list: unknown[] | null = null;
  if (typeof cmds === "string") list = [cmds];
  if (Array.isArray(cmds)) list = cmds;
  if (list == null || list.length === 0) return null;
  if (!list.every((c) => typeof c === "string" && (c as string).trim() !== "")) return null;
  return list as string[];
}

export function normalizeCall(parsed: [string, Json], schema: SchemaMap): [string, Json] {
  const [name, args] = parsed;
  if (known(name, schema) || !EXEC_ALIASES.has(name) || !known(EXEC_TOOL, schema)) return parsed;
  const cmds = commandList(args);
  if (cmds == null || cmds.length !== 1) return parsed;
  return [EXEC_TOOL, { command: cmds[0] }];
}

export function readCall(raw: string, schema: SchemaMap): [string, Json] | null {
  try {
    return normalizeCall(parseBlock(raw, schema), schema);
  } catch (e) {
    if (e instanceof ToolCallParseException) return null;
    throw e;
  }
}
