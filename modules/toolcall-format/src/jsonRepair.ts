import type { Json } from "@stewart/kernel";
import { ToolCallParseException } from "./types.js";

export function isObj(v: unknown): v is Json {
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

export function strictDecode(text: string): unknown {
  const el = JSON.parse(text) as unknown;
  checkStrict(el);
  return el;
}

export function skipWhitespace(s: string, k0: number): number {
  let k = k0;
  while (k < s.length && " \t\r\n".includes(s[k])) k++;
  return k;
}

const BARE_LITERAL_RE = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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

function repairPlain(s: string, i: number, stack: string[]): { inStr: boolean; text: string; next: number } {
  const c = s[i];
  if (c === '"') return { inStr: true, text: c, next: i + 1 };
  if (c === ":") {
    const [emitted, ni] = quoteBareValue(s, i + 1);
    return { inStr: false, text: c + emitted, next: ni };
  }
  if (c === "{" || c === "[") {
    stack.push(c === "{" ? "}" : "]");
    return { inStr: false, text: c, next: i + 1 };
  }
  if ((c === "}" || c === "]") && stack.length > 0) {
    stack.pop();
    return { inStr: false, text: c, next: i + 1 };
  }
  return { inStr: false, text: c, next: i + 1 };
}

function repairJson(s: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (!inStr) {
      const r = repairPlain(s, i, stack);
      inStr = r.inStr;
      out += r.text;
      i = r.next;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"') {
      if (closesString(s, i)) {
        inStr = false;
        out += c;
        i += 1;
      } else {
        out += '\\"';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out.trimEnd() + stack.reverse().join("");
}

const CLEAN_FENCE_RE = /^```(?:json)?\s*/;
const CLEAN_FUNCNAME_RE = /^<\s*function[\s_]*name\s*=\s*(?=")/;
const CLEAN_FIRSTKEY_RE = /^(\{\s*)"(?:function_name|function|name)\s*=\s*"?([\w.-]+)>?"/;

export function cleanJsonBlock(raw0: string): string {
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

function compositePlain(c: string, stack: string[]): boolean {
  if (c === '"') return true;
  if (c === "{" || c === "[") {
    stack.push(c === "{" ? "}" : "]");
    return false;
  }
  if (c === "}" || c === "]") {
    if (stack[stack.length - 1] === c) stack.pop();
  }
  return false;
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
    } else {
      inStr = compositePlain(c, stack);
    }
    j++;
  }
  return stack.length === 0 ? j : -1;
}

export function firstJsonValueEnd(s: string): number {
  const i = skipWhitespace(s, 0);
  if (i >= s.length) return -1;
  const open = s[i];
  if (open === '"') return jsonStringEnd(s, i);
  if (open === "{" || open === "[") return jsonCompositeEnd(s, i, open);
  const m = /[^,\s}\]]*/.exec(s.slice(i));
  return m && m[0] !== "" ? i + m[0].length : -1;
}

export function decodeJsonObject(text: string): [Json, string] {
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
