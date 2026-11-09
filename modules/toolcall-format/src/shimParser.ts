import type { ToolCall } from "@stewart/kernel";
import type { Json } from "@stewart/kernel";

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

const TAG_RE = /<\|tool_call>|<tool_call>|<call>|<function=[^>]*>/g;
const GEMMA_OPEN = "<|tool_call>";
const CLOSERS: Record<string, string> = {
  "<|tool_call>": "<tool_call|>",
  "<tool_call>": "</tool_call>",
  "<call>": "</call>",
};
const PREFIX_NAME_RE = /^[A-Za-z_][\w.\-:]*$/;
const BARE_LITERAL_RE = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const FENCE_OPEN_RE = /^[ \t]*```([^\n`]*)$/gm;
const FENCE_CLOSE_RE = /^[ \t]*```[ \t\r]*$/gm;
/** Fence languages whose bodies are scanned for calls. Untagged and other fences are code. */
const PARSABLE_FENCES = new Set(["json", "tool_code", "tool_call"]);
const GEMMA_STR = '<|"|>';
const GEMMA_KEY_RE = /([{,]\s*)([A-Za-z_]\w*)\s*:/g;
const GEMMA_NAME_RE = /^\s*call:([A-Za-z_][\w.\-:]*)\s*\{/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

let idCounter = 0;
export function newCallId(): string {
  idCounter = (idCounter + 1) % 0xffffffff;
  return `call_${Date.now().toString(16)}${idCounter.toString(16).padStart(4, "0")}`;
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function known(name: string, schema: SchemaMap): boolean {
  return Object.prototype.hasOwnProperty.call(schema, name);
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

interface Scan {
  text: string;
  schema: SchemaMap;
  calls: ToolCall[];
  errors: ParseError[];
  /** Character spans consumed by successful calls (removed from clean text). */
  removed: [number, number][];
}

const CHANNEL_MARKER_RE = /<\|?channel\|?>(?:thought\n?)?/g;
const ATTR_CALL_RE = /<tool_call\s+name=(["'])([^"']+)\1\s+arguments='([\s\S]*?)'\s*>(?:\s*<\/tool_call>)?/g;

const CALL_ATTR_OPEN_RE = /<call(?=[\s/])/g;

interface CallAttrScan {
  name?: string;
  args?: string;
  end: number;
  complete: boolean;
}

/** Scan a `<call name="X" arguments={...}>` attribute tag starting at `start` (which points at `<call`). */
export function scanCallAttrTag(text: string, start: number): CallAttrScan | null {
  let i = start + "<call".length;
  let name: string | undefined;
  let args: string | undefined;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { name, args, end: i, complete: false };
    const c = text[i];
    if (c === ">") return finishCallAttrTag(text, { name, args, end: i + 1, complete: true });
    if (c === "/") {
      if (i + 1 >= text.length) return { name, args, end: i, complete: false };
      if (text[i + 1] === ">") return finishCallAttrTag(text, { name, args, end: i + 2, complete: true });
      return null;
    }
    const km = /^[A-Za-z_][\w-]*/.exec(text.slice(i));
    if (!km) return null;
    const key = km[0];
    i = skipWhitespace(text, i + km[0].length);
    if (text[i] !== "=") continue;
    const v = readAttrValue(text, skipWhitespace(text, i + 1));
    if (v === null) return { name, args, end: i, complete: false };
    const [raw, vend, kind] = v;
    i = vend;
    if (key === "name" && kind !== "raw") name = decodeAttrValue(raw, kind);
    else if (key === "arguments" || key === "args" || key === "parameters") args = decodeAttrValue(raw, kind);
  }
}

/** End index (exclusive) of a `<call ...>` attribute tag at `start`, or -1 when incomplete or malformed. */
export function callAttrTagEnd(text: string, start: number): number {
  const scan = scanCallAttrTag(text, start);
  if (scan !== null) {
    if (!scan.complete) return -1;
    return scan.end;
  }
  const gt = text.indexOf(">", start + "<call".length);
  return gt === -1 ? -1 : gt + 1;
}

function readAttrValue(text: string, i: number): [string, number, "sq" | "dq" | "raw"] | null {
  if (i >= text.length) return null;
  const c = text[i];
  if (c === '"' || c === "'") {
    const q = c;
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === q) return [text.slice(i + 1, j), j + 1, q === '"' ? "dq" : "sq"];
      j++;
    }
    return null;
  }
  if (c === "{" || c === "[") {
    const endRel = firstJsonValueEnd(text.slice(i));
    if (endRel === -1) return null;
    return [text.slice(i, i + endRel), i + endRel, "raw"];
  }
  return null;
}

function decodeAttrValue(raw: string, kind: "sq" | "dq" | "raw"): string {
  if (kind === "dq") {
    try {
      const v = JSON.parse(`"${raw}"`);
      if (typeof v === "string") return v;
    } catch {
    }
  }
  return raw;
}

function finishCallAttrTag(text: string, scan: CallAttrScan): CallAttrScan {
  let e = scan.end;
  while (e < text.length && " \t\r\n".includes(text[e])) e++;
  if (text.startsWith("</call>", e)) scan.end = e + "</call>".length;
  return scan;
}

/** Rewrite `<call name="X" arguments={...}/>` attribute tags to the canonical <tool_call> JSON form. */
function rewriteCallAttrs(text: string): string {
  CALL_ATTR_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let out = "";
  let p = 0;
  while ((m = CALL_ATTR_OPEN_RE.exec(text))) {
    const scan = scanCallAttrTag(text, m.index);
    if (scan === null || !scan.complete || scan.name === undefined) continue;
    out += text.slice(p, m.index);
    out += `<tool_call>{"name":${JSON.stringify(scan.name)},"arguments":${scan.args ?? "{}"}}</tool_call>`;
    p = scan.end;
    CALL_ATTR_OPEN_RE.lastIndex = scan.end;
  }
  return p === 0 ? text : out + text.slice(p);
}

/** Drop Gemma channel markers and rewrite `<tool_call name="X" arguments='{..}'>` to the JSON body form. */
function normalizeShapes(text: string): string {
  return rewriteCallAttrs(
    text
      .replace(CHANNEL_MARKER_RE, "")
      .replace(ATTR_CALL_RE, (_m, _q, name: string, args: string) => `<tool_call>{"name":${JSON.stringify(name)},"arguments":${args}}</tool_call>`),
  );
}

export function parseToolCalls(text: string, schema: SchemaMap, startInFence = false): ParseResult {
  const [stripped, reasoning] = stripThink(normalizeShapes(text));
  const ctx: Scan = { text: stripped, schema, calls: [], errors: [], removed: [] };
  let from = 0;
  if (startInFence) {
    const close = nextFenceClose(stripped, 0, stripped.length);
    from = close ? close.end : stripped.length;
  }
  scanSpan(ctx, from, stripped.length, true, true);
  let out = "";
  let p = 0;
  for (const [s, e] of ctx.removed) {
    out += stripped.slice(p, s);
    p = e;
  }
  out += stripped.slice(p);
  return { clean: out.trim(), calls: ctx.calls, reasoning, errors: ctx.errors };
}

/**
 * Left-to-right scan of text[from, to). At each point the earliest of: an explicit tag,
 * a line-start code fence, or a bare JSON opener is handled. Tags win over fences that start
 * later, so a fence marker inside a tagged argument never affects the scan.
 */
function scanSpan(ctx: Scan, from: number, to: number, fences: boolean, tags: boolean): void {
  const { text } = ctx;
  let pos = from;
  while (pos < to) {
    let fence: { index: number; lineEnd: number; lang: string } | null = null;
    let fenceIdx = Infinity;
    if (fences) {
      FENCE_OPEN_RE.lastIndex = pos;
      const m = FENCE_OPEN_RE.exec(text);
      if (m && m.index < to) {
        fence = { index: m.index, lineEnd: m.index + m[0].length, lang: m[1].trim().toLowerCase() };
        fenceIdx = m.index;
      }
    }
    let tagM: RegExpExecArray | null = null;
    let tagIdx = Infinity;
    if (tags) {
      TAG_RE.lastIndex = pos;
      const m = TAG_RE.exec(text);
      if (m && m.index < to) {
        tagM = m;
        tagIdx = m.index;
      }
    }
    const limit = Math.min(fenceIdx, tagIdx, to);
    let jsonIdx = -1;
    for (let j = pos; j < limit; j++) {
      const c = text[j];
      if (c === "{" || c === "[") {
        jsonIdx = j;
        break;
      }
    }
    if (jsonIdx >= 0) {
      pos = bareAt(ctx, jsonIdx, to);
      continue;
    }
    if (tagM && tagIdx < fenceIdx) {
      pos = tagAt(ctx, tagM, to);
      continue;
    }
    if (fence) {
      pos = fenceAt(ctx, fence, to);
      continue;
    }
    break;
  }
}

function nextFenceClose(text: string, from: number, to: number): { index: number; end: number } | null {
  FENCE_CLOSE_RE.lastIndex = from;
  const m = FENCE_CLOSE_RE.exec(text);
  if (!m || m.index >= to) return null;
  return { index: m.index, end: m.index + m[0].length };
}

function fenceAt(ctx: Scan, f: { index: number; lineEnd: number; lang: string }, to: number): number {
  const bodyStart = Math.min(f.lineEnd + 1, to);
  const close = nextFenceClose(ctx.text, bodyStart, to);
  // An unclosed fence marker is ordinary text, so it cannot disable calls after it.
  if (close === null) return f.lineEnd;
  if (!PARSABLE_FENCES.has(f.lang)) return close.end;
  const mark = ctx.removed.length;
  scanSpan(ctx, bodyStart, close.index, false, true);
  const bodySpans = ctx.removed.splice(mark);
  if (bodySpans.length > 0 && isBlank(ctx.text, bodyStart, close.index, bodySpans)) {
    ctx.removed.push([f.index, close.end]);
  } else {
    ctx.removed.push(...bodySpans);
  }
  return close.end;
}

function isBlank(text: string, a: number, b: number, spans: [number, number][]): boolean {
  let out = "";
  let p = a;
  for (const [s, e] of spans) {
    out += text.slice(p, s);
    p = e;
  }
  out += text.slice(p, b);
  return out.trim() === "";
}

function tagBounds(text: string, opener: string, tagEnd: number, to: number): { closeAt: number; closed: boolean; end: number } {
  const closer = opener.startsWith("<function=") ? "</function>" : CLOSERS[opener];
  const found = text.indexOf(closer, tagEnd);
  const closeAt = found !== -1 && found + closer.length <= to ? found : -1;
  const closed = closeAt !== -1;
  return { closeAt, closed, end: closed ? closeAt + closer.length : to };
}

function tagRaw(text: string, opener: string, start: number, end: number, tagEnd: number, closeAt: number, closed: boolean, to: number): string {
  if (opener.startsWith("<function=")) return text.slice(start, end);
  return innermostToolCall(text.slice(tagEnd, closed ? closeAt : to), opener);
}

function parseTagCall(raw: string, opener: string, schema: SchemaMap): { parsed: [string, Json] | null; code: string } {
  try {
    return { parsed: opener === GEMMA_OPEN ? parseGemma(raw) : parseBlock(raw, schema), code: "" };
  } catch (e) {
    return { parsed: null, code: e instanceof ToolCallParseException ? e.code : "TC-PARSE" };
  }
}

/** Explicit tagged call. Errors are reported only for closed blocks; an unclosed opener is text unless it parses. */
function tagAt(ctx: Scan, m: RegExpExecArray, to: number): number {
  const { text, schema } = ctx;
  const opener = m[0];
  const start = m.index;
  const tagEnd = start + opener.length;
  const { closeAt, closed, end } = tagBounds(text, opener, tagEnd, to);
  // A tag quoted inline as `<tool_call>...</tool_call>` is a mention, not a call.
  if (closed && start > 0 && text[start - 1] === "`" && text[end] === "`") return end;
  const raw = tagRaw(text, opener, start, end, tagEnd, closeAt, closed, to);
  const { parsed, code } = parseTagCall(raw, opener, schema);
  if (!closed) {
    if (parsed === null) return tagEnd;
    const [name, args] = normalizeCall(parsed, schema);
    if (!known(name, schema)) return tagEnd;
    ctx.calls.push({ id: newCallId(), name, arguments: args });
    ctx.removed.push([start, to]);
    return to;
  }
  if (parsed === null) {
    ctx.errors.push({ code, message: `malformed tool call (${FAILURE_REASONS[code] ?? code})` });
    return end;
  }
  const [name, args] = normalizeCall(parsed, schema);
  if (!known(name, schema)) {
    ctx.errors.push({ code: "TC-UNKNOWN-TOOL", message: `unknown tool '${name}'` });
    return end;
  }
  ctx.calls.push({ id: newCallId(), name, arguments: args });
  ctx.removed.push([start, end]);
  return end;
}

/** Bare JSON: an object (or array of objects) exactly shaped {name, arguments|parameters|args}. */
function bareAt(ctx: Scan, i: number, to: number): number {
  const slice = ctx.text.slice(i, to);
  const endRel = firstJsonValueEnd(slice);
  if (endRel === -1) return i + 1;
  let value: unknown;
  try {
    value = strictDecode(slice.slice(0, endRel));
  } catch {
    return i + 1;
  }
  const end = i + endRel;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  if (items.length === 0) return end;
  const shapes: { name: string; args: Json; known: boolean }[] = [];
  for (const it of items) {
    const shape = isObj(it) ? callShape(it, ctx.schema) : null;
    // Plain JSON that is not call-shaped is ordinary text.
    if (shape === null) return end;
    shapes.push(shape);
  }
  // Bare JSON needs a known name. An unknown name is ordinary text (often a prose example), so no error.
  if (shapes.some((s) => !s.known)) return end;
  for (const s of shapes) ctx.calls.push({ id: newCallId(), name: s.name, arguments: s.args });
  ctx.removed.push([i, end]);
  return end;
}

function callShape(obj: Json, schema: SchemaMap): { name: string; args: Json; known: boolean } | null {
  const keys = Object.keys(obj);
  const nameVal = obj["name"];
  if (keys.length !== 2 || typeof nameVal !== "string" || nameVal.trim() === "") return null;
  const argKey = keys.find((k) => k !== "name");
  if (argKey !== "arguments" && argKey !== "parameters" && argKey !== "args") return null;
  const argsVal = obj[argKey];
  if (!isObj(argsVal)) return null;
  const [name, args] = normalizeCall([nameVal.trim(), argsVal], schema);
  return { name, args, known: known(name, schema) };
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
  if (known(name, schema)) {
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
    if (parsed == null || !known(parsed[0], schema)) throw new ToolCallParseException("TC-NATIVE-INVALID");
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

const CLEAN_FENCE_RE = /^```(?:json)?\s*/;
const CLEAN_FUNCNAME_RE = /^<\s*function[\s_]*name\s*=\s*(?=")/;
const CLEAN_FIRSTKEY_RE = /^(\{\s*)"(?:function_name|function|name)\s*=\s*"?([\w.-]+)>?"/;

function cleanJsonBlock(raw0: string): string {
  let raw = raw0.trim();
  // Strip a wrapping fence only; a ``` inside a string argument must survive.
  if (raw.startsWith("```")) {
    raw = raw.replace(CLEAN_FENCE_RE, "");
    const close = raw.lastIndexOf("```");
    if (close !== -1) raw = raw.slice(0, close);
  }
  raw = raw.replace(CLEAN_FUNCNAME_RE, '{"name": ');
  return raw.replace(CLEAN_FIRSTKEY_RE, (_mm, g1: string, g2: string) => `${g1}"name": "${g2}"`);
}

function jsonStringEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") j += 2;
    else if (s[j] === '"') return j + 1;
    else j++;
  }
  return -1;
}

function jsonCompositeEnd(s: string, i: number, open: string): number {
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

function firstJsonValueEnd(s: string): number {
  const i = skipWhitespace(s, 0);
  if (i >= s.length) return -1;
  const open = s[i];
  if (open === '"') return jsonStringEnd(s, i);
  if (open === "{" || open === "[") return jsonCompositeEnd(s, i, open);
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
function parseGemma(raw: string): [string, Json] {
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
  if (known(name, schema) || !EXEC_ALIASES.has(name) || !known(EXEC_TOOL, schema)) return parsed;
  const cmds = commandList(args);
  if (cmds == null || cmds.length !== 1) return parsed;
  return [EXEC_TOOL, { command: cmds[0] }];
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
