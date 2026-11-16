import { describe, expect, it } from "vitest";
import { resolveShellEnv, withShellEnv } from "../src/shellEnv.js";
import type { ProcessHandle, ProcessPort } from "../src/ports.js";

type Run = ProcessPort["proc"]["run"];

function fakeRun(result: { code: number; emit?: string } | "never" | "throw"): { run: Run; calls: { argv: string[]; env?: Record<string, string> }[]; killed: number } {
  const state = { calls: [] as { argv: string[]; env?: Record<string, string> }[], killed: 0 };
  const run: Run = (argv, o) => {
    state.calls.push({ argv, env: o.env });
    if (result === "throw") throw new Error("spawn failed");
    const h: ProcessHandle = {
      cancel: () => {},
      killTree: async () => {
        state.killed++;
      },
      done: (async () => {
        if (result === "never") return new Promise<{ code: number }>(() => {});
        if (result.emit !== undefined) o.onData(result.emit);
        return { code: result.code };
      })(),
    };
    return h;
  };
  return { run, get calls() { return state.calls; }, get killed() { return state.killed; } };
}

const ENV_OUT = "noise before\n__STEWART_ENV__PATH=/usr/bin\0HOME=/home/u\0A=a=b=c\0MULTI=line1\nline2\0BAD-KEY=x\0noeq\0PWD=/\0SHLVL=2\0_=x\0OLDPWD=/\0";

describe("resolveShellEnv", () => {
  it("parses env -0 output after the last marker, dropping shell keys", async () => {
    const f = fakeRun({ code: 0, emit: ENV_OUT });
    const env = await resolveShellEnv(f.run, { shell: "/bin/sh" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", A: "a=b=c", MULTI: "line1\nline2" });
    expect(f.calls[0].argv).toEqual(["/bin/sh", "-ilc", "printf '%s' __STEWART_ENV__; env -0"]);
  });

  it("returns {} when the marker is absent", async () => {
    const f = fakeRun({ code: 0, emit: "no marker here\0PATH=/x\0" });
    expect(await resolveShellEnv(f.run, { shell: "/bin/sh" })).toEqual({});
  });

  it("caches one spawn per run function", async () => {
    const f = fakeRun({ code: 0, emit: "__STEWART_ENV__PATH=/x\0" });
    await resolveShellEnv(f.run, { shell: "/bin/sh" });
    await resolveShellEnv(f.run);
    expect(f.calls.length).toBe(1);
  });

  it("kills the tree and returns {} on timeout", async () => {
    const f = fakeRun("never");
    expect(await resolveShellEnv(f.run, { shell: "/bin/sh", timeoutMs: 10 })).toEqual({});
    expect(f.killed).toBe(1);
  });

  it("returns {} on a non-zero exit", async () => {
    const f = fakeRun({ code: 127, emit: "__STEWART_ENV__PATH=/x\0" });
    expect(await resolveShellEnv(f.run, { shell: "/bin/sh" })).toEqual({});
  });

  it("returns {} when run throws", async () => {
    const f = fakeRun("throw");
    expect(await resolveShellEnv(f.run, { shell: "/bin/sh" })).toEqual({});
  });

  it("does not spawn on win32", async () => {
    const f = fakeRun({ code: 0, emit: ENV_OUT });
    expect(await resolveShellEnv(f.run, { platform: "win32" })).toEqual({});
    expect(f.calls.length).toBe(0);
  });
});

describe("withShellEnv", () => {
  const argv = ["node", "-v"];

  function shellRun(envOut: string) {
    const inner = fakeRun({ code: 0, emit: "v22\n" });
    const probe = fakeRun({ code: 0, emit: envOut });
    let first = true;
    const run: Run = (a, o) => {
      const picked = first ? probe : inner;
      first = false;
      return picked.run(a, o);
    };
    return { run, inner, probe };
  }

  it("merges the shell env under the caller env and passes argv/cwd through", async () => {
    const { run, inner, probe } = shellRun("__STEWART_ENV__PATH=/shell\0EXTRA=1\0");
    const wrapped = withShellEnv(run, { shell: "/bin/sh" });
    let seen = "";
    const h = wrapped(argv, { cwd: "/p", env: { PATH: "/caller" }, onData: (d) => (seen += d) });
    expect(await h.done).toEqual({ code: 0 });
    expect(probe.calls.length).toBe(1);
    expect(inner.calls[0]).toEqual({ argv, env: { PATH: "/caller", EXTRA: "1" } });
    expect(seen).toBe("v22\n");
  });

  it("passes opts through unchanged when the shell env is empty and no env given", async () => {
    const { run, inner } = shellRun("no marker");
    const h = withShellEnv(run, { shell: "/bin/sh" })(argv, { cwd: "/p", onData: () => {} });
    expect(await h.done).toEqual({ code: 0 });
    expect(inner.calls[0].env).toBeUndefined();
  });

  it("spawns nothing on win32 and still runs the command", async () => {
    const inner = fakeRun({ code: 0 });
    const h = withShellEnv(inner.run, { platform: "win32" })(argv, { cwd: "/p", onData: () => {} });
    expect(await h.done).toEqual({ code: 0 });
    expect(inner.calls.length).toBe(1);
    expect(inner.calls[0].argv).toEqual(argv);
  });

  it("cancel before start: inner never spawns, done resolves -1 with a cause", async () => {
    const { run, inner } = shellRun("__STEWART_ENV__A=1\0");
    const h = withShellEnv(run, { shell: "/bin/sh" })(argv, { cwd: "/p", onData: () => {} });
    h.cancel();
    expect(await h.done).toEqual({ code: -1, cause: "cancelled before start" });
    expect(inner.calls.length).toBe(0);
  });

  it("killTree before start: inner never spawns, done resolves -1 with a cause", async () => {
    const { run, inner } = shellRun("__STEWART_ENV__A=1\0");
    const h = withShellEnv(run, { shell: "/bin/sh" })(argv, { cwd: "/p", onData: () => {} });
    await h.killTree();
    expect(await h.done).toEqual({ code: -1, cause: "cancelled before start" });
    expect(inner.calls.length).toBe(0);
  });

  it("forwards cancel, killTree and write after the inner starts", async () => {
    let wrote = "";
    let cancelled = false;
    let killed = false;
    const probe = fakeRun({ code: 0, emit: "__STEWART_ENV__A=1\0" });
    const run: Run = (a, o) => {
      if (a[0] === "/bin/sh") return probe.run(a, o);
      return {
        write: (d) => (wrote += d),
        cancel: () => {
          cancelled = true;
        },
        killTree: async () => {
          killed = true;
        },
        done: Promise.resolve({ code: 0 }),
      };
    };
    const h = withShellEnv(run, { shell: "/bin/sh" })(argv, { cwd: "/p", onData: () => {} });
    expect(await h.done).toEqual({ code: 0 });
    h.write?.("in");
    h.cancel();
    await h.killTree();
    expect(wrote).toBe("in");
    expect(cancelled).toBe(true);
    expect(killed).toBe(true);
  });
});
