import type { RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "@stewart/kernel";
import { systemClock, counterIds, nodeFetch } from "@stewart/kernel";
import { EventBus, type EventSubscriber } from "@stewart/kernel";
import { ChannelRegistry, ChannelService, type ManagedChannel } from "@stewart/channels";
import { OllamaAdapter } from "@stewart/channels";
import { OpenAICompatAdapter } from "@stewart/channels";
import { ClaudeCliAdapter } from "@stewart/channels";
import { loadEffectiveConfig, type EffectiveConfig } from "@stewart/roles-skills";
import { FEATURE_ROLE_TOOLS, RUN_FEATURES } from "./features.js";
import { DEFAULT_ROLES_YAML } from "@stewart/roles-skills";
import { SelfWriteGuard, type ConfigStore } from "@stewart/config";
import { RunService } from "@stewart/runs";
import type { ModelCaps, ProbeLoop } from "@stewart/models";
import type { ChannelDeps } from "@stewart/channels";
import type { WorkspaceInfo, SetupProbeRunner } from "@stewart/setup";
import { DebugLogger, NOOP_DEBUG_SINK, eventEntry, type DebugLevel, type DebugSink } from "@stewart/diagnostics";
import * as chat from "./handlers/chat.js";
import * as cfg from "./handlers/config.js";
import * as setup from "./handlers/setup.js";
import * as setupProbe from "./handlers/setupProbe.js";
import { createProbeLoop } from "@stewart/agent-loop";
import { applyProbes } from "./handlers/util.js";
import type { CoreCtx, CoreDeps, ProjectCtx } from "./handlers/types.js";

export type { CoreDeps, ProjectCtx } from "./handlers/types.js";

/** Composition root + JSON-RPC router. Domain logic lives in `handlers/*`, which wire Core's deps to module services. */
export class Core implements CoreCtx {
  readonly channels = new ChannelRegistry();
  private projects = new Map<string, ProjectCtx>();
  readonly channelService: ChannelService;
  probeCache = new Map<string, { caps: Partial<ModelCaps>; probedAt: number }>();
  /** Live price lists fetched once per channel (undefined = unsupported or failed). */
  priceCache = new Map<string, Record<string, { inPerMTok: number; outPerMTok: number }> | undefined>();
  /** Workspace scan cache, 24h TTL — shared by setup.recommend and the task classifier. */
  wsScan = new Map<string, { info: WorkspaceInfo; at: number }>();
  readonly probeRunners = new Map<string, SetupProbeRunner>();
  readonly probeLoop: ProbeLoop<ManagedChannel>;
  userGuard = new SelfWriteGuard();
  private chDeps: ChannelDeps;
  clock: Clock;
  private ids: IdGen;
  private bus: EventBus;
  /** Stable logger handed to adapters; reconfigured by applyDebug. */
  private debug = new DebugLogger(() => [...this.secretValues.values()]);
  private debugKey = "";
  /** Channel secrets by ref, for redaction only. */
  secretValues = new Map<string, string>();

  constructor(readonly deps: CoreDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? counterIds();
    this.chDeps = { fetcher: deps.fetcher ?? nodeFetch, debug: this.debug };
    this.channelService = new ChannelService({ registry: this.channels, adapterDeps: this.chDeps });
    this.probeLoop = createProbeLoop({ clock: this.clock });
    this.bus = new EventBus(deps.emitEvent);
    this.bus.subscribe((ev) => {
      if (this.debug.level !== "full") return;
      const entry = eventEntry(ev);
      if (entry) this.debug.record(entry);
    });
    this.channels.register("ollama", (d) => new OllamaAdapter(d as ChannelDeps));
    this.channels.register("openai-compatible", (d) => new OpenAICompatAdapter(d as ChannelDeps));
    this.channels.register("claude-cli", (d) => new ClaudeCliAdapter({ debug: (d as ChannelDeps).debug }));
  }

  /** Reconfigures the debug log from settings.log; the sink is rebuilt only when level or retention changes. */
  private applyDebug(config: EffectiveConfig): void {
    const { level, retainDays } = config.settings.log;
    const key = `${level}:${retainDays}`;
    if (key === this.debugKey) return;
    this.debugKey = key;
    if (level === "off" || !this.deps.debugSinkFactory) {
      this.debug.configure("off", NOOP_DEBUG_SINK);
      return;
    }
    try {
      this.debug.configure(level, this.deps.debugSinkFactory({ level, retainDays }));
    } catch {
      this.debug.configure("off", NOOP_DEBUG_SINK);
    }
  }

  subscribe(fn: EventSubscriber): () => void {
    return this.bus.subscribe(fn);
  }

  get defaults(): Record<string, string | undefined> {
    return { "roles.yaml": DEFAULT_ROLES_YAML, ...this.deps.defaults };
  }

  /** Host calls once per project. */
  async attachProject(projectId: string, host: HostPort): Promise<EffectiveConfig> {
    const trusted = await host.workspace.trusted();
    const projectStore = await this.deps.projectConfig(projectId);
    const userLayer = await this.deps.userConfig.read();
    const projectLayer = await projectStore.read();
    this.userGuard.syncLayer(userLayer);
    const projectGuard = new SelfWriteGuard();
    projectGuard.syncLayer(projectLayer);
    const config = applyProbes(this, loadEffectiveConfig(userLayer, projectLayer, this.defaults, trusted, FEATURE_ROLE_TOOLS));
    this.applyDebug(config);
    const runs = new RunService({ host, clock: this.clock, ids: this.ids, bus: this.bus, features: RUN_FEATURES });
    runs.historyRetentionDays = config.settings.historyRetentionDays;
    this.projects.set(projectId, { host, config, trusted, runs, projectStore, projectGuard, userLayer, projectLayer });
    const staleProbe = this.probeRunners.get(projectId);
    if (staleProbe) {
      staleProbe.cancel();
      this.probeRunners.delete(projectId);
    }
    await this.rebuildChannels(config, host);
    return config;
  }

  private async rebuildChannels(config: EffectiveConfig, host: HostPort): Promise<void> {
    const secrets = await this.channelService.rebuild(config.channels, host);
    for (const [k, v] of secrets) this.secretValues.set(k, v);
  }

  ctx(projectId: string): ProjectCtx {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`project not attached: ${projectId}`);
    return p;
  }

  async reload(projectId: string, fromWatcher = false): Promise<{ config: EffectiveConfig; suppressed: boolean }> {
    const ctx = this.ctx(projectId);
    const nextUser = await this.deps.userConfig.read();
    const nextProj = await ctx.projectStore.read();
    if (fromWatcher && this.userGuard.layerUnchanged(nextUser) && ctx.projectGuard.layerUnchanged(nextProj)) {
      return { config: ctx.config, suppressed: true };
    }
    ctx.userLayer = nextUser;
    ctx.projectLayer = nextProj;
    this.userGuard.syncLayer(nextUser);
    ctx.projectGuard.syncLayer(nextProj);
    const nextConfig = applyProbes(this, loadEffectiveConfig(ctx.userLayer, ctx.projectLayer, this.defaults, ctx.trusted, FEATURE_ROLE_TOOLS));
    const fatalParse = nextConfig.errors.some((e) => /^(channels|agents|roles|settings)\.yaml:/.test(e));
    if (fatalParse && fromWatcher) {
      ctx.config = { ...ctx.config, errors: nextConfig.errors };
      return { config: ctx.config, suppressed: false };
    }
    ctx.config = nextConfig;
    this.applyDebug(nextConfig);
    ctx.runs.historyRetentionDays = nextConfig.settings.historyRetentionDays;
    await this.rebuildChannels(ctx.config, ctx.host);
    return { config: ctx.config, suppressed: false };
  }

  private readonly handlers: Record<string, (p: unknown) => unknown | Promise<unknown>> = {
    hello: (p) => setup.handleHello(p),
    "chat.send": (p) => chat.handleChatSend(this, p),
    "chat.cancel": (p) => chat.handleChatCancel(this, p),
    "chat.resume": (p) => chat.handleChatResume(this, p),
    "chat.revert": (p) => chat.handleChatRevert(this, p),
    "chat.answer": (p) => chat.handleChatAnswer(this, p),
    "chat.approve": (p) => chat.handleChatApprove(this, p),
    "history.list": (p) => chat.handleHistoryList(this, p),
    "history.load": (p) => chat.handleHistoryLoad(this, p),
    "history.delete": (p) => chat.handleHistoryDelete(this, p),
    "config.get": (p) => cfg.handleConfigGet(this, p),
    "config.reload": (p) => cfg.handleConfigReload(this, p),
    "config.set": (p) => cfg.handleConfigSet(this, p),
    "config.importV1": (p) => cfg.handleConfigImportV1(this, p),
    "channel.test": (p) => setup.handleChannelTest(this, p),
    "channel.probe": (p) => setup.handleChannelProbe(this, p),
    "setup.recommend": (p) => setup.handleSetupRecommend(this, p),
    "setup.probe.start": (p) => setupProbe.handleSetupProbeStart(this, p),
    "setup.probe.status": (p) => setupProbe.handleSetupProbeStatus(this, p),
    "setup.probe.cancel": (p) => setupProbe.handleSetupProbeCancel(this, p),
    "setup.probe.retry": (p) => setupProbe.handleSetupProbeRetry(this, p),
    "setup.session.start": (p) => setup.handleSetupSessionStart(this, p),
    "setup.session.get": (p) => setup.handleSetupSessionGet(this, p),
    "setup.session.update": (p) => setup.handleSetupSessionUpdate(this, p),
    "setup.session.advance": (p) => setup.handleSetupSessionAdvance(this, p),
    "setup.session.back": (p) => setup.handleSetupSessionBack(this, p),
    "setup.session.cancel": (p) => setup.handleSetupSessionCancel(this, p),
    "setup.session.addChannel": (p) => setup.handleSetupSessionAddChannel(this, p),
    "setup.session.removeChannel": (p) => setup.handleSetupSessionRemoveChannel(this, p),
    "setup.review": (p) => setup.handleSetupReview(this, p),
    "setup.approve": (p) => setup.handleSetupApprove(this, p),
    "setup.undo": (p) => setup.handleSetupUndo(this, p),
    "skills.save": (p) => cfg.handleSkillsSave(this, p),
    "skills.reset": (p) => cfg.handleSkillsReset(this, p),
    "roles.reset": (p) => cfg.handleRolesReset(this, p),
    "roles.assignAgent": (p) => cfg.handleRolesAssignAgent(this, p),
    "secret.set": (p) => cfg.handleSecretSet(this, p),
    "secret.delete": (p) => cfg.handleSecretDelete(this, p),
  };

  /** Single entry point for host→core JSON-RPC. */
  async dispatch(method: string, params: unknown): Promise<unknown> {
    const h = this.handlers[method];
    if (!h) throw new Error(`unknown method: ${method}`);
    return h(params);
  }
}
