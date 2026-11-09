// Scan TS/TSX sources for functions with high branch counts.
// Usage: node scripts/complexity-scan.mjs
import ts from "typescript";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["modules", "packages", "hosts"];
const SKIP = /node_modules|dist|\.test\.|\.spec\.|__tests__|\.d\.ts$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);

function countBranches(node) {
  let n = 0;
  const visit = (n2) => {
    if (BRANCH_KINDS.has(n2.kind)) n++;
    // count each case clause of a switch as a branch
    if (n2.kind === ts.SyntaxKind.CaseClause) n++;
    // logical operators count as branches too
    if (
      n2.kind === ts.SyntaxKind.BinaryExpression &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n2.operatorToken.kind)
    ) n++;
    ts.forEachChild(n2, visit);
  };
  visit(node);
  return n;
}

function funcName(node, sf) {
  if (node.name) return node.name.getText(sf);
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && p.name) return p.name.getText(sf);
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
  if (p && ts.isCallExpression(p)) return "(callback)";
  return "(anonymous)";
}

const results = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  let files;
  try { files = [...walk(abs)]; } catch { continue; }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        const branches = countBranches(node);
        if (branches > 8) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          results.push({ file: relative(ROOT, file), line: line + 1, name: funcName(node, sf), branches });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

results.sort((a, b) => b.branches - a.branches);
for (const r of results) console.log(`${String(r.branches).padStart(3)}  ${r.file}:${r.line}  ${r.name}`);
console.log(`\nTotal functions >8 branches: ${results.length}`);
console.log(`>10 branches: ${results.filter((r) => r.branches > 10).length}`);
console.log(`>15 branches: ${results.filter((r) => r.branches > 15).length}`);
