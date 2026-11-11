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

export interface Tok {
  pos: number;
  kind: "open" | "close";
}

export function braceToks(masked: string): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "}") toks.push({ pos: i, kind: c === "{" ? "open" : "close" });
  }
  return toks;
}

const DECL_WORD = /\b(?:class|interface|enum|struct|object|namespace|impl|trait)\b/;

export function braceKind(header: string): "fn" | "control" | "other" {
  const t = header.trim();
  const first = FIRST_WORD.exec(t)?.[0] ?? "";
  if (CONTROL_DEPTH.has(first)) return "control";
  if (NOT_FN.has(first) || DECL_WORDS.has(first)) return "other";
  const paren = t.indexOf("(");
  if (DECL_WORD.test(paren < 0 ? t : t.slice(0, paren))) return "other";
  if (t.endsWith("=>") || /\([^()]*\)/.test(t)) return "fn";
  return "other";
}

export function parenBalance(s: string): number {
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

export function headerGroup(masked: string, starts: number[], lo: number, openPos: number): { text: string; hs: number } {
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

export function fnName(header: string): string {
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

export function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") out.push(i + 1);
  return out;
}

export function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function matchBraces(toks: Tok[]): Map<number, number> {
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

export function countBranches(text: string): number {
  let n = (text.match(BRANCH_KW) ?? []).length + countLit(text, "&&") + countLit(text, "||") + countLit(text, "??");
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] === "?" && /\s/.test(text[i - 1]) && /\s/.test(text[i + 1])) n++;
  }
  return n;
}

/** Brace-scan context shared by braceDepth: tokens, comment/string-masked source, line starts. */
export interface BraceCtx {
  toks: Tok[];
  masked: string;
  starts: number[];
}

function isControlOpen(ctx: BraceCtx, i: number): boolean {
  const t = ctx.toks[i];
  const lo = i > 0 ? ctx.toks[i - 1].pos + 1 : 0;
  return braceKind(headerGroup(ctx.masked, ctx.starts, lo, t.pos).text) === "control";
}

/** Max nesting of control-flow blocks (if/for/while/...) strictly inside the brace at `from`, closing at `closePos`. */
export function braceDepth(ctx: BraceCtx, from: number, closePos: number): number {
  let depth = 0, max = 0;
  const stack: boolean[] = [];
  for (let i = from + 1; i < ctx.toks.length && ctx.toks[i].pos < closePos; i++) {
    const t = ctx.toks[i];
    if (t.kind === "open") {
      const ctrl = isControlOpen(ctx, i);
      stack.push(ctrl);
      if (ctrl) {
        depth++;
        max = Math.max(max, depth);
      }
    } else if (t.kind === "close" && stack.pop()) depth--;
  }
  return max;
}

const INDENT_BRANCH = /\b(?:if|elif|elsif|unless|for|while|until|except|rescue|when|case|and|or)\b/g;
const INDENT_CONTROL = new Set(["if", "elif", "else", "for", "while", "try", "except", "with", "unless", "until", "case", "when", "begin", "rescue"]);

export function indentBranches(lines: string[]): number {
  let n = 0;
  for (const t of lines) n += (t.match(INDENT_BRANCH) ?? []).length + countLit(t, "&&") + countLit(t, "||");
  return n;
}

export function indentDepth(lines: string[]): number {
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
