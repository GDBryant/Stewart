import type { FunctionMetric } from "./types.js";

const BRACE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".java", ".go", ".rs",
  ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".php", ".swift", ".scala", ".vue", ".svelte",
]);
const INDENT_EXTS = new Set([".py", ".rb"]);

export function measuredFamily(path: string): "brace" | "indent" | "none" {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot).toLowerCase();
  if (BRACE_EXTS.has(ext)) return "brace";
  if (INDENT_EXTS.has(ext)) return "indent";
  return "none";
}

function blankRange(a: string[], from: number, to: number): number {
  for (let j = from; j < to; j++) if (a[j] !== "\n") a[j] = " ";
  return to;
}

function closingQuote(src: string, i: number, q: string): number {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "\n") return -1;
    else if (c === q) return j;
  }
  return -1;
}

function templateEnd(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") return j + 1;
  }
  return src.length;
}

/** Mask comments and string/char literals with spaces, preserving newlines and length. */
export function maskBrace(src: string): string {
  const a = [...src];
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === "/" && a[i + 1] === "/") {
      const e = a.indexOf("\n", i);
      i = blankRange(a, i, e < 0 ? a.length : e) - 1;
    } else if (c === "/" && a[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = blankRange(a, i, e < 0 ? a.length : e + 2) - 1;
    } else if (c === '"' || c === "'") {
      const e = closingQuote(src, i, c);
      if (e >= 0) i = blankRange(a, i, e + 1) - 1;
    } else if (c === "`") {
      i = blankRange(a, i, templateEnd(src, i)) - 1;
    }
  }
  return a.join("");
}

export function maskIndent(src: string): string {
  const a = [...src];
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === "#") {
      const e = a.indexOf("\n", i);
      i = blankRange(a, i, e < 0 ? a.length : e) - 1;
    } else if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const q = src.slice(i, i + 3);
      const e = src.indexOf(q, i + 3);
      i = blankRange(a, i, e < 0 ? src.length : e + 3) - 1;
    } else if (c === '"' || c === "'") {
      const e = closingQuote(src, i, c);
      if (e >= 0) i = blankRange(a, i, e + 1) - 1;
    }
  }
  return a.join("");
}

const FIRST_WORD = /[A-Za-z_$][\w$]*/;
const CONTROL_DEPTH = new Set(["if", "else", "for", "foreach", "while", "do", "switch", "try", "catch", "finally", "when", "match", "loop"]);
const NOT_FN = new Set([...CONTROL_DEPTH, "synchronized", "using", "lock", "with"]);
const DECL_WORDS = new Set(["class", "interface", "enum", "struct", "object", "namespace", "impl", "trait"]);
const FN_KEYWORD = /\b(?:function|fun|fn|func|def)\s+([A-Za-z_$][\w$]*)/;
const FN_WORD = /\b(?:function|fun|fn|func|def)\b/;
const ASSIGN_NAME = /([A-Za-z_$][\w$]*)\s*[=:]/;
const RESERVED_NAMES = new Set([
  ...NOT_FN, ...DECL_WORDS, "function", "fun", "fn", "func", "def", "async", "await", "return", "const", "let", "var",
  "new", "export", "public", "private", "protected", "static", "override", "suspend", "abstract", "virtual", "sealed",
  "open", "final", "internal", "readonly",
]);

interface Tok {
  pos: number;
  kind: "open" | "close";
}

function braceToks(masked: string): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "}") toks.push({ pos: i, kind: c === "{" ? "open" : "close" });
  }
  return toks;
}

const DECL_WORD = /\b(?:class|interface|enum|struct|object|namespace|impl|trait)\b/;

function braceKind(header: string): "fn" | "control" | "other" {
  const t = header.trim();
  const first = FIRST_WORD.exec(t)?.[0] ?? "";
  if (CONTROL_DEPTH.has(first)) return "control";
  if (NOT_FN.has(first) || DECL_WORDS.has(first)) return "other";
  const paren = t.indexOf("(");
  if (DECL_WORD.test(paren < 0 ? t : t.slice(0, paren))) return "other";
  if (t.endsWith("=>") || /\([^()]*\)/.test(t)) return "fn";
  return "other";
}

function parenBalance(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === "(") n++;
    else if (c === ")") n--;
  }
  return n;
}

function lastTopSemi(s: string): number {
  let last = -1, pd = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") pd++;
    else if (c === ")") pd = Math.max(0, pd - 1);
    else if (c === ";" && pd === 0) last = i;
  }
  return last;
}

function lastLineStart(starts: number[], pos: number): number {
  return starts[lineOf(starts, pos) - 1];
}

function headerGroup(masked: string, starts: number[], lo: number, openPos: number): { text: string; hs: number } {
  let lineStart = lastLineStart(starts, openPos);
  let gEnd = openPos;
  if (masked.slice(lineStart, openPos).trim() === "") {
    let p = lineStart - 1;
    while (p >= lo && /\s/.test(masked[p])) p--;
    gEnd = p + 1;
    lineStart = lastLineStart(starts, Math.max(p, 0));
  }
  let start = Math.max(lineStart, lo);
  while (start > lo && parenBalance(masked.slice(start, gEnd)) < 0) {
    start = Math.max(masked.lastIndexOf("\n", start - 2) + 1, lo);
  }
  const text = masked.slice(start, gEnd);
  let header = text;
  if (!CONTROL_DEPTH.has(FIRST_WORD.exec(header)?.[0] ?? "")) {
    const semi = lastTopSemi(header);
    if (semi >= 0) header = header.slice(semi + 1);
  }
  return { text: header, hs: start + (text.length - text.trimStart().length) };
}

function fnName(header: string): string {
  const kw = FN_KEYWORD.exec(header);
  if (kw) return kw[1];
  const t = header.trim();
  if (t.endsWith("=>") || FN_WORD.test(t)) {
    const assign = ASSIGN_NAME.exec(t.replace(/=>\s*$/, "").trimEnd());
    if (assign) return assign[1];
  }
  const lastParen = header.lastIndexOf("(");
  const m = lastParen > 0 ? /([A-Za-z_$][\w$]*)\s*$/.exec(header.slice(0, lastParen)) : null;
  const name = m?.[1] ?? "(anonymous)";
  return RESERVED_NAMES.has(name) ? "(anonymous)" : name;
}

function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") out.push(i + 1);
  return out;
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function matchBraces(toks: Tok[]): Map<number, number> {
  const stack: number[] = [];
  const m = new Map<number, number>();
  for (const t of toks) {
    if (t.kind === "open") stack.push(t.pos);
    else if (t.kind === "close") {
      const o = stack.pop();
      if (o !== undefined) m.set(o, t.pos);
    }
  }
  return m;
}

const BRANCH_KW = /\b(?:if|for|foreach|while|case|catch|when)\b/g;

function countLit(text: string, lit: string): number {
  let n = 0;
  for (let i = text.indexOf(lit); i >= 0; i = text.indexOf(lit, i + 1)) n++;
  return n;
}

function countBranches(text: string): number {
  let n = (text.match(BRANCH_KW) ?? []).length + countLit(text, "&&") + countLit(text, "||") + countLit(text, "??");
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] === "?" && /\s/.test(text[i - 1]) && /\s/.test(text[i + 1])) n++;
  }
  return n;
}

function braceDepth(toks: Tok[], masked: string, starts: number[], from: number, closePos: number): number {
  let depth = 0, max = 0;
  const stack: boolean[] = [];
  for (let i = from + 1; i < toks.length && toks[i].pos < closePos; i++) {
    const t = toks[i];
    if (t.kind === "open") {
      const lo = i > 0 ? toks[i - 1].pos + 1 : 0;
      const ctrl = braceKind(headerGroup(masked, starts, lo, t.pos).text) === "control";
      stack.push(ctrl);
      if (ctrl) {
        depth++;
        if (depth > max) max = depth;
      }
    } else if (t.kind === "close" && stack.pop()) depth--;
  }
  return max;
}

export function scanBrace(content: string): FunctionMetric[] {
  const masked = maskBrace(content);
  const starts = lineStarts(masked);
  const toks = braceToks(masked);
  const closeOf = matchBraces(toks);
  const fns: FunctionMetric[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "open") continue;
    const lo = i > 0 ? toks[i - 1].pos + 1 : 0;
    const { text: header, hs } = headerGroup(masked, starts, lo, t.pos);
    if (braceKind(header) !== "fn") continue;
    const close = closeOf.get(t.pos);
    if (close === undefined) continue;
    const start = lineOf(starts, hs);
    const end = lineOf(starts, close);
    const span = masked.slice(hs, close + 1);
    fns.push({ name: fnName(header), line: start, lines: end - start + 1, branches: countBranches(span), depth: braceDepth(toks, masked, starts, i, close) });
  }
  return fns;
}

const INDENT_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const INDENT_BRANCH = /\b(?:if|elif|elsif|unless|for|while|until|except|rescue|when|case|and|or)\b/g;
const INDENT_CONTROL = new Set(["if", "elif", "else", "for", "while", "try", "except", "with", "unless", "until", "case", "when", "begin", "rescue"]);

function indentBranches(lines: string[]): number {
  let n = 0;
  for (const t of lines) n += (t.match(INDENT_BRANCH) ?? []).length + countLit(t, "&&") + countLit(t, "||");
  return n;
}

function indentDepth(lines: string[]): number {
  const stack: number[] = [];
  let max = 0;
  for (const t of lines) {
    const m = /^(\s*)([A-Za-z_]+)/.exec(t);
    if (!m || !INDENT_CONTROL.has(m[2])) continue;
    while (stack.length && stack[stack.length - 1] >= m[1].length) stack.pop();
    stack.push(m[1].length);
    if (stack.length > max) max = stack.length;
  }
  return max;
}

export function scanIndent(content: string, isRuby: boolean): FunctionMetric[] {
  const lines = maskIndent(content).split("\n");
  const fns: FunctionMetric[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = INDENT_DEF.exec(lines[i]);
    if (!m) continue;
    let bodyStart = i + 1;
    let bal = parenBalance(lines[i]);
    while (bodyStart < lines.length && bal > 0) {
      bal += parenBalance(lines[bodyStart]);
      bodyStart++;
    }
    let end = lines.length;
    for (let j = bodyStart; j < lines.length; j++) {
      const t = lines[j];
      const ind = t.length - t.trimStart().length;
      if (t.trim() && ind <= m[1].length) {
        end = isRuby && ind === m[1].length && t.trim() === "end" ? j + 1 : j;
        break;
      }
    }
    if (end === lines.length && lines[end - 1] === "") end--;
    const span = lines.slice(i, end);
    fns.push({ name: m[2], line: i + 1, lines: end - i, branches: indentBranches(span), depth: indentDepth(span) });
  }
  return fns;
}
