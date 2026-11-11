import type { AgentDef, Settings } from "@stewart/config";
import type { ChatMessage, Clock, FaultKind, HostPort, IdGen, ToolCall } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import type { ApprovalDecision, ToolPreview } from "@stewart/permissions";
import type { RunLedger, CostLimit } from "@stewart/ledger";
import type { LeaseManager, TaskGraph, TaskSpec } from "@stewart/scheduling";
import type { IdempotencyLog } from "@stewart/run-state";
import type { BudgetProfile } from "@stewart/budget";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { RoleDef } from "@stewart/config";
import type { Tool } from "@stewart/tools";
import type { RunEvent } from "@stewart/protocol";
import type { Prompt, PromptOutcome } from "@stewart/interaction";

/** Per-run recovery limits (from settings) plus live counters. */
export interface RecoveryState {
  maxRecoveryDepth: number;
  maxRecoveriesPerRun: number;
  maxSubTasks: number;
  recoverySummaryChars: number;
  maxActionsInRecoveryBrief: number;
  maxContinuations: number;
  maxContinueQuestionsPerRun: number;
  askOnTurnLimit: boolean;
  continueQuestionTimeoutMs: number;
  recoveriesUsed: number;
  questionsUsed: number;
}

export function recoveryState(s: Settings): RecoveryState {
  return {
    maxRecoveryDepth: s.maxRecoveryDepth,
    maxRecoveriesPerRun: s.maxRecoveriesPerRun,
    maxSubTasks: s.maxSubTasks,
    recoverySummaryChars: s.recoverySummaryChars,
    maxActionsInRecoveryBrief: s.maxActionsInRecoveryBrief,
    maxContinuations: s.maxContinuations,
    maxContinueQuestionsPerRun: s.maxContinueQuestionsPerRun,
    askOnTurnLimit: s.askOnTurnLimit,
    continueQuestionTimeoutMs: s.continueQuestionTimeoutMinutes * 60_000,
    recoveriesUsed: 0,
    questionsUsed: 0,
  };
}

export interface TaskResult {
  status: "done" | "failed" | "cancelled" | "parked" | "stopped";
  summary: string;
  filesTouched: string[];
  evidence?: string;
  cycleVictim?: string;
  cycleHolder?: string;
  /** Recoverable fault when the run ended on one; absent otherwise. */
  fault?: FaultKind;
  /** Full transcript (input + produced) for continuations and recovery briefs. */
  transcript?: ChatMessage[];
  /** Resolved model-turn budget, set on turn_limit results. */
  turnBudget?: number;
}

/** Per-task inputs for one role run (the role plus overrides and continuation state). */
export interface RoleTaskDeps {
  role: RoleDef;
  nestedTools?: Tool[];
  depSummaries?: string[];
  /** Continuation transcript; replaces the freshly built briefing. */
  history?: ChatMessage[];
  /** Idempotency index offset for continuations (calls already in `history`). */
  idemOffset?: number;
  /** Extra briefing lines appended to the task brief (size hints, sub-task instructions). */
  extraBriefing?: string;
  /** Approval gate override (e.g. scratch-dir auto-approve); defaults to rt.approve. */
  approve?(call: ToolCall, preview: ToolPreview | null, meta: { roleId: string; taskId: string }): Promise<ApprovalDecision>;
  /** Agent override (direct runs use the chat-selected agent); defaults to the role's bound agent. */
  agent?: AgentDef;
  /** System prompt override; defaults to `buildRolePrompt`. */
  prompt?: string;
}

/** Everything a task runner needs from the owning run. Built once per run by `@stewart/runs`. */
export interface RunRuntime {
  runId: string;
  projectId: string;
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: { emit(ev: RunEvent): void };
  config: EffectiveConfig;
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
  /** Recovery service injected by the app (implemented by `@stewart/recovery`). */
  recoveryService: Recovery;
  onGraphChange?(graph: TaskGraph): Promise<void> | void;
  prompt<A>(p: Prompt<A>, tag?: { roleId?: string; taskId?: string }): Promise<PromptOutcome<A>>;
  approve(call: ToolCall, preview: ToolPreview | null, meta: { roleId: string; taskId: string }): Promise<ApprovalDecision>;
}

/** The routing brain a layer-1 recovery call runs on. */
export interface RecoveryBrain {
  channel: ManagedChannel;
  agent: AgentDef;
}

export interface RecoveryContext {
  depth: number;
  brain?: RecoveryBrain;
}

/** Runs one role task once; recovery wraps it with retry / continue / split layers. */
export type RunTaskOnce = (rt: RunRuntime, spec: TaskSpec, deps: RoleTaskDeps) => Promise<TaskResult>;

/** Fault recovery as orchestration sees it: declared here, implemented by `@stewart/recovery`, injected by the app. */
export interface Recovery {
  /** Hint appended to the briefing when a read-only role is retried after truncation. */
  readonly sizeHint: string;
  /** Per-run counters and limits (created from settings on first use). */
  state(rt: RunRuntime): RecoveryState;
  log(rt: RunRuntime, line: string): void;
  brain(rt: RunRuntime): RecoveryBrain | undefined;
  /** `runOnce` with layer-0 retry, the continue question and layer-1 split. */
  runTask(rt: RunRuntime, spec: TaskSpec, deps: RoleTaskDeps, ctx: RecoveryContext): Promise<TaskResult>;
}
