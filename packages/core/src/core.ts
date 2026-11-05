import { helloSchema, negotiate, PROTOCOL_VERSION, KNOWN_CAPABILITIES, type RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "./ports.js";
import { systemClock, counterIds, nodeFetch } from "./ports.js";
import { EventBus } from "./events.js";
import { ChannelRegistry, ManagedChannel } from "./channels/registry.js";
import { OllamaAdapter } from "./channels/ollama.js";
import { OpenAICompatAdapter } from "./channels/openai.js";
import { loadConfig, type Config, type ConfigLayer } from "./config/loader.js";
import { RunManager } from "./runManager.js";
import type { ChannelDeps } from "./channels/types.js";

export interface CoreDeps {
  fetcher?: Fetcher;
  clock?: Clock;
  ids?: IdGen;
  /** App-level config reads/writes (user dir); per-host. */
  userConfig: () => Promise<ConfigLayer>;
  /** Project .stewart/ config; empty when absent. */
  projectConfig: (projectId: string) => Promise<ConfigLayer>;
  /** Shipped default config layer. */
  defaults: ConfigLayer;
  emitEvent(ev: RunEvent): void;
}

interface ProjectCtx {
  host: HostPort;
  config: Config;
  trusted: boolean;
  runs: RunManager;
}

export class Core {
  readonly channels = new ChannelRegistry();
  private projects = new Map<string, ProjectCtx>();
  private managed = new Map<string, ManagedChannel>();
  private chDeps: ChannelDeps;
  private clock: Clock;
  private ids: IdGen;
  private bus: EventBus;
  private negotiatedCaps: string[] = [];

  constructor(private deps: CoreDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? counterIds();
    this.chDeps = { fetcher: deps.fetcher ?? nodeFetch };
    this.bus = new EventBus(deps.emitEvent);
    this.channels.register("ollama", (d) => new OllamaAdapter(d as ChannelDeps));
    this.channels.register("openai-compatible", (d) => new OpenAICompatAdapter(d as ChannelDeps));
  }

  /** Host calls once per project. */
  async attachProject(projectId: string, host: HostPort): Promise<Config> {
    const trusted = await host.workspace.trusted();
    const config = loadConfig(await this.deps.userConfig(), await this.deps.projectConfig(projectId), this.deps.defaults, trusted);
    const runs = new RunManager({ host, clock: this.clock, ids: this.ids, bus: this.bus });
    this.projects.set(projectId, { host, config, trusted, runs });
    this.rebuildChannels(config, host);
    return config;
  }

  private rebuildChannels(config: Config, host: HostPort): void {
    for (const c of config.channels) {
      if (!c.enabled) continue;
      try {
        const adapter = this.channels.create(c.type, this.chDeps);
        const maxParallel = c.maxParallel ?? (c.type === "ollama" ? 1 : 4);
        this.managed.set(c.id, new ManagedChannel(adapter, { ...c, maxParallel }));
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

  /** Single entry point for host→core JSON-RPC. */
  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "hello": {
        const hello = helloSchema.parse(params);
        const r = negotiate({ protocol: PROTOCOL_VERSION, capabilities: [...KNOWN_CAPABILITIES] }, hello);
        if (!r.ok) throw new Error(r.error);
        this.negotiatedCaps = r.capabilities;
        return { protocol: PROTOCOL_VERSION, capabilities: r.capabilities };
      }
      case "chat.send": {
        const p = params as { projectId: string; text: string; images?: string[] };
        const ctx = this.ctx(p.projectId);
        const agent = this.pickChatAgent(ctx.config);
        const channel = this.channelForAgent(ctx.config, agent);
        const run = await ctx.runs.direct(p.projectId, channel, agent, p.text, p.images);
        return { runId: run.id };
      }
      case "chat.cancel": {
        const p = params as { projectId: string; runId: string };
        return { ok: this.ctx(p.projectId).runs.cancel(p.runId) };
      }
      case "chat.resume":
        return { ok: true }; // M7: re-dispatch interrupted tasks
      case "chat.answer":
      case "chat.approve":
        return { ok: true }; // M4: wired to approval queue
      case "config.get": {
        const p = params as { projectId: string };
        return { yaml: JSON.stringify(this.ctx(p.projectId).config) };
      }
      case "config.set":
        return { ok: true }; // M3: validated write via host.files.writeAtomic
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
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private pickChatAgent(config: Config): { id: string; channel: string; model: string; effort: "low" | "medium" | "high" | "max"; billing?: "free" | "reported" | "priced" | "unmetered"; temperature?: number } {
    const gw = config.roles.find((r) => r.id === "general-worker");
    const agentId = gw?.agent ?? config.agents[0]?.id;
    const agent = config.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error("no agent configured — run setup to add a channel and agent");
    return agent;
  }

  private channelForAgent(config: Config, agent: { channel: string }): ManagedChannel {
    const ch = this.managed.get(agent.channel);
    if (!ch) throw new Error(`channel ${agent.channel} not configured`);
    return ch;
  }
}
