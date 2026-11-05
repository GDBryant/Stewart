import { helloSchema, negotiate, PROTOCOL_VERSION, KNOWN_CAPABILITIES, type RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "./ports.js";
import { systemClock, counterIds, nodeFetch } from "./ports.js";
import { EventBus } from "./events.js";
import { ChannelRegistry, ManagedChannel } from "./channels/registry.js";
import { OllamaAdapter } from "./channels/ollama.js";
import { OpenAICompatAdapter } from "./channels/openai.js";
import { ClaudeCliAdapter } from "./channels/claude/adapter.js";
import { loadConfig, type Config } from "./config/loader.js";
import { CONFIG_FILE_SCHEMAS, isProjectFile } from "./config/files.js";
import { DEFAULT_ROLES_YAML } from "./defaults/roles.js";
import { baseHashFor, composeRolePrompt, serializeSkillMd, shippedDefaultRoles, shippedSkill } from "./skills/skills.js";
import { stringify as stringifyYaml } from "yaml";
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
  /** Raw layers as last loaded (skill resolution, role reset). */
  userLayer: Record<string, string | undefined>;
  projectLayer: Record<string, string | undefined>;
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

  private get defaults(): Record<string, string | undefined> {
    return { "roles.yaml": DEFAULT_ROLES_YAML, ...this.deps.defaults };
  }

  /** Host calls once per project. */
  async attachProject(projectId: string, host: HostPort): Promise<Config> {
    const trusted = await host.workspace.trusted();
    const projectStore = await this.deps.projectConfig(projectId);
    const userLayer = await this.deps.userConfig.read();
    const projectLayer = await projectStore.read();
    const config = loadConfig(userLayer, projectLayer, this.defaults, trusted);
    const runs = new RunManager({ host, clock: this.clock, ids: this.ids, bus: this.bus });
    this.projects.set(projectId, { host, config, trusted, runs, projectStore, userLayer, projectLayer });
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
    ctx.userLayer = await this.deps.userConfig.read();
    ctx.projectLayer = await ctx.projectStore.read();
    ctx.config = loadConfig(ctx.userLayer, ctx.projectLayer, this.defaults, ctx.trusted);
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
        const p = params as { projectId: string; text: string; images?: string[]; direct?: boolean };
        const ctx = this.ctx(p.projectId);
        const stripped = p.text.startsWith("/direct ") ? p.text.slice(8) : p.text;
        const orchestrator = ctx.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
        if (orchestrator && !p.direct && !p.text.startsWith("/direct ")) {
          const run = await ctx.runs.orchestrated(p.projectId, {
            config: ctx.config,
            channelFor: (id) => this.channelById(id),
            text: stripped,
          });
          return { runId: run.id };
        }
        const role = ctx.config.roles.find((r) => r.id === "general-worker" && r.enabled);
        const agent = this.pickChatAgent(ctx.config, role);
        const channel = this.channelForAgent(agent);
        const { prompt, truncated } = role
          ? composeRolePrompt(role, ctx.config.skills, ctx.config.settings.skillBudgetTokens)
          : { prompt: undefined, truncated: false };
        if (truncated) ctx.host.log(`role ${role?.id}: skill text truncated at skillBudgetTokens`);
        const run = await ctx.runs.direct(p.projectId, channel, agent, stripped, p.images, role, prompt || undefined);
        return { runId: run.id };
      }
      case "chat.cancel": {
        const p = params as { projectId: string; runId: string };
        return { ok: this.ctx(p.projectId).runs.cancel(p.runId) };
      }
      case "chat.resume": {
        const p = params as { projectId: string; runId: string };
        const ctx = this.ctx(p.projectId);
        const res = await ctx.runs.resume(p.projectId, p.runId, {
          config: ctx.config,
          channelFor: (id) => this.channelById(id),
        });
        return res.ok ? { ok: true, resumed: true, runId: res.run!.id } : { ok: false, resumed: false, reason: res.reason };
      }
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
      case "config.reload": {
        const p = params as { projectId: string };
        await this.reload(p.projectId);
        return { ok: true };
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
          if (!isProjectFile(p.file)) throw new Error(`${p.file} is not allowed at project level`);
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
      case "skills.save": {
        const p = params as { projectId: string; id: string; body: string; description?: string; layer?: "user" | "project" };
        const ctx = this.ctx(p.projectId);
        const shipped = shippedSkill(p.id);
        const meta = {
          id: p.id,
          description: p.description ?? shipped?.description ?? "",
          defaultRoles: shippedDefaultRoles(p.id),
          version: shipped?.version ?? 1,
          baseHash: p.layer === "project" ? undefined : baseHashFor(p.id),
        };
        const text = serializeSkillMd(meta, p.body);
        if (p.layer === "project") {
          if (!ctx.trusted) throw new Error("project skills require a trusted workspace");
          await ctx.projectStore.write(`skills/${p.id}.md`, text);
        } else {
          await this.deps.userConfig.write(`skills/${p.id}.md`, text);
        }
        await this.reload(p.projectId);
        return { ok: true };
      }
      case "skills.reset": {
        const p = params as { projectId: string; id: string };
        const file = `skills/${p.id}.md`;
        if (this.deps.userConfig.delete) await this.deps.userConfig.delete(file);
        await this.ctx(p.projectId).projectStore.delete?.(file);
        await this.reload(p.projectId);
        return { ok: true };
      }
      case "roles.reset": {
        const p = params as { projectId: string; roleId?: string };
        const ctx = this.ctx(p.projectId);
        const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: { id?: string }[] } | null;
        const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
        const next = p.roleId ? items.filter((i) => i.id !== p.roleId) : [];
        await this.deps.userConfig.write("roles.yaml", stringifyYaml({ version: 1, items: next }));
        await this.reload(p.projectId);
        return { ok: true };
      }
      case "roles.assignAgent": {
        const p = params as { projectId: string; agentId: string };
        const ctx = this.ctx(p.projectId);
        if (!ctx.config.agents.some((a) => a.id === p.agentId)) throw new Error(`unknown agent: ${p.agentId}`);
        const doc = parseYaml(ctx.userLayer["roles.yaml"] ?? "") as { items?: Record<string, unknown>[] } | null;
        const items = (doc?.items ?? []).filter((i) => i && typeof i === "object");
        const byId = new Map(items.map((i) => [String(i.id), i]));
        for (const r of ctx.config.roles) {
          const item = byId.get(r.id) ?? { id: r.id };
          item.agent = p.agentId;
          byId.set(r.id, item);
        }
        await this.deps.userConfig.write("roles.yaml", stringifyYaml({ version: 1, items: [...byId.values()] }));
        await this.reload(p.projectId);
        return { ok: true };
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

  private pickChatAgent(config: Config, role?: Config["roles"][number]): Config["agents"][number] {
    if (role) {
      if (!role.agent) throw new Error(`role ${role.id}: enabled but no agent bound`);
      const bound = config.agents.find((a) => a.id === role.agent);
      if (!bound) throw new Error(`role ${role.id}: unknown agent '${role.agent}'`);
      return bound;
    }
    const agent = config.agents[0];
    if (!agent) throw new Error("no agent configured — run setup to add a channel and agent");
    return agent;
  }

  private channelForAgent(agent: { channel: string }): ManagedChannel {
    return this.channelById(agent.channel);
  }

  private channelById(channelId: string): ManagedChannel {
    const ch = this.managed.get(channelId);
    if (!ch) throw new Error(`channel ${channelId} not configured`);
    return ch;
  }
}
