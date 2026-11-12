import { describe, expect, it } from "vitest";
import { ClaudeCliAdapter, type ClaudeDeps } from "../src/claude/adapter.js";
import { classify } from "../src/claude/nodeSpawn.js";
import { ChannelError } from "../src/types.js";
import type { SpawnedProc, SpawnFn } from "../src/claude/nodeSpawn.js";
import { collect } from "@stewart/kernel";

function fakeSpawn(lines: string[], opts: { code?: number; stderr?: string } = {}): { spawn: SpawnFn; captured: { argv: string[]; cwd: string; env: Record<string, string> }[] } {
  const captured: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const spawn: SpawnFn = (a, o) => {
    captured.push({ argv: a, cwd: o.cwd, env: o.env });
    const stdin: string[] = [];
    let doneRes: (r: { code: number }) => void = () => {};
    const done = new Promise<{ code: number }>((res) => (doneRes = res));
    const proc: SpawnedProc = {
      stdin: (d) => stdin.push(d),
      write: (d) => stdin.push(d),
      end: () => {},
      stdout: (async function* () {
        try {
          for (const l of lines) yield l;
        } finally {
          doneRes({ code: opts.code ?? 0 });
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
    expect(await adapter.probeCaps()).toMatchObject({ tools: "shim", vision: true, reasoning: true });
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

  it("claudeChildEnv strips direct API keys and applies extraEnv", async () => {
    const { spawn, captured } = fakeSpawn(['{"loggedIn":true}']);
    const c = { ...cfg, extraEnv: { CLAUDE_FLAG: "1" } };
    await new ClaudeCliAdapter(deps(spawn)).loginStatus(c);
    expect(captured[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(captured[0].env.CLAUDE_FLAG).toBe("1");
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
