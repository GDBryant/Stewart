import type { OrchestrationRuntime } from "@stewart/agent-loop";
import type { ChatMessage, Clock, EventBus, HostPort, IdGen } from "@stewart/kernel";
import type { RunHandle } from "./handle.js";
import type { TaskRecord } from "@stewart/scheduling";
import type { Permissions } from "@stewart/permissions";
import type { RunLedger } from "@stewart/ledger";
import type { createRecovery } from "@stewart/recovery";
export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted" | "stopped" | "no_dispatch";

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  controller: AbortController;
  startedAt: number;
  messages: ChatMessage[];
  costUsd: number;
  tasks?: TaskRecord[];
  /** Direct-run agent id, journaled so `/resume` can rebind it. */
  agentId?: string;
  sessionId?: string;
  externalRefs?: { tracker?: string; branch?: string; pr?: string };
  /** Per-run event stream (§4 `RunHandle`); attached by the pipeline at registration. */
  handle?: RunHandle;
}

export interface RunDeps {
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: EventBus;
}

/** The RunService members the run strategies and runtime builder use; keeps them off the concrete class. */
export interface RunHost {
  readonly deps: RunDeps;
  readonly recoveryService: ReturnType<typeof createRecovery>;
  get(id: string): Run | undefined;
  register(run: Run): void;
  journal(run: Run, stateDir: string): Promise<void>;
  journalPath(runId: string, stateDir: string): string;
  saveHistory(run: Run): Promise<void>;
  ledgerFor(): Promise<RunLedger>;
  readonly permissions: Permissions;
  prompt(runId: string, signal: AbortSignal, defaultRoleId?: string): OrchestrationRuntime["prompt"];
}
