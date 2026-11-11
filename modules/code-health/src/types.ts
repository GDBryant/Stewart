export type Band = "Green" | "Yellow" | "Red";

export interface FileHealth {
  path: string;
  loc: number;
  score: number;
  band: Band;
}

export interface Finding {
  path: string;
  line?: number;
  smell: string;
  severity: "high" | "med" | "low";
  refactor: string;
}

export interface ProjectCheck {
  name: string;
  command: string;
  status: "pass" | "fail" | "not run";
  detail: string;
}

export interface HealthReport {
  files: FileHealth[];
  findings: Finding[];
  notChecked: string[];
  checks?: ProjectCheck[];
}

export interface InventoryEntry {
  path: string;
  loc: number;
}

export interface Aggregate {
  score: number;
  band: Band;
  files: number;
  loc: number;
  red: FileHealth[];
  worst?: FileHealth;
  bySmell: Record<string, number>;
  notChecked: string[];
}

export interface FunctionMetric {
  name: string;
  line: number;
  lines: number;
  branches: number;
  depth: number;
}

export interface Suppression {
  line: number;
  text: string;
}

export interface FileMetrics {
  path: string;
  loc: number;
  measured: boolean;
  functions: FunctionMetric[];
  suppressions: Suppression[];
}

export interface MetricsSummary {
  files: number;
  loc: number;
  notMeasured: number;
  functions: number;
  branchesOver10: number;
  branchesOver15: number;
  linesOver60: number;
  linesOver120: number;
  depth4: number;
  depth5: number;
  filesOver500: number;
  filesOver1000: number;
  suppressions: number;
}

export function bandFor(score: number): Band {
  if (score >= 9.5) return "Green";
  if (score >= 7.0) return "Yellow";
  return "Red";
}

export function batchInventory(files: InventoryEntry[], max = { files: 8, loc: 3000 }): InventoryEntry[][] {
  const batches: InventoryEntry[][] = [];
  let current: InventoryEntry[] = [];
  let loc = 0;
  for (const f of files) {
    if (current.length > 0 && (current.length >= max.files || loc + f.loc > max.loc)) {
      batches.push(current);
      current = [];
      loc = 0;
    }
    current.push(f);
    loc += f.loc;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface MergeState {
  files: Map<string, FileHealth>;
  findings: Map<string, Finding>;
  notChecked: Set<string>;
  checks: Map<string, ProjectCheck>;
}

function findingKey(f: Finding): string {
  return `${f.path}:${f.line ?? ""}:${f.smell}:${f.severity}`;
}

function checkKey(c: ProjectCheck): string {
  return `${c.name}|${c.command}`;
}

/** Folds one report into the merge state; a later report overwrites an earlier entry with the same key. */
function mergeInto(state: MergeState, r: HealthReport): void {
  for (const f of r.files ?? []) state.files.set(f.path, f);
  for (const f of r.findings ?? []) state.findings.set(findingKey(f), f);
  for (const p of r.notChecked ?? []) state.notChecked.add(p);
  for (const c of r.checks ?? []) state.checks.set(checkKey(c), c);
}

export function mergeReports(reports: HealthReport[]): HealthReport {
  const state: MergeState = { files: new Map(), findings: new Map(), notChecked: new Set(), checks: new Map() };
  for (const r of reports) mergeInto(state, r);
  return {
    files: [...state.files.values()],
    findings: [...state.findings.values()],
    notChecked: [...state.notChecked],
    checks: [...state.checks.values()],
  };
}

export function aggregate(report: HealthReport): Aggregate {
  const files = report.files ?? [];
  const loc = files.reduce((s, f) => s + f.loc, 0);
  const score = loc > 0 ? Math.round((files.reduce((s, f) => s + f.score * f.loc, 0) / loc) * 10) / 10 : 0;
  const bySmell: Record<string, number> = {};
  for (const f of report.findings ?? []) bySmell[f.smell] = (bySmell[f.smell] ?? 0) + 1;
  const red = files.filter((f) => f.band === "Red").sort((a, b) => a.score - b.score);
  const worst = files.length ? files.reduce((w, f) => (f.score < w.score ? f : w)) : undefined;
  return { score, band: bandFor(score), files: files.length, loc, red, worst, bySmell, notChecked: report.notChecked ?? [] };
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { high: 0, med: 1, low: 2 };

function checkLines(checks: ProjectCheck[] | undefined): string[] {
  if (!checks || checks.length === 0) return [];
  return ["Project checks:", ...checks.map((c) => `- ${c.name}: ${c.status} — \`${c.command}\` — ${c.detail}`)];
}

function redLines(red: FileHealth[]): string[] {
  if (red.length === 0) return [];
  return ["Red files:", ...red.map((f) => `- ${f.path} ${f.score}/10 (${f.loc} LOC)`)];
}

function fileLines(files: FileHealth[]): string[] {
  const sorted = [...files].sort((x, y) => y.loc - x.loc);
  return sorted.map((f) => `${f.path}\t${f.loc}\t${f.score}/10 ${f.band}`);
}

function notCheckedLines(notChecked: string[]): string[] {
  if (notChecked.length === 0) return [];
  return ["Not checked:", ...notChecked.map((p) => `- ${p}`)];
}

function findingLines(findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  const ordered = [...findings].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  return ["Findings:", ...ordered.map((f) => `${f.path}:${f.line ?? "?"}\t${f.smell} | ${f.severity} | ${f.refactor}`)];
}

export function renderReport(a: Aggregate, r: HealthReport, mode: "score" | "issues", measured?: string): string {
  const sections: string[][] = [
    [
      `Scope: project · Mode: ${mode} · Checked: ${a.files} files / ${a.loc} LOC · Not checked: ${a.notChecked.length}`,
      `Overall: ${a.score}/10 (${a.band})`,
    ],
    measured ? [measured] : [],
    checkLines(r.checks),
    redLines(a.red),
    fileLines(r.files),
    notCheckedLines(a.notChecked),
    mode === "issues" ? findingLines(r.findings) : [],
  ];
  return sections.flat().join("\n");
}

const HEALTH_TERM = /\b(health|healthy|code health|score the code)\b/i;
const SCOPE_TERM = /\b(project|codebase|code base|repo|repository|this code|folders?|directory|dirs?|modules?|packages?|files?)\b/i;

export function isHealthCheckRequest(text: string): boolean {
  return HEALTH_TERM.test(text) && SCOPE_TERM.test(text);
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".kt", ".java", ".py", ".go", ".rs",
  ".c", ".h", ".cpp", ".cc", ".hpp", ".cs",
  ".rb", ".php", ".swift", ".scala", ".vue", ".svelte",
]);

const EXCLUDED_DIRS = new Set(["dist", "build", "out", "node_modules", "coverage", "target", "vendor", "bin", "obj"]);
const TEST_FILE = /(\.test\.|\.spec\.|_test\.go$|Tests?\.(java|ts|cs)$)/;
const GENERATED = /(\.d\.ts$|\.min\.|\.generated\.|\.lock$)/i;

export function isSourceFile(path: string, opts: { includeTests?: boolean } = {}): boolean {
  const norm = path.replace(/\\/g, "/");
  const parts = norm.split("/").filter((p) => p !== ".");
  if (parts.some((p) => p.startsWith(".") || EXCLUDED_DIRS.has(p))) return false;
  const name = parts[parts.length - 1];
  if (GENERATED.test(name)) return false;
  if (!opts.includeTests && (TEST_FILE.test(name) || parts.includes("test") || parts.includes("tests") || parts.includes("__tests__"))) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
