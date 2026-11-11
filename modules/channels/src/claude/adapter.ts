import type { ToolCall } from "@stewart/kernel";
import type { ModelCaps } from "@stewart/models";
import type { ChannelAdapter, ChannelConfig, ChatEvent, ChatRequest } from "../types.js";
import { ChannelError } from "../types.js";
import type { DebugSink } from "@stewart/diagnostics";
import { ClaudeStreamParser, classify, type ClaudeEvent, type ClaudeRawCall } from "./parser.js";
import { normalizeModel } from "@stewart/catalog";
import { argv as claudeArgv, prepare } from "./transcript.js";
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

/** Map parser call events to ToolCalls; native calls without ids get call_N from parser order. */
function toToolCalls(calls: ClaudeRawCall[], parser: ClaudeStreamParser): ToolCall[] {
  return calls.map((c) => {
    let args: Record<string, unknown> = {};
    try {
      const p = JSON.parse(c.argumentsJson) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { id: c.id ?? `call_${parser.nativeCalls.indexOf(c)}`, name: c.name, arguments: args };
  });
}

function dispatchParserEvent(ev: ClaudeEvent, parser: ClaudeStreamParser): { events: ChatEvent[]; failure?: { message: string; code: string } } {
  if (ev.t === "text") return { events: [{ kind: "text", text: ev.text }] };
  if (ev.t === "reasoning") return { events: [{ kind: "reasoning", text: ev.text }] };
  if (ev.t === "calls") return { events: [{ kind: "tool_calls", calls: toToolCalls(ev.calls, parser) }] };
  if (ev.t === "failed") return { events: [], failure: { message: ev.message, code: ev.code } };
  return { events: [] };
}

type ClaudeRec = (direction: "outgoing" | "incoming" | "stderr" | "error", payload: string) => void;

/** Inputs for launching one CLI turn: config, request, prepared input, temp cwd and the debug recorder. */
interface ProcStart {
  cfg: ChannelConfig;
  req: ChatRequest;
  input: ReturnType<typeof prepare>;
  cwd: string;
  rec: ClaudeRec;
}

/** Consume CLI stdout lines into ChatEvents; returns the parser's failure event if one was emitted. */
async function* consumeStdout(
  proc: SpawnedProc,
  parser: ClaudeStreamParser,
  req: ChatRequest,
  rec: (direction: "incoming", payload: string) => void,
): AsyncGenerator<ChatEvent, { message: string; code: string } | undefined, unknown> {
  let failure: { message: string; code: string } | undefined;
  for await (const line of proc.stdout) {
    rec("incoming", line);
    if (req.signal.aborted) {
      await proc.kill();
      throw abortError();
    }
    for (const ev of parser.feed(line)) {
      const d = dispatchParserEvent(ev, parser);
      if (d.failure) failure = d.failure;
      yield* d.events;
    }
    if (parser.failedEmitted || parser.toolTurnEnded) {
      await proc.kill();
      break;
    }
  }
  return failure;
}

interface FinishArgs {
  parser: ClaudeStreamParser;
  proc: SpawnedProc;
  exitCode: number;
  dbg: DebugSink | undefined;
  rec: (direction: "stderr" | "error", payload: string) => void;
}

/** Debug-only: record stderr tail and a non-zero exit code. */
async function recordExit({ proc, exitCode, dbg, rec }: FinishArgs): Promise<void> {
  if (!dbg) return;
  const err = await proc.stderrText();
  if (err) rec("stderr", err.slice(-2000));
  if (exitCode !== 0) rec("error", `exit code ${exitCode}`);
}

/** Error for a stream with no result event: clean exit means truncated stream, otherwise classify stderr. */
async function incompleteError(proc: SpawnedProc, exitCode: number): Promise<ChannelError> {
  if (exitCode === 0) return new ChannelError("stream ended before completion", 0, undefined, "incomplete_stream");
  const tail = (await proc.stderrText()).slice(-2000);
  const cls = classify(tail);
  return new ChannelError(`Claude CLI exited with code ${exitCode}: ${tail}`, 0, undefined, cls === "auth" ? "auth" : "cli_exit");
}

/** Post-stream outcome: debug stderr/exit, then a done event or the right ChannelError. */
async function finishChat(args: FinishArgs): Promise<ChatEvent | undefined> {
  const { parser, proc, exitCode } = args;
  await recordExit(args);
  if (parser.toolTurnEnded || (parser.cutPending && !parser.resultSeen)) {
    const u = parser.turnUsage();
    return { kind: "done", usage: usageOf(u), costUsd: u?.costUsd };
  }
  if (!parser.resultSeen) throw await incompleteError(proc, exitCode);
  if (exitCode !== 0) throw new ChannelError(`Claude CLI exited with code ${exitCode}`, 0, undefined, "cli_exit");
  const u = parser.turnUsage();
  return { kind: "done", usage: usageOf(u), costUsd: u?.costUsd, truncated: parser.finishReason === "length" };
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

  private async startClaudeProc(s: ProcStart): Promise<{ proc: SpawnedProc; promptDir: string }> {
    const { cfg, input, cwd, rec } = s;
    const wf = this.deps.writeTempFile ?? ((c: string) => writeTempFile("stewart-claude-prompt-", c));
    const promptFile = await wf(input.system);
    const promptDir = promptFile.slice(0, promptFile.lastIndexOf("/"));
    const argv = claudeArgv(this.cliPath(cfg), normalizeModel(s.req.model), promptFile, input.hasImages);
    let proc: SpawnedProc;
    try {
      proc = this.spawn(argv, { cwd, env: this.childEnv(cfg) });
    } catch (e) {
      rec("error", `cannot start: ${e instanceof Error ? e.message : e}`);
      throw new ChannelError(`cannot start Claude CLI at ${this.cliPath(cfg)}: ${e instanceof Error ? e.message : e}`, 0, undefined, "cli_not_found");
    }
    const stdin = input.hasImages ? input.streamJsonLine() + "\n" : input.text;
    rec("outgoing", stdin);
    proc.stdin(stdin);
    return { proc, promptDir };
  }

  async *chat(cfg: ChannelConfig, _secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent> {
    if (req.tools?.length) {
      throw new ChannelError("Claude does not support native tools", 0, undefined, "native_tools_unsupported");
    }
    const input = prepare(req.messages);
    const dbg = this.deps.debug;
    const rec: ClaudeRec = (direction, payload) => dbg?.record({ direction, provider: this.type, model: req.model, payload });
    const mk = this.deps.makeTempDir ?? makeTempDir;
    const rm = this.deps.rmDir ?? rmDir;
    const cwd = await mk();
    let proc: SpawnedProc | undefined;
    let promptDir: string | undefined;
    try {
      const started = await this.startClaudeProc({ cfg, req, input, cwd, rec });
      proc = started.proc;
      promptDir = started.promptDir;
      const parser = new ClaudeStreamParser();
      const failure = yield* consumeStdout(proc, parser, req, rec);
      if (failure) throw new ChannelError(failure.message, 0, undefined, failure.code);
      const { code: exitCode } = await proc.done;
      const fin = await finishChat({ parser, proc, exitCode, dbg, rec });
      if (fin) yield fin;
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
