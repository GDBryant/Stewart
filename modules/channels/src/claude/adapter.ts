import type { ModelCaps } from "@stewart/models";
import type { ChannelAdapter, ChannelConfig, ChatEvent } from "../types.js";
import { ChannelError } from "../types.js";
import type { DebugSink } from "@stewart/diagnostics";
import { normalizeModel } from "@stewart/catalog";
import { nodeSpawn, makeTempDir, rmDir, type SpawnFn, type SpawnedProc } from "./nodeSpawn.js";

export interface ClaudeDeps {
  spawn?: SpawnFn;
  env?: Record<string, string | undefined>;
  makeTempDir?: () => Promise<string>;
  writeTempFile?: (content: string) => Promise<string>;
  rmDir?: (dir: string) => Promise<void>;
  authTimeoutMs?: number;
  debug?: DebugSink;
}

export interface ClaudeLoginState {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  detail?: string;
}

export function claudeChildEnv(cfg: ChannelConfig, src: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const extra = cfg.extraEnv as Record<string, string> | undefined;
  if (extra) Object.assign(env, extra);
  return env;
}

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
    return claudeChildEnv(cfg, this.deps.env ?? (process.env as Record<string, string | undefined>));
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

  async *chat(): AsyncIterable<ChatEvent> {
    throw new ChannelError("claude-cli chats run via the claude-code engine, not the channel text pipe", 0, undefined, "use_engine");
  }
}
