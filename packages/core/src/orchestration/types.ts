import type { Clock, HostPort, IdGen } from "@stewart/kernel";
import type { EventBus } from "../events.js";
import type { Config } from "@stewart/roles-skills";
import type { ManagedChannel } from "@stewart/channels";
import type { ToolPreview } from "@stewart/permissions";
import type { ToolCall } from "@stewart/kernel";
import type { ApprovalDecision } from "@stewart/agent-loop";
import type { RunLedger, CostLimit } from "@stewart/ledger";
import { LeaseManager, TaskGraph } from "@stewart/scheduling";
import type { IdempotencyLog } from "@stewart/run-state";
import type { BudgetProfile } from "@stewart/budget";
import type { RecoveryState } from "./recovery.js";

/** Everything a task runner needs from the owning run. */
export interface OrchestrationRuntime {
  runId: string;
  projectId: string;
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: EventBus;
  config: Config;
  stateDir: string;
  channelFor(channelId: string): ManagedChannel;
  ledger: RunLedger;
  leases: LeaseManager;
  idem: IdempotencyLog;
  cost: CostLimit;
  signal: AbortSignal;
  startedAt: number;
  /** Run-level time cap: one abort timer owned by the run. `hit` is set when it fired; `ms` 0 = no cap. */
  timeCap?: { ms: number; hit: boolean; cancel(): void };
  leaseWaitMs: number;
  skillBudgetTokens: number;
  maxNestedDispatches: number;
  maxReplans: number;
  maxRunHours: number;
  /** settings.maxWorkerTurnsCeiling; absent = 60. */
  maxWorkerTurnsCeiling?: number;
  /** Resolved budget profile for this run (quick/normal/deep multipliers + cap); absent = normal. */
  budgetProfile?: BudgetProfile;
  planGate: boolean;
  roleAgentOverrides?: Map<string, string>;
  /** Per-run recovery limits and counters; created from settings by the run owner. */
  recovery?: RecoveryState;
  onGraphChange?(graph: TaskGraph): Promise<void> | void;
  ask(question: string, options?: string[]): Promise<string>;
  /** ask with a timeout; resolves undefined when the question is withdrawn. */
  askTimed?(question: string, options: string[] | undefined, timeoutMs: number): Promise<string | undefined>;
  approve(call: ToolCall, preview: ToolPreview | null, meta: { roleId: string; taskId: string }): Promise<ApprovalDecision>;
}

/** Alias: the per-run runtime handed to task runners. */
export type RunRuntime = OrchestrationRuntime;
