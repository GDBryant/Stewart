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

function parseEnv(out: string): Record<string, string> {
  const at = out.lastIndexOf(MARKER);
  if (at < 0) return {};
  const env: Record<string, string> = {};
  for (const entry of out.slice(at + MARKER.length).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (KEY.test(key) && !DROPPED.has(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

function collect(run: Run, shell: string, cwd: string, timeoutMs: number): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let out = "";
    let handle: ProcessHandle;
    try {
      handle = run([shell, "-ilc", `printf '%s' ${MARKER}; env -0`], { cwd, onData: (d) => (out += d) });
    } catch {
      resolve({});
      return;
    }
    const timer = setTimeout(() => {
      void handle.killTree().finally(() => resolve({}));
    }, timeoutMs);
    void handle.done.then((r) => {
      clearTimeout(timer);
      resolve(r.code === 0 ? parseEnv(out) : {});
    });
  });
}

/** Resolve the login-shell environment once per `run` (`$SHELL -ilc … env -0`); `{}` on Windows, timeout, or failure. */
export function resolveShellEnv(run: Run, o?: ShellEnvOpts): Promise<Record<string, string>> {
  const hit = cache.get(run);
  if (hit) return hit;
  const platform = o?.platform ?? process.platform;
  const p =
    platform === "win32"
      ? Promise.resolve({})
      : collect(run, o?.shell ?? process.env.SHELL ?? "/bin/sh", o?.cwd ?? "/", o?.timeoutMs ?? 5000);
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
    const done = started.then((h) => (h ? h.done : { code: -1 }));
    return {
      write: (d) => inner?.write?.(d),
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
