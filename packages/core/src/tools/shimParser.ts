import type { ToolCall } from "../channels/types.js";
import type { Json } from "./types.js";

export const FAILURE_REASONS: Record<string, string> = {
  "TC-JSON-NO-OBJECT": "block contains no '{' so there is no JSON to read",
  "TC-JSON-INVALID": "JSON could not be decoded, even after repair",
  "TC-JSON-NOT-OBJECT": "JSON decoded but is not an object (expected {...})",
  "TC-NAME-MISSING": "no tool name found (no name/function key and no name before the '{')",
  "TC-GLM-NO-NAME": "GLM-style block has no tool name before the first <arg_key>",
  "TC-FUNC-NO-HEADER": "<function=NAME> header is missing or malformed",
  "TC-ARGS-INVALID": "arguments must be a JSON object",
  "TC-NATIVE-INVALID": "native call must name an offered function with valid arguments",
};

export class ToolCallParseException extends Error {
  constructor(readonly code: string, readonly detail = "") {
    super(code);
    this.name = "ToolCallParseException";
  }
}

export interface ParseResult {
  clean: string;
  calls: ToolCall[];
  reasoning: string | null;
}

export type SchemaMap = Record<string, Json>;

const TAG_RE = /<tool_call>|<call>|<function=[^>]*>/g;
const CLOSERS: Record<string, string | undefined> = {
  "<tool_call>": "</tool_call>",
  "<call>": "</call>",
};
const PREFIX_NAME_RE = /^[A-Za-z_][\w.\-:]*$/;
const BARE_LITERAL_RE = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const FENCE_RE = /```/g;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

let idCounter = 0;
export function newCallId(): string {
  idCounter = (idCounter + 1) % 0xffffffff;
  return `call_${Date.now().toString(16)}${idCounter.toString(16).padStart(4, "0")}`;
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkStrict(el: unknown): void {
  if (el === null) return;
  if (typeof el === "number") {
    if (!Number.isFinite(el)) throw new Error("non-JSON literal");
    return;
  }
  if (typeof el === "boolean" || typeof el === "string") return;
  if (Array.isArray(el)) {
    el.forEach(checkStrict);
    return;
  }
  if (isObj(el)) {
    Object.values(el).forEach(checkStrict);
    return;
  }
  throw new Error("non-JSON literal");
}

function strictDecode(text: string): unknown {
  const el = JSON.parse(text) as unknown;
  checkStrict(el);
  return el;
}

export function parseToolCalls(text: string, schema: SchemaMap, startInFence = false): ParseResult {
  const [stripped, reasoning] = stripThink(text);
  const calls: ToolCall[] = [];
  const cleanParts: string[] = [];
  let pos = 0;
  let fenceCount = startInFence ? 1 : 0;
  TAG_RE.lastIndex = 0;
  while (true) {
    TAG_RE.lastIndex = pos;
    const m = TAG_RE.exec(stripped);
    if (!m) {
      const tail = stripped.slice(pos);
      fenceCount += countFences(tail);
      cleanParts.push(tail);
      break;
    }
    const before = stripped.slice(pos, m.index);
    fenceCount += countFences(before);
    cleanParts.push(before);
    const fenced = fenceCount % 2 === 1 || (m.index > 0 && stripped[m.index - 1] === "`");
    if (fenced) {
      cleanParts.push(m[0]);
      pos = m.index + m[0].length;
      continue;
    }
    const [raw, end] = findBlockEnd(stripped, m.index, m[0]);
    const inner = m[0] in CLOSERS ? innermostToolCall(raw, m[0]) : raw;
    const parsed = readCall(inner, schema);
    if (parsed == null || !(parsed[0] in schema)) {
      cleanParts.push(stripped.slice(m.index, end));
    } else {
      calls.push({ id: newCallId(), name: parsed[0], arguments: parsed[1] });
    }
    pos = end;
  }
  return { clean: cleanParts.join("").trim(), calls, reasoning };
}

function countFences(s: string): number {
  FENCE_RE.lastIndex = 0;
  let n = 0;
  while (FENCE_RE.exec(s)) n++;
  return n;
}

export interface RawCall {
  id?: string | null;
  name: string;
  arguments: string;
}

export function repairNativeCall(raw: RawCall, schema: SchemaMap): ToolCall[] {
  const name = raw.name;
  const argsText = raw.arguments;
  if (name.trim() === "") throw new ToolCallParseException("TC-NATIVE-INVALID");
  if (name in schema) {
    let args: unknown;
    try {
      args = strictDecode(argsText);
    } catch {
      throw new ToolCallParseException("TC-ARGS-INVALID");
    }
    if (!isObj(args)) throw new ToolCallParseException("TC-ARGS-INVALID");
    return [{ id: raw.id ?? newCallId(), name, arguments: args }];
  }
  const trimmedArgs = argsText.trim();
  const text = name + (trimmedArgs !== "" && trimmedArgs !== "{}" && !name.includes("{") ? trimmedArgs : "");
  if (!text.includes("{") && !text.includes("<")) throw new ToolCallParseException("TC-NATIVE-INVALID");
  const repaired: ToolCall[] = [];
  for (const piece of text.replace(/<\/tool_call>/g, "").split("<tool_call>")) {
    if (piece.trim() === "") continue;
    const parsed = readCall(piece, schema);
    if (parsed == null || !(parsed[0] in schema)) throw new ToolCallParseException("TC-NATIVE-INVALID");
    repaired.push({ id: newCallId(), name: parsed[0], arguments: parsed[1] });
  }
  if (repaired.length === 0) throw new ToolCallParseException("TC-NATIVE-INVALID");
  return repaired;
}

function stripThink(text: string): [string, string | null] {
  const reasoning: string[] = [];
  let out = "";
  let i = 0;
  while (true) {
    const start = text.indexOf("<think>", i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    const end = text.indexOf("</think>", start);
    if (end === -1) {
      reasoning.push(text.slice(start + "<think>".length));
      break;
    }
    reasoning.push(text.slice(start + "<think>".length, end));
    i = end + "</think>".length;
  }
  const r = reasoning.filter((s) => s.trim() !== "").map((s) => s.trim()).join("\n");
  return [out, r === "" ? null : r];
}

function toolProperties(schema: SchemaMap, name: string): Json {
  const props = schema[name]?.["properties"];
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

function skipWhitespace(s: string, k0: number): number {
  let k = k0;
  while (k < s.length && " \t\r\n".includes(s[k])) k++;
  return k;
}

function closesString(s: string, j: number): boolean {
  let k = skipWhitespace(s, j + 1);
  if (k >= s.length) return true;
  if (":}]".includes(s[k])) return true;
  if (s[k] !== ",") return false;
  k = skipWhitespace(s, k + 1);
  return k >= s.length || `"{[-0123456789tfn`.includes(s[k]);
}

const BARE_TOKEN_RE = /[^,}\]\n]*/y;

function quoteBareValue(s: string, i0: number): [string, number] {
  const start = i0;
  let i = skipWhitespace(s, i0);
  let emitted = s.slice(start, i);
  if (i < s.length && !`"{[`.includes(s[i])) {
    BARE_TOKEN_RE.lastIndex = i;
    const m = BARE_TOKEN_RE.exec(s);
    const token = (m?.[0] ?? "").trimEnd();
    if (token !== "" && !BARE_LITERAL_RE.test(token)) {
      emitted += JSON.stringify(token);
      i += token.length;
    }
  }
  return [emitted, i];
}

function repairJson(s: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      if (c === "\\" && i + 1 < s.length) {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') {
        if (closesString(s, i)) {
          inStr = false;
        } else {
          out += '\\"';
          i += 1;
          continue;
        }
      }
    } else if (c === '"') {
      inStr = true;
    } else if (c === ":") {
      out += c;
      const [emitted, ni] = quoteBareValue(s, i + 1);
      out += emitted;
      i = ni;
      continue;
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
    } else if ((c === "}" || c === "]") && stack.length > 0) {
      stack.pop();
    }
    out += c;
    i += 1;
  }
  return out.trimEnd() + stack.reverse().join("");
}

const CLEAN_FENCE_RE = /```(?:json)?\s*/;
const CLEAN_FUNCNAME_RE = /^<\s*function[\s_]*name\s*=\s*(?=")/;
const CLEAN_FIRSTKEY_RE = /^(\{\s*)"(?:function_name|function|name)\s*=\s*"?([\w.-]+)>?"/;

function cleanJsonBlock(raw0: string): string {
  let raw = raw0.trim();
  const m = CLEAN_FENCE_RE.exec(raw);
  if (m) raw = raw.slice(m.index + m[0].length).split("```", 1)[0];
  raw = raw.replace(CLEAN_FUNCNAME_RE, '{"name": ');
  return raw.replace(CLEAN_FIRSTKEY_RE, (_mm, g1: string, g2: string) => `${g1}"name": "${g2}"`);
}

function firstJsonValueEnd(s: string): number {
  const i = skipWhitespace(s, 0);
  if (i >= s.length) return -1;
  const open = s[i];
  if (open === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === "\\") j += 2;
      else if (s[j] === '"') return j + 1;
      else j++;
    }
    return -1;
  }
  if (open === "{" || open === "[") {
    const stack: string[] = [open === "{" ? "}" : "]"];
    let j = i + 1;
    let inStr = false;
    while (j < s.length && stack.length > 0) {
      const c = s[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{" || c === "[") {
        stack.push(c === "{" ? "}" : "]");
      } else if (c === "}" || c === "]") {
        if (stack[stack.length - 1] === c) stack.pop();
      }
      j++;
    }
    return stack.length === 0 ? j : -1;
  }
  const m = /[^,\s}\]]*/.exec(s.slice(i));
  return m && m[0] !== "" ? i + m[0].length : -1;
}

function decodeJsonObject(text: string): [Json, string] {
  const idx = text.indexOf("{");
  if (idx === -1) throw new ToolCallParseException("TC-JSON-NO-OBJECT");
  const body = text.slice(idx);
  let obj: unknown = null;
  try {
    const end = firstJsonValueEnd(body);
    if (end === -1) throw new Error();
    obj = strictDecode(body.slice(0, end));
  } catch {
    obj = null;
  }
  if (obj === null) {
    try {
      const repaired = repairJson(body);
      const end = firstJsonValueEnd(repaired);
      if (end === -1) throw new Error();
      obj = strictDecode(repaired.slice(0, end));
    } catch (e) {
      throw new ToolCallParseException("TC-JSON-INVALID", e instanceof Error ? e.message : "");
    }
  }
  if (!isObj(obj)) throw new ToolCallParseException("TC-JSON-NOT-OBJECT", typeof obj);
  return [obj, text.slice(0, idx).trim()];
}

function findJsonToolName(obj0: Json, prefix: string): [string, Json] {
  let obj = obj0;
  const fnRaw = obj["function"];
  let fn: unknown = fnRaw;
  if (isObj(fnRaw)) {
    obj = fnRaw;
    fn = undefined;
  }
  const name =
    (typeof obj["name"] === "string" ? (obj["name"] as string) : undefined) ??
    (typeof fn === "string" ? fn : undefined) ??
    (typeof obj["function_name"] === "string" ? (obj["function_name"] as string) : undefined);
  if (name == null && PREFIX_NAME_RE.test(prefix)) {
    return [prefix, { arguments: obj }];
  }
  if (name == null || name === "") throw new ToolCallParseException("TC-NAME-MISSING");
  return [name, obj];
}

function jsonCallArguments(obj: Json): Json {
  let args: unknown =
    "arguments" in obj || "parameters" in obj
      ? (obj["arguments"] ?? obj["parameters"])
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

const PARAM_RE = /<parameter=([^>]*)>([\s\S]*?)<\/parameter>/g;

function trimOneNewline(v0: string): string {
  let v = v0;
  if (v.startsWith("\n")) v = v.slice(1);
  if (v.endsWith("\n")) v = v.slice(0, v.length - 1);
  return v;
}

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

function parseBlock(raw: string, schema: SchemaMap): [string, Json] {
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

function normalizeCall(parsed: [string, Json], schema: SchemaMap): [string, Json] {
  const [name, args] = parsed;
  if (name in schema || !EXEC_ALIASES.has(name) || !(EXEC_TOOL in schema)) return parsed;
  const cmds = commandList(args);
  if (cmds == null || cmds.length !== 1) return parsed;
  return [EXEC_TOOL, { command: cmds[0] }];
}

function findBlockEnd(text: string, tagStart: number, tag: string): [string, number] {
  const start = tagStart + tag.length;
  const closer = CLOSERS[tag];
  if (closer != null) {
    const end = text.indexOf(closer, start);
    if (end === -1) return [text.slice(start), text.length];
    return [text.slice(start, end), end + closer.length];
  }
  const end = text.indexOf("</function>", start);
  if (end === -1) return [text.slice(tagStart), text.length];
  return [text.slice(tagStart, end) + "</function>", end + "</function>".length];
}

function innermostToolCall(raw: string, opener: string): string {
  if (raw.includes(opener)) return raw.slice(raw.lastIndexOf(opener) + opener.length);
  return raw;
}

function readCall(raw: string, schema: SchemaMap): [string, Json] | null {
  try {
    return normalizeCall(parseBlock(raw, schema), schema);
  } catch (e) {
    if (e instanceof ToolCallParseException) return null;
    throw e;
  }
}
