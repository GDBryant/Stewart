import { exitCause, type ProcessHandle } from "@stewart/kernel";
import type { Evidence, RunCheckArgs } from "./checkTypes.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_TAIL = 1500;

function runCommand(argv: string[], host: RunCheckArgs["host"], cwd: string, onData: (d: string) => void): ProcessHandle {
  return host.proc.run(argv, { cwd, onData });
}

async function checkOneCommand(args: RunCheckArgs, argv: string[], out: Evidence[]): Promise<boolean> {
  let output = "";
  const handle = runCommand(argv, args.host, args.cwd, (d) => {
    output += d;
  });
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    handle.done.then((r) => ({ code: r.code, cause: r.cause, timeout: false })),
    new Promise<{ code: number; cause?: string; timeout: boolean }>((res) => {
      timer = setTimeout(() => res({ code: -1, timeout: true }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut.timeout) {
    await handle.killTree();
    out.push({ code: "command_timeout", ok: false, detail: `${argv.join(" ")} timed out after ${timeoutMs}ms` });
    return false;
  }
  if (timedOut.code !== 0) {
    out.push(commandFailedEvidence(argv, timedOut.code, output, timedOut.cause));
    return false;
  }
  out.push({ code: "command_ok", ok: true, detail: `command ok: ${argv.join(" ")}` });
  return true;
}

function commandFailedEvidence(argv: string[], code: number, output: string, reported?: string): Evidence {
  const cause = reported ?? exitCause(code);
  const detail = `${argv.join(" ")} exited ${code}${cause ? ` (${cause})` : ""}: ${output.slice(-OUTPUT_TAIL)}`;
  if (reported?.startsWith("cannot start") || code === 126 || code === 127)
    return { code: "command_unavailable", ok: false, detail: `check could not run (environment): ${detail}` };
  return { code: "command_failed", ok: false, detail };
}

/** Commands run in order; the first failure (exit/timeout) stops the rest. */
export async function checkCommands(args: RunCheckArgs, out: Evidence[]): Promise<void> {
  for (const argv of args.check.commands ?? []) {
    if (!(await checkOneCommand(args, argv, out))) return;
  }
}
