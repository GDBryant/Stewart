import type { RunEvent } from "@stewart/protocol";
import type { Clock, Fetcher, HostPort, IdGen } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import type { Config } from "@stewart/roles-skills";
import type { ConfigStore, SelfWriteGuard } from "@stewart/config";
import type { RunService } from "@stewart/runs";
import type { ModelCaps, ProbeLoop } from "@stewart/models";
import type { WorkspaceInfo } from "@stewart/setup";
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
}

export interface ProjectCtx {
  host: HostPort;
  config: Config;
  trusted: boolean;
  runs: RunService;
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
  readonly managed: Map<string, ManagedChannel>;
  readonly probeCache: Map<string, { caps: Partial<ModelCaps>; probedAt: number }>;
  readonly priceCache: Map<string, Record<string, { inPerMTok: number; outPerMTok: number }> | undefined>;
  readonly wsScan: Map<string, { info: WorkspaceInfo; at: number }>;
  readonly probeLoop: ProbeLoop<ManagedChannel>;
  readonly userGuard: SelfWriteGuard;
  readonly secretValues: Map<string, string>;
  readonly defaults: Record<string, string | undefined>;
  ctx(projectId: string): ProjectCtx;
  reload(projectId: string, fromWatcher?: boolean): Promise<{ config: Config; suppressed: boolean }>;
}
