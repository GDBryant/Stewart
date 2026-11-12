import type { HostPort, ProcessHandle } from "@stewart/kernel";

/** A check code runs after a turn: files that must exist, and/or a command that must exit 0. */
export interface Check {
  /** Workspace-relative paths that must exist after the turn. */
  files?: string[];
  /** Argv run in the project root; must exit 0. */
  command?: string[];
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
  return { files: input.changed };
}

/** WriteRecord paths whose last record is a failure. */
function failedWrites(writes: WriteRecord[]): WriteRecord[] {
  const last = new Map<string, WriteRecord>();
  for (const w of writes) last.set(w.path, w);
  return [...last.values()].filter((w) => !w.ok);
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
  await checkCommand(args, evidence);
  checkReply(args.input, evidence);
  const failed = evidence.some((e) => e.startsWith("write to ") || e.startsWith("missing:") || e === "empty reply" || e.includes(" exited ") || e.includes(" timed out "));
  return { passed: !failed, evidence };
}
