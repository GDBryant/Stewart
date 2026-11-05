import { helloSchema, negotiate, PROTOCOL_VERSION, KNOWN_CAPABILITIES, type RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "./ports.js";
import { systemClock, counterIds, nodeFetch } from "./ports.js";
import { EventBus } from "./events.js";
import { ChannelRegistry, ManagedChannel } from "./channels/registry.js";
import { OllamaAdapter } from "./channels/ollama.js";
import { OpenAICompatAdapter } from "./channels/openai.js";
import { ClaudeCliAdapter } from "./channels/claude/adapter.js";
import { loadConfig, type Config } from "./config/loader.js";
import { CONFIG_FILE_SCHEMAS, PROJECT_FILES } from "./config/files.js";
import type { ConfigStore } from "./config/store.js";
import { parse as parseYaml } from "yaml";
import { RunManager } from "./runManager.js";
import type { ChannelDeps } from "./channels/types.js";

export interface CoreDeps {
  fetcher?: Fetcher;
  clock?: Clock;
  ids?: IdGen;
  /** User-level config (~/.config/stewart); readable + writable. */
  userConfig: ConfigStore;
  /** Project .stewart/ config; read applied only when trusted. */
  projectConfig: (projectId: string) => Promise<ConfigStore> | ConfigStore;
  /** Shipped default config layer. */
  defaults: Record<string, string | undefined>;
  emitEvent(ev: RunEvent): void;
}

interface ProjectCtx {
  host: HostPort;
  config: Config;
  trusted: boolean;
  runs: RunManager;
  projectStore: ConfigStore;
}

export class Core {
  readonly channels = new ChannelRegistry();
  private projects = new Map<string, ProjectCtx>();
  private managed = new Map<string, ManagedChannel>();
  private chDeps: ChannelDeps;
  private clock: Clock;
  private ids: IdGen;
  private bus: EventBus;

  constructor(private deps: CoreDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? counterIds();
    this.chDeps = { fetcher: deps.fetcher ?? nodeFetch };
    this.bus = new EventBus(deps.emitEvent);
    this.channels.register("ollama", (d) => new OllamaAdapter(d as ChannelDeps));
    this.channels.register("openai-compatible", (d) => new OpenAICompatAdapter(d as ChannelDeps));
    this.channels.register("claude-cli", () => new ClaudeCliAdapter());
  }

  /** Host calls once per project. */
  async attachProject(projectId: string, host: HostPort): Promise<Config> {
    const trusted = await host.workspace.trusted();
    const projectStore = await this.deps.projectConfig(projectId);
    const config = loadConfig(await this.deps.userConfig.read(), await projectStore.read(), this.deps.defaults, trusted);
    const runs = new RunManager({ host, clock: this.clock, ids: this.ids, bus: this.bus });
    this.projects.set(projectId, { host, config, trusted, runs, projectStore });
    await this.rebuildChannels(config, host);
    return config;
  }

  private async rebuildChannels(config: Config, host: HostPort): Promise<void> {
    this.managed.clear();
    for (const c of config.channels) {
      if (!c.enabled) continue;
      try {
        const adapter = this.channels.create(c.type, this.chDeps);
        const maxParallel = c.maxParallel ?? (c.type === "ollama" ? 1 : 4);
        const mc = new ManagedChannel(adapter, { ...c, maxParallel });
        if (c.secretRef) {
          const secret = await host.secrets.get(c.secretRef);
          if (secret !== undefined) mc.setSecret(secret);
        }
        this.managed.set(c.id, mc);
      } catch (e) {
        host.log(`channel ${c.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private ctx(projectId: string): ProjectCtx {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`project not attached: ${projectId}`);
    return p;
  }

  private async reload(projectId: string): Promise<Config> {
    const ctx = this.ctx(projectId);
    ctx.config = loadConfig(await this.deps.userConfig.read(), await ctx.projectStore.read(), this.deps.defaults, ctx.trusted);
    await this.rebuildChannels(ctx.config, ctx.host);
    return ctx.config;
  }

  /** Single entry point for host→core JSON-RPC. */
  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "hello": {
        const hello = helloSchema.parse(params);
        const r = negotiate({ protocol: PROTOCOL_VERSION, capabilities: [...KNOWN_CAPABILITIES] }, hello);
        if (!r.ok) throw new Error(r.error);
        return { protocol: PROTOCOL_VERSION, capabilities: r.capabilities };
      }
      case "chat.send": {
        const p = params as { projectId: string; text: string; images?: string[] };
        const ctx = this.ctx(p.projectId);
        const agent = this.pickChatAgent(ctx.config);
        const channel = this.channelForAgent(agent);
        const run = await ctx.runs.direct(p.projectId, channel, agent, p.text, p.images);
        return { runId: run.id };
      }
      case "chat.cancel": {
        const p = params as { projectId: string; runId: string };
        return { ok: this.ctx(p.projectId).runs.cancel(p.runId) };
      }
      case "chat.resume":
        return { ok: true }; // M7: re-dispatch interrupted tasks
      case "chat.answer": {
        const p = params as { projectId: string; questionId: string; answer: string };
        return { ok: this.ctx(p.projectId).runs.answer(p.questionId, p.answer) };
      }
      case "chat.approve": {
        const p = params as { projectId: string; approvalId: string; grant: "once" | "chat" | "always" | "deny" };
        return { ok: this.ctx(p.projectId).runs.approve(p.approvalId, p.grant) };
      }
      case "config.get": {
        const p = params as { projectId: string };
        const ctx = this.ctx(p.projectId);
        const userFiles = await this.deps.userConfig.read();
        const projectFiles = ctx.trusted ? await ctx.projectStore.read() : {};
        const files = { ...this.deps.defaults, ...userFiles, ...projectFiles };
        const { errors, ...summary } = ctx.config;
        return { files, summary, errors };
      }
      case "config.set": {
        const p = params as { projectId: string; file: string; yaml: string; layer?: "user" | "project" };
        const ctx = this.ctx(p.projectId);
        const schema = CONFIG_FILE_SCHEMAS[p.file];
        if (!schema) throw new Error(`unknown config file: ${p.file}`);
        let doc: unknown;
        try {
          doc = parseYaml(p.yaml);
        } catch (e) {
          throw new Error(`invalid YAML: ${e instanceof Error ? e.message : e}`);
        }
        const parsed = schema.safeParse(doc ?? {});
        if (!parsed.success) throw new Error(`invalid ${p.file}: ${parsed.error.issues[0]?.message ?? "schema error"}`);
        const layer = p.layer ?? "user";
        if (layer === "project") {
          if (!ctx.trusted) throw new Error("project config requires a trusted workspace");
          if (!PROJECT_FILES.has(p.file)) throw new Error(`${p.file} is not allowed at project level`);
          await ctx.projectStore.write(p.file, p.yaml);
        } else {
          await this.deps.userConfig.write(p.file, p.yaml);
        }
        await this.reload(p.projectId);
        return { ok: true };
      }
      case "channel.test": {
        const p = params as { projectId: string; channelId: string };
        const ch = this.managed.get(p.channelId);
        if (!ch) return { ok: false, error: "channel not configured or disabled" };
        try {
          const models = await ch.listModels();
          return { ok: true, models };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      case "secret.set": {
        const p = params as { projectId: string; ref: string; value: string };
        const ctx = this.ctx(p.projectId);
        await ctx.host.secrets.set(p.ref, p.value);
        for (const c of ctx.config.channels) {
          if (c.secretRef === p.ref) this.managed.get(c.id)?.setSecret(p.value);
        }
        return { ok: true };
      }
      case "secret.delete": {
        const p = params as { projectId: string; ref: string };
        const ctx = this.ctx(p.projectId);
        await ctx.host.secrets.delete(p.ref);
        for (const c of ctx.config.channels) {
          if (c.secretRef === p.ref) this.managed.get(c.id)?.setSecret(undefined);
        }
        return { ok: true };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private pickChatAgent(config: Config): Config["agents"][number] {
    const gw = config.roles.find((r) => r.id === "general-worker");
    const agentId = gw?.agent ?? config.agents[0]?.id;
    const agent = config.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error("no agent configured — run setup to add a channel and agent");
    return agent;
  }

  private channelForAgent(agent: { channel: string }): ManagedChannel {
    const ch = this.managed.get(agent.channel);
    if (!ch) throw new Error(`channel ${agent.channel} not configured`);
    return ch;
  }
}
