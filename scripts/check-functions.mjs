#!/usr/bin/env node
// Function-level limits (docs/building/MODULAR_DESIGN.md §7 step 8; eslint-equivalent metrics, no eslint dependency).
// Per function (TS/TSX under modules|packages|hosts/*/src, no tests): code lines (blank/comment-only skipped),
// cyclomatic complexity (1 + if ?: loops case catch && || ??), block nesting depth, parameter count.
// Limits live in scripts/functions.json. Known offenders live in scripts/functions.baseline.json with their current
// metrics; a function fails if it is new and over a limit, or if any baselined metric grows. `--update` rewrites the
// baseline (drops fixed entries, never adds), `--report` lists the worst offenders.
import ts from "typescript";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FN = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
const DECISION = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CaseClause, ts.SyntaxKind.CatchClause,
]);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const NEST = (n) =>
  ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) ||
  ts.isDoStatement(n) || ts.isSwitchStatement(n) || ts.isTryStatement(n);

function nameOf(node, sf) {
  if (node.name) return node.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
  if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return p.name.getText(sf);
  return ts.isCallExpression(p) ? "(callback)" : "(anonymous)";
}

/** Metrics for one function; nested functions are measured on their own, not folded into the parent. */
export function measure(node, sf) {
  let complexity = 1;
  let depth = 0;
  const visit = (n, d) => {
    if (n !== node && FN(n)) return;
    if (DECISION.has(n.kind)) complexity++;
    if (ts.isBinaryExpression(n) && LOGICAL.has(n.operatorToken.kind)) complexity++;
    let nd = d;
    if (NEST(n) && !(ts.isIfStatement(n) && ts.isIfStatement(n.parent) && n.parent.elseStatement === n)) {
      nd = d + 1;
      depth = Math.max(depth, nd);
    }
    ts.forEachChild(n, (c) => visit(c, nd));
  };
  visit(node, 0);
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const end = sf.getLineAndCharacterOfPosition(node.end).line;
  const text = sf.text.split("\n").slice(start, end + 1);
  const lines = text.filter((l) => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).length;
  return { lines, complexity, depth, params: node.parameters.length };
}

/** `{ "<file>::<name>[#n]": { line, lines, complexity, depth, params } }` for every function in the files. */
export function scanFiles(files) {
  const out = {};
  for (const [rel, text] of Object.entries(files)) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const seen = {};
    const visit = (n) => {
      if (FN(n)) {
        const base = `${rel}::${nameOf(n, sf)}`;
        seen[base] = (seen[base] ?? 0) + 1;
        const key = seen[base] > 1 ? `${base}#${seen[base]}` : base;
        out[key] = { line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, ...measure(n, sf) };
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const METRICS = ["lines", "complexity", "depth", "params"];
export const over = (m, limits) => METRICS.filter((k) => m[k] > limits[k]);

/** Failures: a new function over a limit, or a baselined function whose metric grew. */
export function findFailures(found, baseline, limits) {
  const fails = [];
  for (const [key, m] of Object.entries(found)) {
    const b = baseline[key];
    if (!b) {
      for (const k of over(m, limits)) fails.push(`${key} ${k} ${m[k]} > ${limits[k]}`);
    } else {
      for (const k of METRICS) if (m[k] > Math.max(b[k], limits[k])) fails.push(`${key} ${k} ${m[k]} > baseline ${Math.max(b[k], limits[k])}`);
    }
  }
  return fails.sort();
}

/** Baseline rewritten from the current scan: only functions still over a limit, at their current metrics. */
export function nextBaseline(found, baseline, limits) {
  const out = {};
  for (const key of Object.keys(baseline)) {
    const m = found[key];
    if (m && over(m, limits).length) out[key] = Object.fromEntries(METRICS.map((k) => [k, m[k]]));
  }
  return out;
}

const SKIP = new Set(["node_modules", "dist", "build", "coverage", "test", "tests"]);
function walk(dir, base, acc) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|d)\.tsx?$/.test(p)) acc[relative(base, p)] = readFileSync(p, "utf8");
  }
  return acc;
}

function main() {
  const root = join(fileURLToPath(import.meta.url), "../..");
  const limits = JSON.parse(readFileSync(join(root, "scripts/functions.json"), "utf8"));
  const bp = join(root, "scripts/functions.baseline.json");
  const baseline = existsSync(bp) ? JSON.parse(readFileSync(bp, "utf8")) : {};
  const files = {};
  for (const g of ["modules", "packages", "hosts"]) {
    if (!existsSync(join(root, g))) continue;
    for (const d of readdirSync(join(root, g))) if (existsSync(join(root, g, d, "src"))) walk(join(root, g, d, "src"), root, files);
  }
  const found = scanFiles(files);
  if (process.argv.includes("--init")) {
    const b = {};
    for (const [k, m] of Object.entries(found)) if (over(m, limits).length) b[k] = Object.fromEntries(METRICS.map((x) => [x, m[x]]));
    writeFileSync(bp, JSON.stringify(b, null, 2) + "\n");
    console.log(`baseline written: ${Object.keys(b).length} functions over limits`);
    return;
  }
  if (process.argv.includes("--update")) {
    const b = nextBaseline(found, baseline, limits);
    writeFileSync(bp, JSON.stringify(b, null, 2) + "\n");
    console.log(`baseline: ${Object.keys(baseline).length} -> ${Object.keys(b).length}`);
    return;
  }
  if (process.argv.includes("--report")) {
    const rows = Object.entries(found).filter(([, m]) => over(m, limits).length)
      .sort((a, b) => b[1].complexity - a[1].complexity || b[1].lines - a[1].lines);
    for (const [k, m] of rows.slice(0, 60)) console.log(`cx ${String(m.complexity).padStart(2)}  ln ${String(m.lines).padStart(3)}  d ${m.depth}  p ${m.params}  ${k}`);
    console.log(`\n${rows.length} functions over limits (baselined ${Object.keys(baseline).length})`);
    return;
  }
  const fails = findFailures(found, baseline, limits);
  const fixed = Object.keys(baseline).filter((k) => !found[k] || !over(found[k], limits).length);
  if (fixed.length) console.warn(`function limits: ${fixed.length} baselined functions now clean; run --update`);
  if (fails.length) {
    console.error(`function limits: ${fails.length} failure(s)\n${fails.join("\n")}`);
    process.exit(1);
  }
  console.log(`function limits ok (${Object.keys(baseline).length} baselined offenders)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
