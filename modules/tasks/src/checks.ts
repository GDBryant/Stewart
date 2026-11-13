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
  /** The request asked for an edit: some file must change (write tool or on disk), unless a declared command passed. */
  edit?: boolean;
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
  /** Successful read/search tool calls this turn; a "no findings" report needs at least one. */
  reads?: number;
  /** Files changed on disk during the turn by any means (git worktree diff); undefined = unknown. */
  diskChanged?: string[];
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
async function citeEvidence(c: Citation, host: Pick<HostPort, "files">): Promise<string | null> {
  if (!(await host.files.exists(c.path))) return c.slashed ? `missing citation: ${c.path}` : null;
  if (c.line !== undefined && (c.line < 1 || c.line > (await lineCount(host, c.path)))) return `bad line citation: ${c.path}:${c.line}`;
  return `cited: ${c.path}${c.line !== undefined ? `:${c.line}` : ""}`;
}

async function checkCites(args: RunCheckArgs, out: string[]): Promise<void> {
  const found: string[] = [];
  for (const c of citations(args.input.reply)) {
    const e = await citeEvidence(c, args.host);
    if (e) found.push(e);
  }
  if (found.length) {
    out.push(...found);
    return;
  }
  if (!NO_FINDINGS.test(args.input.reply)) out.push("no file citations in reply");
  else if (args.input.reads === 0) out.push("no findings reported without reading any file");
  else out.push("no findings reported");
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

/** An edit request passes only when a file changed (write tool or on disk) or a declared command passed. */
function checkEdit(args: RunCheckArgs, out: string[]): void {
  if (!args.check.edit) return;
  if (args.input.changed.length || args.input.diskChanged?.length) return;
  if (out.some((e) => e.startsWith("command ok: "))) return;
  out.push("edit request: no file changed");
}

const FAIL_PREFIXES = ["write to ", "missing:", "unchanged:", "missing citation:", "bad line citation:", "edit request:", "health report:"];
const FAIL_EXACT = new Set(["empty reply", "no file citations in reply", "no findings reported without reading any file"]);

function isFailure(e: string): boolean {
  return FAIL_PREFIXES.some((p) => e.startsWith(p)) || FAIL_EXACT.has(e) || e.includes(" exited ") || e.includes(" timed out ");
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
  checkEdit(args, evidence);
  return { passed: !evidence.some(isFailure), evidence };
}

const REPORT_GOAL = /\b(review|audit|code[- ]?health|health report|findings|code smells?|report on)\b/i;

/** True when the user's request asks for a review-style report (the reply must then cite real files). */
export function isReportGoal(goal: string): boolean {
  return REPORT_GOAL.test(goal);
}

const EDIT_VERBS = "add|fix|implement|create|edit|change|update|refactor|rename|remove|delete|replace|modify|convert|move|bump|upgrade|migrate|insert|append";
const EDIT_GOAL = new RegExp(`^\\s*(please[\\s,]+)?((can|could|would|will) you[\\s,]+)?(please[\\s,]+)?(${EDIT_VERBS})\\b`, "i");
const QUESTION_LEAD = /^\s*(how|what|why|where|when|which|who|is|are|does|do|should|explain|describe|tell me|show me)\b/i;

/**
 * True when the request is an imperative to change files ("fix the failing test", "can you add …").
 * Questions ("how do I fix …?", "explain …") are not edits.
 */
export function isEditGoal(goal: string): boolean {
  const first = goal.split("\n").find((l) => l.trim()) ?? "";
  return !QUESTION_LEAD.test(first) && EDIT_GOAL.test(first);
}
