import type { RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "@stewart/kernel";
import type { ChannelService, ManagedChannel } from "@stewart/channels";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { ConfigStore, SelfWriteGuard } from "@stewart/config";
import type { Interaction } from "@stewart/interaction";
import type { Permissions } from "@stewart/permissions";
import type { SessionService } from "@stewart/session";
import type { ModelCaps, ProbeLoop } from "@stewart/models";
import type { WorkspaceInfo, SetupProbeRunner } from "@stewart/setup";
import type { DebugLevel, DebugSink } from "@stewart/diagnostics";

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
  /** Built when settings.log.level is not `off`; rebuilt when level or retainDays change. Default: no-op. */
  debugSinkFactory?: (opts: { level: Exclude<DebugLevel, "off">; retainDays: number }) => DebugSink;
  /** Engine override (tests); defaults to @stewart/engines' engineFor. */
  engineFor?: (channelType: string) => import("@stewart/engines").Engine;
}

export interface ProjectCtx {
  host: HostPort;
  config: EffectiveConfig;
  trusted: boolean;
  interaction: Interaction;
  permissions: Permissions;
  sessions: SessionService;
  projectStore: ConfigStore;
  projectGuard: SelfWriteGuard;
  /** Raw layers as last loaded (skill resolution, role reset). */
  userLayer: Record<string, string | undefined>;
  projectLayer: Record<string, string | undefined>;
}

/** The Core members handlers/* use; keeps them off the concrete class. */
export interface CoreCtx {
  readonly deps: CoreDeps;
  clock: Clock;
  readonly channelService: ChannelService;
  readonly probeCache: Map<string, { caps: Partial<ModelCaps>; probedAt: number }>;
  readonly priceCache: Map<string, Record<string, { inPerMTok: number; outPerMTok: number }> | undefined>;
  readonly wsScan: Map<string, { info: WorkspaceInfo; at: number }>;
  /** Per-project setup quick-probe queues (smoke tests), created on first setup.probe.* call. */
  readonly probeRunners: Map<string, SetupProbeRunner>;
  /** Full qualification records collected during the wizard probe, keyed `channel:model`; persisted on setup.approve. */
  readonly qualRecords: Map<string, Map<string, { agent?: import("@stewart/config").Qual; function?: import("@stewart/config").Qual }>>;
  readonly probeLoop: ProbeLoop<ManagedChannel>;
  readonly userGuard: SelfWriteGuard;
  readonly secretValues: Map<string, string>;
  readonly defaults: Record<string, string | undefined>;
  ctx(projectId: string): ProjectCtx;
  reload(projectId: string, fromWatcher?: boolean): Promise<{ config: EffectiveConfig; suppressed: boolean }>;
}
