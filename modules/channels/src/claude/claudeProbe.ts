import { classify, type SpawnFn } from "./nodeSpawn.js";

export interface ProbeDeps {
  spawn: SpawnFn;
  env: Record<string, string | undefined>;
  makeTempDir: () => Promise<string>;
  rmDir: (dir: string) => Promise<void>;
  /** Timeout for the `--help` probe (default 10 s). */
  helpTimeoutMs?: number;
}

/** True when the CLI's help text mentions `--effort`. */
export function hasEffortFlag(text: string): boolean {
  return /--effort\b/.test(text);
}

/**
 * Probe `claude --help` for the `--effort` flag (dev-only: the result is stored in modelCaps,
 * and the normal run path reads caps and never spawns the CLI). A logged-out or model-free CLI
 * is a known "no" (false); spawn errors, start failures and timeouts are unknown (undefined).
 */
/** A `--help` failure that proves the CLI is installed but has no access (logged out / no model / limited): a known "no". */
function isKnownNo(c: string): boolean {
  return c === "auth" || c === "model_unavailable" || c === "rate_limited";
}

export async function probeHelpEffort(deps: ProbeDeps, cli: string): Promise<boolean | undefined> {
  const cwd = await deps.makeTempDir();
  try {
    return await probe(cwd);
  } finally {
    await deps.rmDir(cwd);
  }

  async function probe(dir: string): Promise<boolean | undefined> {
    let proc;
    try {
      proc = deps.spawn([cli, "--help"], { cwd: dir, env: deps.env as Record<string, string>, stdin: "devnull" });
    } catch (e) {
      return isKnownNo(classify(e instanceof Error ? e.message : String(e))) ? false : undefined;
    }
    const out: string[] = [];
    const reading = (async () => {
      for await (const l of proc.stdout) out.push(l);
    })();
    const timedOut = await Promise.race([proc.done.then(() => false), reading.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), deps.helpTimeoutMs ?? 10_000))]);
    if (timedOut) {
      await proc.kill();
      return undefined;
    }
    const res = await proc.done;
    await reading.catch(() => {});
    const text = out.join("\n");
    if (res.spawnError || res.code !== 0) {
      return isKnownNo(classify(res.spawnError ?? text ?? `help exit ${res.code}`)) ? false : undefined;
    }
    return hasEffortFlag(text);
  }
}
