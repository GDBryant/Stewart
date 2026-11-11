import type { FunctionMetric } from "./types.js";
import { braceKind, braceToks, braceDepth, countBranches, fnName, headerGroup, indentBranches, indentDepth, lineOf, lineStarts, matchBraces, parenBalance } from "./scanFunctions.js";

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
