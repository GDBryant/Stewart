import type { AgentDef } from "@stewart/config";
import type { HostPort } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Permissions } from "@stewart/permissions";
import type { RunLedger } from "@stewart/ledger";
import type { ProjectPaths } from "@stewart/tools";
import type { Engine } from "@stewart/engines";
import type { EffectiveConfig } from "@stewart/roles-skills";

export interface ChildDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  ids: { next(prefix: string): string };
  permissions: Permissions;
  channelFor: (id: string) => ManagedChannel;
  config: () => EffectiveConfig;
  engineFor?: (channelType: string) => Engine;
  paths: ProjectPaths;
  stateDir: string;
  runId: string;
  sessionId: string;
  agent: AgentDef;
  ledger: RunLedger;
  /** Shared counters with the parent turn: accrued cost, stream seq, cancel signal. */
  parent: { controller: AbortController; seq: number; accrued: number; costCapped: boolean };
  costCapUsd: number;
  /** The lead's plan: children's writes count toward the current milestone and its checkpoints. */
  plan?: { beforeWrite(path: string, content: string | null): Promise<void>; recordWrite(w: { path: string; ok: boolean; message?: string }): void };
}
