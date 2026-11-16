import type { ProcessHandle, ProcessPort } from "./ports.js";

const START_FAILURE = 0xc0000142;

/** True when `code` is the Windows "DLL initialisation failed" status (seen signed or unsigned). */
export function isStartFailure(code: number): boolean {
  return code === START_FAILURE || code === START_FAILURE - 0x1_0000_0000;
}

/** Human-readable cause for codes the model cannot interpret, else undefined. */
export function exitCause(code: number): string | undefined {
  if (isStartFailure(code)) return "process failed to start (Windows 0xC0000142, DLL initialisation failed)";
  return undefined;
}

export interface StartRetryOpts {
  retries?: number;
  delayMs?: number;
}

interface Attempt {
  handle: ProcessHandle;
  sawData: boolean;
}

type Run = ProcessPort["proc"]["run"];
type RunOpts = Parameters<Run>[1];

function spawn(run: Run, argv: string[], opts: RunOpts): Attempt {
  const a: Attempt = { handle: undefined as unknown as ProcessHandle, sawData: false };
  a.handle = run(argv, {
    ...opts,
    onData: (d) => {
      a.sawData = true;
      opts.onData(d);
    },
  });
  return a;
}

async function drive(a: Attempt, left: number, delayMs: number, ctx: { cancelled: boolean; respawn(): Attempt }): Promise<Attempt> {
  for (;;) {
    const r = await a.handle.done;
    if (!isStartFailure(r.code) || a.sawData || ctx.cancelled || left-- <= 0) return a;
    await new Promise((res) => setTimeout(res, delayMs));
    if (ctx.cancelled) return a;
    a = ctx.respawn();
  }
}

/** Wrap a proc.run: on a bare start failure with no output and no cancel, retry after `delayMs`. */
export function withStartRetry(run: Run, o?: StartRetryOpts): Run {
  const retries = o?.retries ?? 1;
  const delayMs = o?.delayMs ?? 250;
  return (argv, opts) => {
    const ctx = { cancelled: false, respawn: () => spawn(run, argv, opts) };
    let current = spawn(run, argv, opts);
    const tracked = ctx.respawn;
    ctx.respawn = () => (current = tracked());
    const done = drive(current, retries, delayMs, ctx).then((a) => a.handle.done);
    return {
      write: (d) => current.handle.write?.(d),
      cancel: () => {
        ctx.cancelled = true;
        current.handle.cancel();
      },
      killTree: async () => {
        ctx.cancelled = true;
        await current.handle.killTree();
      },
      done,
    };
  };
}
