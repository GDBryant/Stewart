import type { HostPort } from "@stewart/kernel";
import { checkCommands } from "./commandChecks.js";
import type { Check, CheckInput, CheckResult, Evidence, RunCheckArgs, WriteRecord } from "./checkTypes.js";
import { CHECK_STATUS, FINDING_EVIDENCE } from "./healthContract.js";

export type { Check, CheckInput, CheckResult, Evidence, EvidenceCode, RunCheckArgs, WriteRecord } from "./checkTypes.js";

/** Evidence details, for wire events and human text. */
export function evidenceText(evidence: Evidence[]): string[] {
  return evidence.map((e) => e.detail);
}

/** Only the failing details joined, for errors, handovers and task.failed. */
export function failureText(res: CheckResult): string {
  return res.evidence.filter((e) => !e.ok).map((e) => e.detail).join("; ");
}

/** The turn's check from the declared contract only (`set_check`, `delegate` check): files that must exist, a command that must exit 0. */
export function declaredCheck(declared?: { command?: string[]; files?: string[] }): Check {
  return { files: declared?.files ?? [], commands: declared?.command ? [declared.command] : undefined };
}

/**
 * WriteRecord paths whose last record failed and that the tracker does not report as changed — a failure that
 * was then fixed by another write or a shell edit is not a failure (when the diff is unknown, it is), and
 * neither is a mistyped path that does not exist once a later write record succeeded.
 */
async function failedWrites(input: CheckInput, host: Pick<HostPort, "files">): Promise<WriteRecord[]> {
  const last = new Map<string, WriteRecord>();
  for (const w of input.writes) last.set(w.path, w);
  const changed = new Set(input.changed ?? []);
  const out: WriteRecord[] = [];
  for (const w of last.values()) {
    if (w.ok || changed.has(w.path)) continue;
    const laterOk = input.writes.slice(input.writes.lastIndexOf(w) + 1).some((x) => x.ok);
    const mistyped = laterOk && !(await host.files.exists(w.path).catch(() => false));
    if (!mistyped) out.push(w);
  }
  return out;
}

async function checkFiles(files: string[], host: Pick<HostPort, "files">, out: Evidence[]): Promise<void> {
  for (const f of files) {
    try {
      if (!(await host.files.exists(f))) {
        out.push({ code: "file_missing", ok: false, detail: `missing: ${f}` });
        continue;
      }
      await host.files.readBack(f);
      out.push({ code: "file_present", ok: true, detail: `changed: ${f}` });
    } catch {
      out.push({ code: "file_missing", ok: false, detail: `missing: ${f}` });
    }
  }
}

const CITATION = /[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,12}(?::\d+)?/g;

interface Citation {
  path: string;
  line?: number;
  /** Has a directory part: a missing one is a bad citation; bare names count only when they exist. */
  slashed: boolean;
}

function citations(reply: string): Citation[] {
  const out = new Map<string, Citation>();
  for (const m of reply.matchAll(CITATION)) {
    const [p, line] = m[0].split(":");
    const c = { path: p, line: line ? Number(line) : undefined, slashed: p.includes("/") };
    out.set(m[0], c);
  }
  return [...out.values()];
}

async function lineCount(host: Pick<HostPort, "files">, p: string): Promise<number> {
  return (await host.files.read(p)).content.split("\n").length;
}

/** Evidence for one citation, or null when a bare name is not a file (prose like `e.g.` or `3.0.0`). */
async function citeEvidence(c: Citation, host: Pick<HostPort, "files">): Promise<Evidence | null> {
  if (!(await host.files.exists(c.path))) return c.slashed ? { code: "citation_missing", ok: false, detail: `missing citation: ${c.path}` } : null;
  if (c.line !== undefined && (c.line < 1 || c.line > (await lineCount(host, c.path))))
    return { code: "citation_bad_line", ok: false, detail: `bad line citation: ${c.path}:${c.line}` };
  return { code: "cited", ok: true, detail: `cited: ${c.path}${c.line !== undefined ? `:${c.line}` : ""}` };
}

async function checkCites(args: RunCheckArgs, out: Evidence[]): Promise<void> {
  for (const c of citations(args.input.reply)) {
    const e = await citeEvidence(c, args.host);
    if (e) out.push(e);
  }
}

const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;
const BANDS = new Set(["Green", "Yellow", "Red"]);
const SEVERITIES = new Set(["high", "med", "low"]);
const EVIDENCE = new Set<string>(FINDING_EVIDENCE);
const CHECK_STATUSES = new Set<string>(CHECK_STATUS);
const RANGE = /^\d+-\d+$/;

function relPathErr(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "missing path";
  const n = p.replace(/\\/g, "/");
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n) || n.split("/").includes("..") ? `path must be project-relative: ${p}` : null;
}

function badLoc(v: unknown): boolean {
  return !Number.isInteger(v) || (v as number) < 0;
}

function badScore(v: unknown): boolean {
  return typeof v !== "number" || v < 0 || v > 10;
}

function fileErr(f: unknown, i: number): string | null {
  const e = f as Record<string, unknown>;
  const path = relPathErr(e?.path);
  if (path || badLoc(e?.loc) || badScore(e?.score) || !BANDS.has(e?.band as string))
    return `files[${i}] needs {path, loc, score, band: Green|Yellow|Red}${path ? ` (${path})` : ""}`;
  return e.range != null && e.range !== "" && (typeof e.range !== "string" || !RANGE.test(e.range)) ? `files[${i}].range must be start-end` : null;
}

function findingShapeErr(f: unknown, i: number): string | null {
  const e = f as Record<string, unknown>;
  const path = relPathErr(e?.path);
  if (path || (e.line !== undefined && (!Number.isInteger(e.line) || (e.line as number) < 1)) || typeof e?.smell !== "string" || !SEVERITIES.has(e?.severity as string) || typeof e?.refactor !== "string" || !EVIDENCE.has(e?.evidence as string))
    return `findings[${i}] needs {path, smell, severity: high|med|low, refactor, evidence: verified|unverified}${path ? ` (${path})` : ""}`;
  return null;
}

function findingErr(f: unknown, i: number): string | null {
  const shape = findingShapeErr(f, i);
  if (shape) return shape;
  const e = f as Record<string, unknown>;
  return e.evidence === "unverified" && (typeof e.verification !== "string" || !e.verification.trim()) ? `findings[${i}].verification names the missing check` : null;
}

function checkErr(c: unknown, i: number): string | null {
  const e = c as Record<string, unknown>;
  return typeof e?.name !== "string" || typeof e?.command !== "string" || !CHECK_STATUSES.has(e?.status as string) || typeof e?.detail !== "string"
    ? `checks[${i}] needs {name, command, status: ${CHECK_STATUS.join("|")}, detail}`
    : null;
}

function entriesErr(entries: unknown, field: string, err: (v: unknown, i: number) => string | null): string | null {
  if (!Array.isArray(entries)) return `${field} is not an array`;
  for (const [i, e] of entries.entries()) {
    const bad = err(e, i);
    if (bad) return bad;
  }
  return null;
}

function shapeErr(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "report is not an object";
  const r = v as Record<string, unknown>;
  return entriesErr(r.files, "files", fileErr)
    ?? (r.findings === undefined ? null : entriesErr(r.findings, "findings", findingErr))
    ?? (r.checks === undefined ? null : entriesErr(r.checks, "checks", checkErr))
    ?? notCheckedErr(r.notChecked);
}

function notCheckedErr(v: unknown): string | null {
  if (!Array.isArray(v)) return "notChecked is not an array";
  for (const [i, p] of v.entries()) {
    const bad = relPathErr(p);
    if (bad || typeof p !== "string") return `notChecked[${i}] needs a project-relative path`;
  }
  return null;
}

function scopeOf(s: string): { path: string; range?: string } {
  const m = /^(.*):(\d+-\d+)$/.exec(s);
  return m ? { path: m[1], range: m[2] } : { path: s };
}

function inScope(s: string, path: string, line: number | undefined): boolean {
  const want = scopeOf(s);
  if (want.path !== path) return false;
  if (!want.range) return true;
  const [start, end] = want.range.split("-").map(Number);
  return line !== undefined && line >= start && line <= end;
}

function scopeErr(files: { path: string; range?: string }[], findings: { path: string; line?: number; evidence: string }[] | undefined, scope: string[] | undefined): string | null {
  for (const s of scope ?? []) {
    const want = scopeOf(s);
    if (!files.some((f) => f.path === want.path && (f.range || undefined) === want.range)) return `health report: scope not covered: ${s}`;
  }
  const outside = scope?.length ? (findings ?? []).find((f) => f.evidence !== "verified" && !scope.some((s) => inScope(s, f.path, f.line))) : undefined;
  return outside ? `health report: unverified finding outside declared scope: ${outside.path}${outside.line === undefined ? "" : `:${outside.line}`}` : null;
}

type HealthJson = { files: { path: string; range?: string }[]; findings?: { path: string; line?: number; evidence: string }[]; notChecked: string[] };

function healthStaticErr(report: unknown, scope: string[] | undefined): string | null {
  const shape = shapeErr(report);
  if (shape) return `health report: ${shape}`;
  const r = report as HealthJson;
  if (scope && !scope.length && (r.files.length || r.findings?.length || r.notChecked.length)) return "health report: a checks task reports only checks[]; files, findings and notChecked must be empty";
  return scopeErr(r.files, r.findings, scope);
}

async function checkHealth(args: RunCheckArgs, out: Evidence[]): Promise<void> {
  const bad = (detail: string) => out.push({ code: "health_invalid", ok: false, detail });
  const blocks = [...args.input.reply.matchAll(JSON_BLOCK)];
  if (blocks.length !== 1) {
    bad(`health report: expected exactly one \`\`\`json block, found ${blocks.length}`);
    return;
  }
  let report: unknown;
  try {
    report = JSON.parse(blocks[0][1]);
  } catch {
    bad("health report: invalid JSON");
    return;
  }
  const stat = healthStaticErr(report, args.check.healthScope);
  if (stat) {
    bad(stat);
    return;
  }
  const r = report as HealthJson;
  const paths = [...r.files.map((f) => f.path), ...(r.findings ?? []).map((f) => f.path), ...r.notChecked];
  let missing = 0;
  for (const p of paths)
    if (!(await args.host.files.exists(p))) {
      missing++;
      bad(`health report: missing file ${p}`);
    }
  if (!missing) out.push({ code: "health_ok", ok: true, detail: `health: ${r.files.length} files, ${r.findings?.length ?? 0} findings` });
}

const PATH_VIOLATION_CAP = 10;

function checkPaths(check: Check, input: CheckInput, out: Evidence[]): void {
  if (!check.pathRule || input.changed === undefined) return;
  const bad = input.changed.map((p) => ({ p, reason: check.pathRule!(p) })).filter((x): x is { p: string; reason: string } => x.reason !== null);
  const say = (detail: string) => out.push({ code: "policy_violation", ok: false, detail });
  for (const v of bad.slice(0, PATH_VIOLATION_CAP)) say(`changed outside role policy: ${v.p} (${v.reason})`);
  if (bad.length > PATH_VIOLATION_CAP) say(`changed outside role policy: and ${bad.length - PATH_VIOLATION_CAP} more`);
}

function checkReply(input: CheckInput, out: Evidence[]): void {
  const nothing = !input.reply.trim().length && (input.changed === undefined || input.changed.length === 0);
  if (nothing) out.push({ code: "empty_reply", ok: false, detail: "empty reply" });
}

/** Run one turn check: failed writes, required files, optional command, non-empty reply. */
export async function runCheck(args: RunCheckArgs): Promise<CheckResult> {
  const evidence: Evidence[] = [];
  for (const w of await failedWrites(args.input, args.host)) {
    evidence.push({ code: "write_failed", ok: false, detail: `write to ${w.path} failed: ${w.message ?? "unknown"}` });
  }
  await checkFiles(args.check.files ?? [], args.host, evidence);
  await checkCommands(args, evidence);
  if (args.check.cites) await checkCites(args, evidence);
  if (args.check.needsRead && !args.input.reads) evidence.push({ code: "no_read", ok: false, detail: "no file was read" });
  if (args.check.mustChange && args.input.changed?.length === 0)
    evidence.push({ code: "no_change", ok: false, detail: "no file changed" });
  checkPaths(args.check, args.input, evidence);
  if (args.check.schema === "health") await checkHealth(args, evidence);
  checkReply(args.input, evidence);
  return { passed: evidence.every((e) => e.ok), evidence };
}
