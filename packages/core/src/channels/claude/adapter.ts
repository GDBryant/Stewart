import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest, ModelCaps, ToolCall } from "../types.js";
import { ChannelError } from "../types.js";
import type { DebugSink } from "../../debug/debug.js";
import { ClaudeStreamParser, classify } from "./parser.js";
import { argv as claudeArgv, normalizeModel, prepare } from "./transcript.js";
import { nodeSpawn, makeTempDir, rmDir, writeTempFile, type SpawnFn, type SpawnedProc } from "./nodeSpawn.js";

export interface ClaudeDeps {
  spawn?: SpawnFn;
  env?: Record<string, string | undefined>;
  makeTempDir?: () => Promise<string>;
  writeTempFile?: (content: string) => Promise<string>;
  rmDir?: (dir: string) => Promise<void>;
  authTimeoutMs?: number;
  /** Records stdin, stdout lines, stderr and exit failures at calls level. */
  debug?: DebugSink;
}

export interface ClaudeLoginState {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  detail?: string;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/**
 * Claude Code CLI channel (v1 ClaudeProvider port): stream-json subprocess,
 * isolation flags, no tools/MCP, env with API keys stripped, fresh temp cwd.
 */
export class ClaudeCliAdapter implements ChannelAdapter {
  readonly type = "claude-cli";
  private readonly spawn: SpawnFn;
  private readonly authTimeoutMs: number;

  constructor(private deps: ClaudeDeps = {}) {
    this.spawn = deps.spawn ?? nodeSpawn;
    this.authTimeoutMs = deps.authTimeoutMs ?? 20_000;
  }

  private cliPath(cfg: ChannelConfig): string {
    return (cfg.cliPath as string | undefined) ?? "claude";
  }

  private childEnv(cfg: ChannelConfig): Record<string, string> {
    const src = this.deps.env ?? (process.env as Record<string, string | undefined>);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) if (v !== undefined) env[k] = v;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const extra = cfg.extraEnv as Record<string, string> | undefined;
    if (extra) Object.assign(env, extra);
    return env;
  }

  async loginStatus(cfg: ChannelConfig): Promise<ClaudeLoginState> {
    const mk = this.deps.makeTempDir ?? makeTempDir;
    const rm = this.deps.rmDir ?? rmDir;
    const cwd = await mk();
    try {
      let proc: SpawnedProc;
      try {
        proc = this.spawn([this.cliPath(cfg), "auth", "status"], { cwd, env: this.childEnv(cfg) });
      } catch (e) {
        return { loggedIn: false, detail: `cannot start CLI: ${e instanceof Error ? e.message : e}` };
      }
      const out: string[] = [];
      const reading = (async () => {
        for await (const l of proc.stdout) out.push(l);
      })();
      const timedOut = await Promise.race([proc.done.then(() => false), reading.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), this.authTimeoutMs))]);
      if (timedOut) {
        await proc.kill();
        return { loggedIn: false, detail: "auth status timed out" };
      }
      const { code } = await proc.done;
      await reading.catch(() => {});
      if (code !== 0) return { loggedIn: false, detail: `auth status exit ${code}` };
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(out.join("\n")) as Record<string, unknown>;
      } catch {
        return { loggedIn: false, detail: "non-JSON auth status" };
      }
      return {
        loggedIn: o.loggedIn === true,
        authMethod: typeof o.authMethod === "string" ? o.authMethod : undefined,
        subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : undefined,
      };
    } finally {
      await rm(cwd);
    }
  }

  async listModels(cfg: ChannelConfig): Promise<string[]> {
    const state = await this.loginStatus(cfg);
    if (!state.loggedIn) {
      throw new ChannelError(state.detail ? `Claude CLI: ${state.detail}` : "Claude CLI: not logged in", 0, undefined, "auth");
    }
    const models = (cfg.extraModels?.length ? cfg.extraModels : ["sonnet", "opus", "haiku"]).map(normalizeModel);
    return [...new Set(models)];
  }

  async probeCaps(): Promise<Partial<ModelCaps>> {
    return { tools: "shim", vision: true, reasoning: true, contextTokens: 200_000 };
  }

  async *chat(cfg: ChannelConfig, _secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent> {
    if (req.tools?.length) {
      throw new ChannelError("Claude does not support native tools", 0, undefined, "native_tools_unsupported");
    }
    const input = prepare(req.messages);
    const dbg = this.deps.debug;
    const rec = (direction: "outgoing" | "incoming" | "stderr" | "error", payload: string) =>
      dbg?.record({ direction, provider: this.type, model: req.model, payload });
    const mk = this.deps.makeTempDir ?? makeTempDir;
    const rm = this.deps.rmDir ?? rmDir;
    const cwd = await mk();
    let proc: SpawnedProc | undefined;
    let promptDir: string | undefined;
    try {
      const wf = this.deps.writeTempFile ?? ((c: string) => writeTempFile("stewart-claude-prompt-", c));
      const promptFile = await wf(input.system);
      promptDir = promptFile.slice(0, promptFile.lastIndexOf("/"));
      const argv = claudeArgv(this.cliPath(cfg), normalizeModel(req.model), promptFile, input.hasImages);
      try {
        proc = this.spawn(argv, { cwd, env: this.childEnv(cfg) });
      } catch (e) {
        rec("error", `cannot start: ${e instanceof Error ? e.message : e}`);
        throw new ChannelError(`cannot start Claude CLI at ${this.cliPath(cfg)}: ${e instanceof Error ? e.message : e}`, 0, undefined, "cli_not_found");
      }
      const stdin = input.hasImages ? input.streamJsonLine() + "\n" : input.text;
      rec("outgoing", stdin);
      proc.stdin(stdin);

      const parser = new ClaudeStreamParser();
      let failure: { message: string; code: string } | undefined;
      for await (const line of proc.stdout) {
        rec("incoming", line);
        if (req.signal.aborted) {
          await proc.kill();
          throw abortError();
        }
        for (const ev of parser.feed(line)) {
          if (ev.t === "text") yield { kind: "text", text: ev.text };
          else if (ev.t === "reasoning") yield { kind: "reasoning", text: ev.text };
          else if (ev.t === "calls") {
            const calls: ToolCall[] = ev.calls.map((c) => {
              let args: Record<string, unknown> = {};
              try {
                const p = JSON.parse(c.argumentsJson) as unknown;
                if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
              } catch {
                args = {};
              }
              return { id: c.id ?? `call_${parser.nativeCalls.indexOf(c)}`, name: c.name, arguments: args };
            });
            yield { kind: "tool_calls", calls };
          } else if (ev.t === "failed") {
            failure = { message: ev.message, code: ev.code };
          }
        }
        if (parser.failedEmitted || parser.toolTurnEnded) {
          await proc.kill();
          break;
        }
      }
      if (failure) throw new ChannelError(failure.message, 0, undefined, failure.code);
      const { code: exitCode } = await proc.done;
      if (dbg) {
        const err = await proc.stderrText();
        if (err) rec("stderr", err.slice(-2000));
        if (exitCode !== 0) rec("error", `exit code ${exitCode}`);
      }
      if (parser.toolTurnEnded || (parser.cutPending && !parser.resultSeen)) {
        const u = parser.turnUsage();
        yield { kind: "done", usage: usageOf(u), costUsd: u?.costUsd };
        return;
      }
      if (!parser.resultSeen) {
        if (exitCode === 0) throw new ChannelError("stream ended before completion", 0, undefined, "incomplete_stream");
        const tail = (await proc.stderrText()).slice(-2000);
        const cls = classify(tail);
        throw new ChannelError(`Claude CLI exited with code ${exitCode}: ${tail}`, 0, undefined, cls === "auth" ? "auth" : "cli_exit");
      }
      if (exitCode !== 0) throw new ChannelError(`Claude CLI exited with code ${exitCode}`, 0, undefined, "cli_exit");
      const u = parser.turnUsage();
      yield { kind: "done", usage: usageOf(u), costUsd: u?.costUsd, truncated: parser.finishReason === "length" };
    } finally {
      if (proc) await proc.kill().catch(() => {});
      if (promptDir) await rm(promptDir);
      await rm(cwd);
    }
  }
}

function usageOf(u: { in?: number; out?: number; costUsd?: number } | undefined): { in: number; out: number } | undefined {
  if (!u || (u.in === undefined && u.out === undefined)) return undefined;
  return { in: u.in ?? 0, out: u.out ?? 0 };
}
