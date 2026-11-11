import type { AgentDef, RoleDef } from "@stewart/config";
import { roleTurnBudget } from "@stewart/roles-skills";
import type { ChatMessage } from "@stewart/kernel";
import type { Clock } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { ToolRegistry } from "@stewart/tools";
import { DEFAULT_LIMITS, type LoopLimits, resolveLimits, type BudgetProfile } from "@stewart/budget";
import type { IdempotencyHooks } from "@stewart/kernel";
import { ToolLoop } from "./toolLoop.js";
import type { ApprovalGate } from "@stewart/permissions";
import type { LoopListener } from "./loopTypes.js";
import { profileFromChannel, type ModelProfile } from "@stewart/models";
import { costOfCall, type CostLimit, type RunLedger } from "@stewart/ledger";

export interface SessionSpec {
  agent: AgentDef;
  role?: RoleDef;
  channel: ManagedChannel;
  registry: ToolRegistry;
  approve: ApprovalGate;
  prompt?: string;
  terminal?: Set<string>;
  /** Budget-derived limits via `resolveLimits`; absent = `DEFAULT_LIMITS` (bench, recovery). */
  budget?: { profile: BudgetProfile; ceiling: number };
  /** Applied over the resolved limits; with `budget`, turns can never exceed the resolved value. */
  limitsOverride?: Partial<LoopLimits>;
  /** Records each model call to the ledger and accrues `cost`; absent = no metering. */
  meter?: { ledger: RunLedger; cost: Pick<CostLimit, "accrued">; runId: string; taskId?: string; roleId?: string };
  idem?: IdempotencyHooks;
  /** Summarize-stage hook (R3.3); absent = prune/clip only. */
  summarize?: (middle: ChatMessage[]) => Promise<string>;
  /** Standard stream events; absent = silent. */
  events?: { bus: { emit(ev: RunEvent): void }; runId: string; taskId?: string; roleId?: string };
  /** Run before the standard emit; for call-site extras (files touched, terminal call id). */
  hooks?: Pick<LoopListener, "onToolRequested" | "onToolOutcome">;
}

export interface AgentSession {
  loop: ToolLoop;
  listener: LoopListener;
  profile: ModelProfile;
  limits: LoopLimits;
}

function sessionLimits(spec: SessionSpec, profile: ModelProfile, role: SessionSpec["role"]): LoopLimits {
  if (!spec.budget) return { ...DEFAULT_LIMITS, ...spec.limitsOverride };
  const resolved = resolveLimits({ baseTurns: role ? roleTurnBudget(role) : undefined, agent: spec.agent, profile: spec.budget.profile, ceiling: spec.budget.ceiling, model: profile });
  const resolvedTurns = resolved.maxModelTurns;
  const limits = { ...resolved, ...spec.limitsOverride };
  if (spec.limitsOverride?.maxModelTurns !== undefined) limits.maxModelTurns = Math.min(spec.limitsOverride.maxModelTurns, resolvedTurns);
  return limits;
}

function wireEventListener(listener: LoopListener, spec: SessionSpec): void {
  const { events } = spec;
  const ids = events ? { runId: events.runId, ...(events.taskId ? { taskId: events.taskId } : {}), ...(events.roleId ? { roleId: events.roleId } : {}) } : undefined;
  if (events && ids) {
    const { bus } = events;
    listener.onText = (t) => bus.emit({ kind: "text_delta", ...ids, seq: 0, text: t });
    listener.onReasoning = (t) => bus.emit({ kind: "reasoning_delta", ...ids, seq: 0, text: t });
    listener.onCompacted = (before, after, detail) =>
      bus.emit({
        kind: "compaction",
        ...ids,
        droppedTokens: Math.max(0, before - after),
        beforeTokens: before,
        afterTokens: after,
        ...(detail ? { pruned: detail.pruned, summarized: detail.summarized } : {}),
      });
  }
  listener.onToolRequested = (call) => {
    spec.hooks?.onToolRequested?.(call);
    if (events && ids) events.bus.emit({ kind: "tool.request", ...ids, callId: call.id, tool: call.name, args: call.arguments, category: call.name });
  };
  listener.onToolOutcome = (call, outcome) => {
    spec.hooks?.onToolOutcome?.(call, outcome);
    if (events && ids) events.bus.emit({ kind: "tool.outcome", ...ids, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind });
  };
}

function wireMeterListener(listener: LoopListener, spec: SessionSpec, agent: SessionSpec["agent"]): void {
  const { meter } = spec;
  if (!meter) return;
  listener.onUsage = async (usage, reported) => {
    const costUsd = costOfCall(agent, usage, reported);
    await meter.ledger.record({
      runId: meter.runId,
      ...(meter.taskId ? { taskId: meter.taskId } : {}),
      roleId: meter.roleId,
      agentId: agent.id,
      model: agent.model,
      billing: agent.billing ?? "reported",
      inTokens: usage?.in ?? 0,
      outTokens: usage?.out ?? 0,
      costUsd,
    });
    meter.cost.accrued += costUsd;
  };
}

/** The only place a `ToolLoop` is built: model profile -> limits -> listener (events + ledger). */
export function createAgentSession(spec: SessionSpec, clock: Clock): AgentSession {
  const { agent, role, channel } = spec;
  const profile = profileFromChannel(channel.cfg, { channel: agent.channel, model: agent.model, agent });
  const limits = sessionLimits(spec, profile, role);
  const listener: LoopListener = {};
  wireEventListener(listener, spec);
  wireMeterListener(listener, spec, agent);
  const loop = new ToolLoop(channel, spec.registry, spec.approve, limits, clock, spec.prompt, spec.terminal ?? new Set(), profile.toolsMode, spec.idem, spec.summarize);
  return { loop, listener, profile, limits };
}
