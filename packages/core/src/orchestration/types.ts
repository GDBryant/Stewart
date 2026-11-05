import type { Clock, HostPort, IdGen } from "../ports.js";
import type { EventBus } from "../events.js";
import type { Config } from "../config/loader.js";
import type { ManagedChannel } from "../channels/registry.js";
import type { ToolPreview } from "../tools/types.js";
import type { ToolCall } from "../channels/types.js";
import type { ApprovalDecision } from "../tools/toolLoop.js";
import type { RunLedger, CostLimit } from "./ledger.js";
import type { LeaseManager } from "./leases.js";
import type { IdempotencyLog } from "./idempotency.js";
import type { TaskGraph } from "./tasks.js";

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
  leaseWaitMs: number;
  skillBudgetTokens: number;
  maxNestedDispatches: number;
  maxReplans: number;
  maxRunHours: number;
  planGate: boolean;
  roleAgentOverrides?: Map<string, string>;
  onGraphChange?(graph: TaskGraph): Promise<void> | void;
  ask(question: string, options?: string[]): Promise<string>;
  approve(call: ToolCall, preview: ToolPreview | null, meta: { roleId: string; taskId: string }): Promise<ApprovalDecision>;
}
