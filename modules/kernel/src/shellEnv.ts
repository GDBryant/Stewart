import type { ProcessHandle, ProcessPort } from "./ports.js";

type Run = ProcessPort["proc"]["run"];

export interface ShellEnvOpts {
  platform?: string;
  shell?: string;
  timeoutMs?: number;
  cwd?: string;
}

const MARKER = "__STEWART_ENV__";
const DROPPED = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const cache = new WeakMap<Run, Promise<Record<string, string>>>();

function parseEnv(out: string): Record<string, string> | null {
  const at = out.lastIndexOf(MARKER);
  if (at < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of out.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (KEY.test(key) && !DROPPED.has(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

function collect(run: Run, shell: string, cwd: string, timeoutMs: number): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let out = "";
    let handle: ProcessHandle;
    try {
      handle = run([shell, "-ilc", `printf '%s' ${MARKER}; env -0`], { cwd, onData: (d) => (out += d) });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      void handle.killTree().finally(() => resolve(null));
    }, timeoutMs);
    void handle.done.then((r) => {
      clearTimeout(timer);
      resolve(r.code === 0 ? parseEnv(out) : null);
    });
  });
}

/** Resolve the login-shell environment once per `run` (`$SHELL -ilc … env -0`); `{}` on Windows, timeout, or failure (failures are not cached, so the next call retries). */
export function resolveShellEnv(run: Run, o?: ShellEnvOpts): Promise<Record<string, string>> {
  const hit = cache.get(run);
  if (hit) return hit;
  const platform = o?.platform ?? process.platform;
  const p =
    platform === "win32"
      ? Promise.resolve({})
      : collect(run, o?.shell ?? process.env.SHELL ?? "/bin/sh", o?.cwd ?? "/", o?.timeoutMs ?? 5000).then((env) => {
          if (env !== null) return env;
          cache.delete(run);
          return {};
        });
  cache.set(run, p);
  return p;
}

/** Wrap `proc.run` so every spawn sees the login-shell env; the caller's `opts.env` wins. */
export function withShellEnv(run: Run, o?: ShellEnvOpts): Run {
  return (argv, opts) => {
    let inner: ProcessHandle | undefined;
    let cancelled = false;
    const started = resolveShellEnv(run, o).then((shellEnv) => {
      if (cancelled) return undefined;
      const env = { ...shellEnv, ...opts.env };
      inner = run(argv, Object.keys(env).length === 0 && opts.env === undefined ? opts : { ...opts, env });
      return inner;
    });
    const done = started.then((h) => (h ? h.done : { code: -1, cause: "cancelled before start" }));
    return {
      cancel: () => {
        if (inner) inner.cancel();
        else cancelled = true;
      },
      killTree: async () => {
        if (inner) await inner.killTree();
        else cancelled = true;
      },
      done,
    };
  };
}
