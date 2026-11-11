import type { AgentDef, RoleDef } from "@stewart/config";
import type { ChatMessage } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import { DEFAULT_BUDGET_PROFILES } from "@stewart/budget";
import { createAgentSession, type AgentSession, type LoopResult } from "@stewart/agent-loop";
import { projectTools, ToolRegistry } from "@stewart/tools";
import { ProjectPaths } from "@stewart/tools";
import { RunCancelledError, classifyFault } from "@stewart/agent-loop";
import { LeaseCycleError } from "@stewart/run-state";
import { TaskGraph } from "@stewart/scheduling";
import { orchestratorDefaultToolNames, type FeatureRun, type RunRuntime, type TaskResult } from "@stewart/run-contract";
import { costLimitPrompt } from "./prompts.js";
import { buildRolePrompt, compactionFor } from "./roleRunner.js";
import { orchestrationTools, type OrchestrationHandlers } from "./tools.js";
import { freeCandidates, rankDeterministic, type Replacement } from "./replacements.js";
import { ORCHESTRATOR_DEFAULT_TOOLS, ORCHESTRATOR_MAX_TOOL_OUTPUT, type OrchestrationOutcome } from "./orchestrator.js";

const UNPARSED_CALL_RE = /<\|?tool_call|<function=|<call>/;
const CALL_NUDGE = "Your previous reply contained a tool call that could not be parsed. Reply again using exactly <tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call>.";

function lastReplyHasUnparsedCall(messages: ChatMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "");
  return !!last && UNPARSED_CALL_RE.test(last.content);
}

function noDispatchMessage(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "");
  const reply = last ? last.content.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  return `Orchestrator finished without dispatching any tasks (model produced no tool call). Last reply: ${reply || "(none)"}`;
}

export interface RunHost {
  readonly rt: RunRuntime;
  readonly orchestrator: RoleDef;
  readonly agent: AgentDef;
  readonly channel: ManagedChannel;
  readonly userText: string;
  readonly history: ChatMessage[];
  readonly handlers: OrchestrationHandlers;
  dispatchCalls: number;
  suggestions: Replacement[];
  readonly graph: TaskGraph;
  readonly parked: string[];
  readonly freeFinished: string[];
  readonly overrides: Map<string, string>;
  readonly featureRuns: readonly FeatureRun[];
  limitAnnounced: boolean;
  rerunParkedTasks(onlyReplaced: boolean): Promise<void>;
  stopParkedTasks(): Promise<void>;
}

export async function buildSession(host: RunHost): Promise<AgentSession> {
  const rt = host.rt;
  const paths = await ProjectPaths.forProject(rt.host);
  const tools = [...projectTools(rt.host, paths).tools, ...orchestrationTools(host.handlers), ...host.featureRuns.flatMap((f) => f.orchestratorTools())];
  const allowed = host.orchestrator.tools.length ? host.orchestrator.tools : [...ORCHESTRATOR_DEFAULT_TOOLS, ...orchestratorDefaultToolNames(rt.features)];
  const registry = new ToolRegistry(tools.filter((t) => allowed.includes(t.spec.name)));
  const prompt = await buildRolePrompt(rt, host.orchestrator);
  const { prune, summarize } = compactionFor(rt);
  return createAgentSession(
    {
      agent: host.agent,
      role: host.orchestrator,
      channel: host.channel,
      registry,
      approve: (call, preview) => rt.approve(call, preview, { roleId: host.orchestrator.id, taskId: "orchestrator" }),
      prompt,
      terminal: new Set(["submit_replacements"]),
      budget: { profile: rt.budgetProfile ?? DEFAULT_BUDGET_PROFILES.normal, ceiling: rt.maxWorkerTurnsCeiling ?? 60 },
      limitsOverride: { maxToolOutputChars: ORCHESTRATOR_MAX_TOOL_OUTPUT, ...(prune ? { prune: true } : {}) },
      summarize,
      meter: { ledger: rt.ledger, cost: rt.cost, runId: rt.runId, roleId: host.orchestrator.id },
      idem: rt.idem.hooks("orchestrator"),
      events: { bus: rt.bus, runId: rt.runId, roleId: host.orchestrator.id },
    },
    rt.clock,
  );
}

function retryInput(host: RunHost, result: LoopResult, flags: { retried: boolean; nudged: boolean }, R: ReturnType<RunRuntime["recoveryService"]["state"]>, input: ChatMessage[]): ChatMessage[] | "return" {
  const rt = host.rt;
  const fault = classifyFault(result);
  if (fault && !flags.retried && R.recoveriesUsed < R.maxRecoveriesPerRun) {
    flags.retried = true;
    R.recoveriesUsed++;
    rt.recoveryService.log(rt, `layer 0: ${fault} on orchestrator, retrying${fault === "incomplete_stream" ? "" : " with size hint"}`);
    return fault === "incomplete_stream" ? input : [...host.history, { role: "user", content: `${host.userText}\n\n${rt.recoveryService.sizeHint}` }];
  }
  if (result.kind !== "failed" && !flags.nudged && host.dispatchCalls === 0 && lastReplyHasUnparsedCall(result.messages)) {
    flags.nudged = true;
    rt.recoveryService.log(rt, "layer 0: unparsed tool call on orchestrator, retrying with format nudge");
    return [...host.history, { role: "user", content: `${host.userText}\n\n${CALL_NUDGE}` }];
  }
  return "return";
}

function sessionError(host: RunHost, e: unknown): OrchestrationOutcome {
  const rt = host.rt;
  rt.leases.releaseAll();
  if (e instanceof RunCancelledError || rt.signal.aborted) return { status: "cancelled", suggestions: host.suggestions };
  if (e instanceof LeaseCycleError) return { status: "failed", error: e.message, suggestions: host.suggestions };
  return { status: "failed", error: e instanceof Error ? e.message : String(e), suggestions: host.suggestions };
}

export async function runSession(host: RunHost, session: AgentSession): Promise<LoopResult | OrchestrationOutcome> {
  const rt = host.rt;
  try {
    const R = rt.recoveryService.state(rt);
    const flags = { retried: false, nudged: false };
    let input: ChatMessage[] = [...host.history, { role: "user", content: host.userText }];
    while (true) {
      const result = await session.loop.run(host.agent.model, input, session.listener, rt.signal);
      const next = retryInput(host, result, flags, R, input);
      if (next === "return") return result;
      input = next;
    }
  } catch (e) {
    return sessionError(host, e);
  }
}

export async function finalize(host: RunHost, result: LoopResult): Promise<OrchestrationOutcome> {
  const rt = host.rt;
  const early = await resolveCostLimit(host);
  if (early) return early;

  rt.leases.releaseAll();
  const reply = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "")?.content;
  if (result.kind === "failed") return { status: "failed", error: result.message, suggestions: host.suggestions };
  if (result.kind === "turn_limit") return { status: "stopped", error: "turn limit reached", reply, suggestions: host.suggestions };
  if (rt.signal.aborted) return { status: "cancelled", suggestions: host.suggestions };
  // Simple rule by design: any completed run with zero valid dispatches is flagged, including
  // direct answers that never routed work. The reply is included so the answer is not lost.
  if (host.dispatchCalls === 0)
    return { status: "no_dispatch", error: noDispatchMessage(result.messages), reply, suggestions: host.suggestions };
  return { status: "done", reply, suggestions: host.suggestions };
}

/** Cost-cap resolution after the Orchestrator loop ends; returns an early outcome or null to continue. */
async function resolveCostLimit(host: RunHost): Promise<OrchestrationOutcome | null> {
  const rt = host.rt;
  if (!rt.cost.reached()) return null;
  if (!host.limitAnnounced) rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
  host.suggestions = host.suggestions.length
    ? host.suggestions
    : rankDeterministic(
        freeCandidates(host.parked.map((t) => ({ roleId: host.graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels),
        rt.config.channels,
      );
  rt.bus.emit({ kind: "cost.summary", runId: rt.runId, ...costSummary(rt, host.graph, host.parked, host.freeFinished, host.suggestions) });
  if (rt.cost.onLimit === "stop") {
    await host.stopParkedTasks();
    rt.leases.releaseAll();
    return { status: "stopped", error: "cost limit reached", suggestions: host.suggestions };
  }
  const co = await rt.prompt(costLimitPrompt(rt.cost.accrued, rt.cost.cap, host.parked.length, host.suggestions.length > 0), { roleId: host.orchestrator.id });
  const choice = co.kind === "answered" ? co.value : "stop";
  if (choice === "continue") {
    const cap = rt.cost.raise();
    rt.bus.emit({ kind: "cost.limit_raised", runId: rt.runId, capUsd: cap });
    await host.rerunParkedTasks(false);
  } else if (choice === "replace") {
    for (const s of host.suggestions) {
      host.overrides.set(s.role, s.agent);
      rt.bus.emit({ kind: "cost.replaced", runId: rt.runId, roleId: s.role, agentId: s.agent, reason: s.reason });
    }
    await host.rerunParkedTasks(true);
  } else {
    await host.stopParkedTasks();
  }
  return null;
}

function costSummary(rt: RunRuntime, graph: TaskGraph, parked: string[], freeFinished: string[], suggestions: Replacement[]) {
  const c = rt.ledger.cost(rt.runId);
  return {
    capUsd: rt.cost.cap,
    accruedUsd: rt.cost.accrued,
    overshootUsd: rt.cost.overshoot(),
    byRole: c.byRole,
    byAgent: c.byAgent,
    parked: parked.map((t) => graph.get(t)?.title ?? t),
    freeFinished: freeFinished.map((t) => graph.get(t)?.title ?? t),
    suggestions,
  };
}
