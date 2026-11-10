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

export function mergeReports(reports: HealthReport[]): HealthReport {
  const files = new Map<string, FileHealth>();
  const findings = new Map<string, Finding>();
  const notChecked = new Set<string>();
  const checks = new Map<string, ProjectCheck>();
  for (const r of reports) {
    for (const f of r.files ?? []) files.set(f.path, f);
    for (const f of r.findings ?? []) findings.set(`${f.path}:${f.line ?? ""}:${f.smell}:${f.severity}`, f);
    for (const p of r.notChecked ?? []) notChecked.add(p);
    for (const c of r.checks ?? []) checks.set(`${c.name}|${c.command}`, c);
  }
  return { files: [...files.values()], findings: [...findings.values()], notChecked: [...notChecked], checks: [...checks.values()] };
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

export function renderReport(a: Aggregate, r: HealthReport, mode: "score" | "issues", measured?: string): string {
  const lines: string[] = [];
  lines.push(
    `Scope: project · Mode: ${mode} · Checked: ${a.files} files / ${a.loc} LOC · Not checked: ${a.notChecked.length}`,
  );
  lines.push(`Overall: ${a.score}/10 (${a.band})`);
  if (measured) lines.push(measured);
  if (r.checks && r.checks.length > 0) {
    lines.push("Project checks:");
    for (const c of r.checks) lines.push(`- ${c.name}: ${c.status} — \`${c.command}\` — ${c.detail}`);
  }
  if (a.red.length > 0) {
    lines.push("Red files:");
    for (const f of a.red) lines.push(`- ${f.path} ${f.score}/10 (${f.loc} LOC)`);
  }
  const sorted = [...r.files].sort((x, y) => y.loc - x.loc);
  for (const f of sorted) lines.push(`${f.path}\t${f.loc}\t${f.score}/10 ${f.band}`);
  if (a.notChecked.length > 0) {
    lines.push("Not checked:");
    for (const p of a.notChecked) lines.push(`- ${p}`);
  }
  if (mode === "issues" && r.findings.length > 0) {
    lines.push("Findings:");
    const ordered = [...r.findings].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
    for (const f of ordered) lines.push(`${f.path}:${f.line ?? "?"}\t${f.smell} | ${f.severity} | ${f.refactor}`);
  }
  return lines.join("\n");
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
