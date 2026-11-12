import type { HostPort, ProcessHandle } from "@stewart/kernel";

/** A check code runs after a turn: files that must exist, and/or a command that must exit 0. */
export interface Check {
  /** Workspace-relative paths that must exist after the turn. */
  files?: string[];
  /** Paths whose content must differ from `CheckInput.before` (a path with no snapshot is not compared). */
  changed?: string[];
  /** Argv run in the project root; must exit 0. */
  command?: string[];
  /** Every project-path citation in the reply must exist; a findings-style reply needs at least one. */
  cites?: boolean;
  /** The reply must end with exactly one ```json block validating as a HealthReport. */
  schema?: "health";
}

/** One write-tool call outcome, in call order. */
export interface WriteRecord {
  path: string;
  ok: boolean;
  message?: string;
}

export interface CheckInput {
  reply: string;
  writes: WriteRecord[];
  changed: string[];
  /** Content of each written file before its first write this turn; null = did not exist. */
  before?: Record<string, string | null>;
}

export interface CheckResult {
  passed: boolean;
  evidence: string[];
}

export interface RunCheckArgs {
  check: Check;
  input: CheckInput;
  host: Pick<HostPort, "files" | "proc">;
  cwd: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_TAIL = 1500;

/** The lead turn's check: every file a write tool changed must exist afterwards. */
export function turnCheck(input: CheckInput): Check {
  return { files: input.changed, changed: input.changed };
}

/** The lead's turn check plus what the lead declared with `set_check` (a command, extra files). */
export function declaredCheck(input: CheckInput, declared?: { command?: string[]; files?: string[] }): Check {
  const base = turnCheck(input);
  return { ...base, files: [...(base.files ?? []), ...(declared?.files ?? [])], command: declared?.command };
}

/** WriteRecord paths whose last record is a failure. */
function failedWrites(writes: WriteRecord[]): WriteRecord[] {
  const last = new Map<string, WriteRecord>();
  for (const w of writes) last.set(w.path, w);
  return [...last.values()].filter((w) => !w.ok);
}

async function checkUnchanged(args: RunCheckArgs, out: string[]): Promise<void> {
  const before = args.input.before ?? {};
  for (const f of args.check.changed ?? []) {
    if (!(f in before)) continue;
    try {
      if (before[f] === (await args.host.files.readBack(f))) out.push(`unchanged: ${f}`);
    } catch {
      /* a missing file is reported by checkFiles */
    }
  }
}

async function checkFiles(files: string[], host: Pick<HostPort, "files">, out: string[]): Promise<void> {
  for (const f of files) {
    try {
      if (!(await host.files.exists(f))) {
        out.push(`missing: ${f}`);
        continue;
      }
      await host.files.readBack(f);
      out.push(`changed: ${f}`);
    } catch {
      out.push(`missing: ${f}`);
    }
  }
}

function runCommand(argv: string[], host: Pick<HostPort, "proc">, cwd: string, onData: (d: string) => void): ProcessHandle {
  return host.proc.run(argv, { cwd, onData });
}

async function checkCommand(args: RunCheckArgs, out: string[]): Promise<void> {
  const argv = args.check.command;
  if (!argv?.length) return;
  let output = "";
  const handle = runCommand(argv, args.host, args.cwd, (d) => {
    output += d;
  });
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    handle.done.then((r) => ({ code: r.code, timeout: false })),
    new Promise<{ code: number; timeout: boolean }>((res) => {
      timer = setTimeout(() => res({ code: -1, timeout: true }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut.timeout) {
    await handle.killTree();
    out.push(`${argv.join(" ")} timed out after ${timeoutMs}ms`);
    return;
  }
  if (timedOut.code !== 0) {
    out.push(`${argv.join(" ")} exited ${timedOut.code}: ${output.slice(-OUTPUT_TAIL)}`);
    return;
  }
  out.push(`command ok: ${argv.join(" ")}`);
}

const CITATION = /[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,12}(?::\d+)?/g;
const NO_FINDINGS = /could not find|cannot find|not found|no (matches|findings|results|problems|issues|files|reports)|nothing found/i;

function citationPaths(reply: string): string[] {
  const out = new Set<string>();
  for (const m of reply.matchAll(CITATION)) {
    const p = m[0].replace(/:\d+$/, "");
    if (p.includes("/")) out.add(p);
  }
  return [...out];
}

async function checkCites(args: RunCheckArgs, out: string[]): Promise<void> {
  const paths = citationPaths(args.input.reply);
  if (!paths.length) {
    out.push(NO_FINDINGS.test(args.input.reply) ? "no findings reported" : "no file citations in reply");
    return;
  }
  for (const p of paths) {
    out.push((await args.host.files.exists(p)) ? `cited: ${p}` : `missing citation: ${p}`);
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

async function checkHealth(args: RunCheckArgs, out: string[]): Promise<void> {
  const blocks = [...args.input.reply.matchAll(JSON_BLOCK)];
  if (blocks.length !== 1) {
    out.push(`health report: expected exactly one \`\`\`json block, found ${blocks.length}`);
    return;
  }
  let report: unknown;
  try {
    report = JSON.parse(blocks[0][1]);
  } catch {
    out.push("health report: invalid JSON");
    return;
  }
  const bad = shapeErr(report);
  if (bad) {
    out.push(`health report: ${bad}`);
    return;
  }
  const r = report as { files: { path: string }[]; findings?: { path: string }[] };
  const paths = [...r.files.map((f) => f.path), ...(r.findings ?? []).map((f) => f.path)];
  let missing = 0;
  for (const p of paths) if (!(await args.host.files.exists(p))) {
    missing++;
    out.push(`health report: missing file ${p}`);
  }
  if (!missing) out.push(`health: ${r.files.length} files, ${r.findings?.length ?? 0} findings`);
}

function checkReply(input: CheckInput, out: string[]): void {
  const nothing = !input.writes.length && !input.changed.length && !input.reply.trim().length;
  if (nothing) out.push("empty reply");
}

/** Run one turn check: failed writes, required files, optional command, non-empty reply. */
export async function runCheck(args: RunCheckArgs): Promise<CheckResult> {
  const evidence: string[] = [];
  for (const w of failedWrites(args.input.writes)) {
    evidence.push(`write to ${w.path} failed: ${w.message ?? "unknown"}`);
  }
  await checkFiles(args.check.files ?? [], args.host, evidence);
  await checkUnchanged(args, evidence);
  await checkCommand(args, evidence);
  if (args.check.cites) await checkCites(args, evidence);
  if (args.check.schema === "health") await checkHealth(args, evidence);
  checkReply(args.input, evidence);
  const failed = evidence.some(
    (e) =>
      e.startsWith("write to ") ||
      e.startsWith("missing:") ||
      e.startsWith("unchanged:") ||
      e.startsWith("missing citation:") ||
      e === "empty reply" ||
      e === "no file citations in reply" ||
      e.startsWith("health report:") ||
      e.includes(" exited ") ||
      e.includes(" timed out "),
  );
  return { passed: !failed, evidence };
}

const REPORT_GOAL = /\b(review|audit|code[- ]?health|health report|findings|code smells?|report on)\b/i;

/** True when the user's request asks for a review-style report (the reply must then cite real files). */
export function isReportGoal(goal: string): boolean {
  return REPORT_GOAL.test(goal);
}
