import type { ToolCall } from "@stewart/kernel";
import type { Json } from "@stewart/kernel";
import { firstJsonValueEnd, isObj, strictDecode } from "./jsonRepair.js";
import { normalizeShapes } from "./callAttr.js";
import { normalizeCall, parseBlock, parseGemma } from "./tagParsers.js";
import { FAILURE_REASONS, known, newCallId, ToolCallParseException } from "./types.js";
import type { ParseError, ParseResult, SchemaMap } from "./types.js";

export { repairNativeCall } from "./repairNative.js";
export type { RawCall } from "./repairNative.js";
export { FAILURE_REASONS, newCallId, ToolCallParseException } from "./types.js";
export type { ParseError, ParseResult, SchemaMap } from "./types.js";
export { callAttrTagEnd, scanCallAttrTag } from "./callAttr.js";

const TAG_RE = /<\|tool_call>|<tool_call>|<call>|<function=[^>]*>/g;
const GEMMA_OPEN = "<|tool_call>";
const CLOSERS: Record<string, string> = {
  "<|tool_call>": "<tool_call|>",
  "<tool_call>": "</tool_call>",
  "<call>": "</call>",
};
const FENCE_OPEN_RE = /^[ \t]*```([^\n`]*)$/gm;
const FENCE_CLOSE_RE = /^[ \t]*```[ \t\r]*$/gm;
/** Fence languages whose bodies are scanned for calls. Untagged and other fences are code. */
const PARSABLE_FENCES = new Set(["json", "tool_code", "tool_call"]);

interface Scan {
  text: string;
  schema: SchemaMap;
  calls: ToolCall[];
  errors: ParseError[];
  /** Character spans consumed by successful calls (removed from clean text). */
  removed: [number, number][];
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
interface SpanCandidates {
  jsonIdx: number;
  tagM: RegExpExecArray | null;
  tagIdx: number;
  fence: { index: number; lineEnd: number; lang: string } | null;
  fenceIdx: number;
}

function spanCandidates(ctx: Scan, pos: number, to: number, fences: boolean, tags: boolean): SpanCandidates {
  const { text } = ctx;
  let fence: SpanCandidates["fence"] = null;
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
  return { jsonIdx, tagM, tagIdx, fence, fenceIdx };
}

function scanSpan(ctx: Scan, from: number, to: number, fences: boolean, tags: boolean): void {
  let pos = from;
  while (pos < to) {
    const c = spanCandidates(ctx, pos, to, fences, tags);
    if (c.jsonIdx >= 0) {
      pos = bareAt(ctx, c.jsonIdx, to);
      continue;
    }
    if (c.tagM && c.tagIdx < c.fenceIdx) {
      pos = tagAt(ctx, c.tagM, to);
      continue;
    }
    if (c.fence) {
      pos = fenceAt(ctx, c.fence, to);
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

function innermostToolCall(raw: string, opener: string): string {
  if (raw.includes(opener)) return raw.slice(raw.lastIndexOf(opener) + opener.length);
  return raw;
}
