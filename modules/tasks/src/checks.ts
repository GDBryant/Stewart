import type { HostPort } from "@stewart/kernel";
import { checkCommands } from "./commandChecks.js";
import type { Check, CheckInput, CheckResult, Evidence, RunCheckArgs, WriteRecord } from "./checkTypes.js";

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
 * was then fixed by another write or a shell edit is not a failure (when the diff is unknown, it is).
 */
function failedWrites(input: CheckInput): WriteRecord[] {
  const last = new Map<string, WriteRecord>();
  for (const w of input.writes) last.set(w.path, w);
  const changed = new Set(input.changed ?? []);
  return [...last.values()].filter((w) => !w.ok && (input.changed === undefined || !changed.has(w.path)));
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

function fileErr(f: unknown, i: number): string | null {
  const e = f as Record<string, unknown>;
  if (typeof e?.path !== "string" || typeof e?.loc !== "number" || typeof e?.score !== "number" || !BANDS.has(e?.band as string))
    return `files[${i}] needs {path, loc, score, band: Green|Yellow|Red}`;
  return null;
}

function findingErr(f: unknown, i: number): string | null {
  const e = f as Record<string, unknown>;
  if (typeof e?.path !== "string" || typeof e?.smell !== "string" || !SEVERITIES.has(e?.severity as string) || typeof e?.refactor !== "string")
    return `findings[${i}] needs {path, smell, severity: high|med|low, refactor}`;
  return null;
}

function filesErr(files: unknown): string | null {
  if (!Array.isArray(files)) return "files is not an array";
  for (const [i, f] of files.entries()) {
    const err = fileErr(f, i);
    if (err) return err;
  }
  return null;
}

function findingsErr(findings: unknown): string | null {
  if (findings !== undefined && !Array.isArray(findings)) return "findings is not an array";
  for (const [i, f] of ((findings as unknown[] | undefined) ?? []).entries()) {
    const err = findingErr(f, i);
    if (err) return err;
  }
  return null;
}

function shapeErr(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "report is not an object";
  const r = v as Record<string, unknown>;
  return filesErr(r.files) ?? findingsErr(r.findings) ?? (Array.isArray(r.notChecked) ? null : "notChecked is not an array");
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
  const shape = shapeErr(report);
  if (shape) {
    bad(`health report: ${shape}`);
    return;
  }
  const r = report as { files: { path: string }[]; findings?: { path: string }[] };
  const paths = [...r.files.map((f) => f.path), ...(r.findings ?? []).map((f) => f.path)];
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
  for (const w of failedWrites(args.input)) {
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
