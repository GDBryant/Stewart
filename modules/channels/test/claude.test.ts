import { describe, expect, it } from "vitest";
import { ClaudeCliAdapter, type ClaudeDeps } from "../src/claude/adapter.js";
import { classify } from "../src/claude/nodeSpawn.js";
import { ChannelError } from "../src/types.js";
import type { SpawnedProc, SpawnFn } from "../src/claude/nodeSpawn.js";
import { collect } from "@stewart/kernel";

function fakeSpawn(lines: string[], opts: { code?: number; stderr?: string; spawnError?: string } = {}): { spawn: SpawnFn; captured: { argv: string[]; cwd: string; env: Record<string, string>; stdin?: string }[] } {
  const captured: { argv: string[]; cwd: string; env: Record<string, string>; stdin?: string }[] = [];
  const spawn: SpawnFn = (a, o) => {
    captured.push({ argv: a, cwd: o.cwd, env: o.env, stdin: o.stdin });
    const stdin: string[] = [];
    let doneRes: (r: { code: number; spawnError?: string }) => void = () => {};
    const done = new Promise<{ code: number; spawnError?: string }>((res) => (doneRes = res));
    const proc: SpawnedProc = {
      stdin: (d) => stdin.push(d),
      write: (d) => stdin.push(d),
      end: () => {},
      stdout: (async function* () {
        try {
          for (const l of lines) yield l;
        } finally {
          doneRes({ code: opts.code ?? 0, spawnError: opts.spawnError });
        }
      })(),
      stderrText: async () => opts.stderr ?? "",
      done,
      kill: async () => doneRes({ code: -1 }),
    };
    return proc;
  };
  return { spawn, captured };
}

function deps(spawn: SpawnFn, extra: Partial<ClaudeDeps> = {}): ClaudeDeps {
  return {
    spawn,
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "tok", ...((extra.env as Record<string, string>) ?? {}) },
    makeTempDir: async () => "/tmp/stewart-claude-fake",
    rmDir: async () => {},
    ...extra,
  };
}

const cfg = { id: "claude", type: "claude-cli", enabled: true, maxParallel: 1 };

describe("ClaudeCliAdapter", () => {
  it("chat() refuses: claude-cli runs via the claude-code engine", async () => {
    const adapter = new ClaudeCliAdapter(deps(fakeSpawn([])));
    await expect(collect(adapter.chat())).rejects.toMatchObject({ name: "ChannelError", code: "use_engine" });
  });

  it("listModels probes auth and returns normalised models", async () => {
    const { spawn, captured } = fakeSpawn(['{"loggedIn":true,"authMethod":"sso","subscriptionType":"enterprise"}']);
    const adapter = new ClaudeCliAdapter(deps(spawn));
    expect(await adapter.listModels(cfg)).toEqual(["sonnet", "opus", "haiku"]);
    expect(captured[0].argv.slice(0, 3)).toEqual(["claude", "auth", "status"]);
    expect(captured[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(await adapter.probeCaps()).toMatchObject({ tools: "native", vision: true, reasoning: true });
  });

  it("listModels throws auth when logged out", async () => {
    const { spawn } = fakeSpawn(['{"loggedIn":false}']);
    const adapter = new ClaudeCliAdapter(deps(spawn));
    await expect(adapter.listModels(cfg)).rejects.toMatchObject({ code: "auth" });
  });

  it("loginStatus reports non-JSON, nonzero exit, spawn failure and timeout", async () => {
    const bad = fakeSpawn(["oops not json"]);
    expect((await new ClaudeCliAdapter(deps(bad.spawn)).loginStatus(cfg)).detail).toBe("non-JSON auth status");
    const exit = fakeSpawn(['{"loggedIn":true}'], { code: 3 });
    expect((await new ClaudeCliAdapter(deps(exit.spawn)).loginStatus(cfg)).detail).toBe("auth status exit 3");
    const fail: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    expect((await new ClaudeCliAdapter(deps(fail)).loginStatus(cfg)).detail).toContain("cannot start CLI");
    const spawnErr = fakeSpawn([], { spawnError: "spawn claude ENOENT", code: -1 });
    expect((await new ClaudeCliAdapter(deps(spawnErr.spawn)).loginStatus(cfg)).detail).toBe("cannot start CLI: spawn claude ENOENT");
    const hanging = fakeSpawn([]);
    hanging.spawn = (() => {
      const proc: SpawnedProc = {
        stdin: () => {},
        write: () => {},
        end: () => {},
        stdout: (async function* () {
          await new Promise(() => {});
          yield "";
        })(),
        stderrText: async () => "",
        done: new Promise(() => {}),
        kill: async () => {},
      };
      return proc;
    }) as SpawnFn;
    expect((await new ClaudeCliAdapter(deps(hanging.spawn, { authTimeoutMs: 20 })).loginStatus(cfg)).detail).toBe("auth status timed out");
  });

  it("loginStatus spawns with devnull stdin and retries a start failure once", async () => {
    const seq = fakeSpawn(['{"loggedIn":true}']);
    const inner = seq.spawn;
    let calls = 0;
    const flaky: SpawnFn = (a, o) => {
      calls++;
      if (calls === 1) return fakeSpawn([], { code: 3221225794 }).spawn(a, o);
      return inner(a, o);
    };
    const adapter = new ClaudeCliAdapter(deps(flaky));
    const state = await adapter.loginStatus(cfg);
    expect(state.loggedIn).toBe(true);
    expect(calls).toBe(2);
    expect(seq.captured[0].stdin).toBe("devnull");
  });

  it("loginStatus reports a start failure cause after the retry also fails", async () => {
    const f = fakeSpawn([], { code: -1073741502 });
    const adapter = new ClaudeCliAdapter(deps(f.spawn));
    const state = await adapter.loginStatus(cfg);
    expect(state.loggedIn).toBe(false);
    expect(state.detail).toBe("auth status: process failed to start (Windows 0xC0000142, DLL initialisation failed)");
    expect(f.captured.length).toBe(2);
  });

  it("claudeChildEnv strips direct API keys and applies extraEnv", async () => {
    const { spawn, captured } = fakeSpawn(['{"loggedIn":true}']);
    const c = { ...cfg, extraEnv: { CLAUDE_FLAG: "1" } };
    await new ClaudeCliAdapter(deps(spawn)).loginStatus(c);
    expect(captured[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(captured[0].env.CLAUDE_FLAG).toBe("1");
    expect(captured[0].env.MCP_TOOL_TIMEOUT).toBe(String(6 * 60 * 60 * 1000));
    const own = await import("../src/api.js").then((m) => m.claudeChildEnv({ ...cfg, extraEnv: { MCP_TOOL_TIMEOUT: "5" } }, { MCP_TOOL_TIMEOUT: "9" }));
    expect(own.MCP_TOOL_TIMEOUT).toBe("5");
  });
});

describe("probeCaps --help effort probe", () => {
  it("reports effortSupport true when help mentions --effort, with a clean env", async () => {
    const { spawn, captured } = fakeSpawn(["Options:\n  --model <model>\n  --effort <level>  low, medium, high, max"]);
    const adapter = new ClaudeCliAdapter(deps(spawn));
    expect(await adapter.probeCaps()).toMatchObject({ tools: "native", vision: true, reasoning: true, effortSupport: true });
    expect(captured[0].argv.slice(0, 2)).toEqual(["claude", "--help"]);
    expect(captured[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("reports effortSupport false when help lacks the flag", async () => {
    const { spawn } = fakeSpawn(["Options:\n  --model <model>"]);
    const adapter = new ClaudeCliAdapter(deps(spawn));
    expect(await adapter.probeCaps()).toMatchObject({ effortSupport: false });
  });

  it("spawns `claude --help` once per CLI across probes, retrying only unknown results", async () => {
    const { spawn, captured } = fakeSpawn(["--effort <level>"]);
    const adapter = new ClaudeCliAdapter(deps(spawn));
    await adapter.probeCaps();
    await adapter.probeCaps();
    expect(await adapter.effortSupport()).toBe(true);
    expect(captured).toHaveLength(1);
    const noent = fakeSpawn([], { spawnError: "spawn claude ENOENT", code: -1 });
    const bad = new ClaudeCliAdapter(deps(noent.spawn));
    expect(await bad.effortSupport()).toBeUndefined();
    await bad.effortSupport();
    expect(noent.captured).toHaveLength(2);
  });

  it("omits effortSupport when the CLI cannot be started or the probe hangs", async () => {
    const noent = fakeSpawn([], { spawnError: "spawn claude ENOENT", code: -1 });
    expect(await new ClaudeCliAdapter(deps(noent.spawn)).probeCaps()).not.toHaveProperty("effortSupport");
    const hanging = fakeSpawn([]);
    hanging.spawn = (() => {
      const proc: SpawnedProc = {
        stdin: () => {},
        write: () => {},
        end: () => {},
        stdout: (async function* () {
          await new Promise(() => {});
          yield "";
        })(),
        stderrText: async () => "",
        done: new Promise(() => {}),
        kill: async () => {},
      };
      return proc;
    }) as SpawnFn;
    expect(await new ClaudeCliAdapter(deps(hanging.spawn, { effortProbeMs: 20 })).probeCaps()).not.toHaveProperty("effortSupport");
  });
});

describe("classify", () => {
  it("maps auth, model, rate-limit and generic stderr", () => {
    expect(classify("not logged in")).toBe("auth");
    expect(classify("401 unauthorized")).toBe("auth");
    expect(classify("issue with the selected model")).toBe("model_unavailable");
    expect(classify("rate limit hit")).toBe("rate_limited");
    expect(classify("boom")).toBe("cli_error");
  });
});
