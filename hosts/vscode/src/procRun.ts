import { spawn, type ChildProcess } from "node:child_process";
import { withShellEnv, withStartRetry, type ProcessHandle, type ProcessPort } from "@stewart/core";

function rawRun(argv: string[], opts: { cwd: string; env?: Record<string, string>; onData(d: string): void }): ProcessHandle {
  const child: ChildProcess = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => opts.onData(String(d)));
  child.stderr?.on("data", (d) => opts.onData(String(d)));
  let settled = false;
  const done = new Promise<{ code: number; cause?: string }>((res) => {
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      res(code !== null ? { code } : signal ? { code: -1, cause: `killed by signal ${signal}` } : { code: -1 });
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      opts.onData(`cannot start ${argv[0]}: ${e.message}\n`);
      res({ code: -1, cause: `cannot start ${argv[0]}: ${e.message}` });
    });
  });
  return {
    cancel: () => child.kill("SIGTERM"),
    killTree: async () => {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
    done,
  };
}

/** Host proc.run: no inherited stdin; one retry on Windows start failure; spawn errors report a cause. */
export const procRun: ProcessPort["proc"]["run"] = withShellEnv(withStartRetry(rawRun));
