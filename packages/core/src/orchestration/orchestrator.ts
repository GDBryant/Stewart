import type { RoleDef } from "../config/schema.js";
import { DEFAULT_CAPS } from "../channels/types.js";
import { roleTurnBudget } from "../roles.js";
import { projectTools } from "../tools/builtins.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type LoopResult, type ToolsMode } from "../tools/toolLoop.js";
import { ToolRegistry, type Tool } from "../tools/types.js";
import { costOfCall } from "./ledger.js";
import { LeaseCycleError } from "./writeGuard.js";
import { TaskGraph, type TaskSpec } from "./tasks.js";
import { runRoleTask, buildRolePrompt, type TaskResult } from "./roleRunner.js";
import { orchestrationTools, type OrchestrationHandlers } from "./tools.js";
import { freeCandidates, parseReplacements, rankDeterministic, validateReplacements, type Replacement } from "./replacements.js";
import type { OrchestrationRuntime } from "./types.js";

export interface OrchestrationOutcome {
  status: "done" | "failed" | "cancelled" | "stopped";
  error?: string;
  suggestions: Replacement[];
}

const ORCHESTRATION_ROLES = new Set(["orchestrator"]);

/** Resolve the role to run for a dispatch; a disabled role falls back to General Worker. */
function resolveRole(rt: OrchestrationRuntime, roleId: string): RoleDef | undefined {
  const wanted = rt.config.roles.find((r) => r.id === roleId && r.enabled);
  if (wanted) return wanted;
  return rt.config.roles.find((r) => r.id === "general-worker" && r.enabled);
}

/**
 * One orchestrated run: the Orchestrator routes work through `dispatch`, core
 * schedules the tasks (parallel where independent), the ledger meters cost and
 * the cap parks costing work.
 */
export async function runOrchestrated(rt: OrchestrationRuntime, userText: string): Promise<OrchestrationOutcome> {
  const orchestrator = rt.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  if (!orchestrator) return { status: "failed", error: "orchestrator role is not enabled", suggestions: [] };
  const agent = rt.config.agents.find((a) => a.id === orchestrator.agent);
  if (!agent) return { status: "failed", error: `role orchestrator: enabled but no agent bound`, suggestions: [] };
  const channel = rt.channelFor(agent.channel);

  const graph = new TaskGraph();
  const results = new Map<string, TaskResult>();
  const pending = new Map<string, Promise<TaskResult>>();
  const parked: string[] = [];
  const freeFinished: string[] = [];
  const nestedUsed = new Map<string, number>();
  let suggestions: Replacement[] = [];
  let replans = 0;
  let milestoneCount = 0;
  let limitAnnounced = false;
  let planApproved = false;

  const replan = (reasons: string[] | undefined): string => {
    replans++;
    if (replans > rt.maxReplans) {
      return `Verdict recorded: revise, but the replan limit (${rt.maxReplans}) is reached. Proceed with the best plan available and report the open risks.`;
    }
    return `Verdict recorded: revise (${replans}/${rt.maxReplans}). Re-dispatch the planner with these reasons: ${(reasons ?? []).join("; ")}`;
  };

  const dispatchAt = (spec: TaskSpec, depth: number): Promise<TaskResult> => {
    const role = resolveRole(rt, spec.roleId);
    if (!role) return Promise.resolve({ status: "failed", summary: `no enabled role for '${spec.roleId}' and no General Worker fallback`, filesTouched: [] } as TaskResult);
    if (rt.maxRunHours > 0 && rt.clock.now() - rt.startedAt > rt.maxRunHours * 3_600_000) {
      return Promise.resolve({ status: "stopped", summary: `run hour limit reached (${rt.maxRunHours}h)`, filesTouched: [] } as TaskResult);
    }
    const rec = graph.add({ ...spec, roleId: role.id });
    rt.leases.register(rec.id);
    rt.bus.emit({ kind: "task.created", runId: rt.runId, taskId: rec.id, roleId: role.id, title: rec.title, dependsOn: rec.dependsOn });
    const unknown = rec.dependsOn.find((d) => !pending.has(d));
    if (unknown) {
      rec.status = "failed";
      const r: TaskResult = { status: "failed", summary: `unknown dependsOn '${unknown}'`, filesTouched: [] };
      results.set(rec.id, r);
      rt.bus.emit({ kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: r.summary });
      return Promise.resolve(r);
    }
    const p = (async (): Promise<TaskResult> => {
      const deps = (await Promise.all(rec.dependsOn.map((d) => pending.get(d)))).filter((d): d is TaskResult => !!d);
      const blocked = deps.find((d) => d.status !== "done");
      if (blocked) {
        rec.status = "blocked";
        rt.bus.emit({ kind: "task.blocked", runId: rt.runId, taskId: rec.id, roleId: role.id, waitingOn: "dependency" });
        const r: TaskResult = { status: "stopped", summary: "dependency did not complete", filesTouched: [] };
        results.set(rec.id, r);
        return r;
      }
      rec.status = "running";
      rt.bus.emit({ kind: "task.started", runId: rt.runId, taskId: rec.id, roleId: role.id });
      const agentForRole = rt.config.agents.find((a) => a.id === role.agent);
      const result = await runRoleTask(rt, rec, { role, nestedTools: roleVerbs(role, rec.id, depth) });
      results.set(rec.id, result);
      rt.leases.release(rec.id);
      rec.filesTouched = result.filesTouched;
      rec.status = result.status === "done" ? "done" : result.status === "failed" ? "failed" : result.status === "parked" ? "parked" : "stopped";
      rec.summary = result.summary;
      if (result.status === "parked") parked.push(rec.id);
      if (result.status === "done" && agentForRole && (agentForRole.billing === "free" || agentForRole.billing === "unmetered")) freeFinished.push(rec.id);
      rt.bus.emit(
        result.status === "done"
          ? { kind: "task.done", runId: rt.runId, taskId: rec.id, roleId: role.id, summary: result.summary.slice(0, 400) }
          : { kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: result.summary.slice(0, 400) },
      );
      if (rt.cost.reached() && !limitAnnounced) {
        limitAnnounced = true;
        rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
      }
      return result;
    })();
    pending.set(rec.id, p);
    return p;
  };

  const dispatchArgs = async (args: { role: string; task: string; files?: string[]; dependsOn?: string[]; expect?: string; title?: string }, depth: number): Promise<string> => {
    const id = rt.ids.next("task");
    const spec: TaskSpec = {
      id,
      roleId: args.role,
      title: args.title ?? `${args.role}: ${args.task.slice(0, 60)}`,
      task: args.task,
      files: args.files ?? [],
      dependsOn: args.dependsOn ?? [],
      expect: args.expect,
    };
    const result = await dispatchAt(spec, depth);
    return JSON.stringify({ taskId: id, role: spec.roleId, status: result.status, summary: result.summary, filesTouched: result.filesTouched });
  };

  /** Orchestration verbs a dispatched role may call: nested dispatch (depth < 2) plus its terminal verb. */
  const roleVerbs = (role: RoleDef, parentId: string, depth: number): Tool[] => {
    const wanted = role.tools.length ? role.tools : ["dispatch", "submit_plan", "submit_verdict"];
    const canDispatch = depth < 2 && wanted.includes("dispatch");
    return orchestrationTools({
      dispatch: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        const used = nestedUsed.get(parentId) ?? 0;
        if (used >= rt.maxNestedDispatches) return `Nested dispatch budget exhausted (${rt.maxNestedDispatches} per task).`;
        nestedUsed.set(parentId, used + 1);
        return dispatchArgs(args, depth + 1);
      },
      askUser: async (args, signal) => (signal.aborted ? "Cancelled." : rt.ask(args.question, args.options)),
      submitPlan: (args) => handlers.submitPlan(args),
      submitVerdict: (args) => handlers.submitVerdict(args),
      submitReplacements: () => "Replacements are submitted by the Orchestrator.",
    }).filter((t) => (t.spec.name === "dispatch" ? canDispatch : wanted.includes(t.spec.name)));
  };

  const handlers: OrchestrationHandlers = {
    async dispatch(args, signal) {
      if (signal.aborted) return "Cancelled.";
      return dispatchArgs(args, 1);
    },
    async askUser(args, signal) {
      if (signal.aborted) return "Cancelled.";
      return rt.ask(args.question, args.options);
    },
    submitPlan(args) {
      milestoneCount = args.milestones?.length ?? 0;
      rt.bus.emit({ kind: "plan.created", runId: rt.runId, milestoneCount });
      return `Plan recorded with ${milestoneCount} milestone(s). Dispatch the plan-validator role next, then implementation tasks.`;
    },
    async submitVerdict(args) {
      rt.bus.emit({ kind: "plan.validated", runId: rt.runId, verdict: args.verdict, reasons: args.reasons ?? [] });
      if (args.verdict !== "approve") return replan(args.reasons);
      if (rt.planGate && !planApproved) {
        const choice = await rt.ask(`Plan approved by the validator (${milestoneCount} milestones). Proceed?`, ["Proceed", "Revise"]);
        if (!choice.startsWith("Proceed")) return replan([choice]);
      }
      planApproved = true;
      rt.bus.emit({ kind: "plan.approved", runId: rt.runId, milestoneCount });
      return "Verdict recorded: approved. Proceed with implementation dispatches.";
    },
    submitReplacements(args) {
      const candidates = freeCandidates(parked.map((t) => ({ roleId: graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels);
      suggestions = validateReplacements(parseReplacements(args), candidates);
      for (const s of suggestions) rt.bus.emit({ kind: "cost.replaced", runId: rt.runId, roleId: s.role, agentId: s.agent, reason: s.reason });
      return `Replacements recorded: ${suggestions.map((s) => `${s.role}→${s.agent}`).join(", ") || "none valid"}`;
    },
  };


  const paths = await ProjectPaths.forProject(rt.host);
  const tools = [...projectTools(rt.host, paths).tools, ...orchestrationTools(handlers)];
  const registry = new ToolRegistry(tools.filter((t) => !orchestrator.tools.length || orchestrator.tools.includes(t.spec.name)));
  const prompt = await buildRolePrompt(rt, orchestrator);
  const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
  const limits = { ...DEFAULT_LIMITS, maxModelTurns: roleTurnBudget(orchestrator) };
  const loop = new ToolLoop(
    channel,
    registry,
    (call, preview) => rt.approve(call, preview, { roleId: orchestrator.id, taskId: "orchestrator" }),
    limits,
    rt.clock,
    prompt,
    new Set(["submit_replacements"]),
    mode,
    rt.idem.hooks("orchestrator"),
  );

  const listener = {
    onText: (t: string) => rt.bus.emit({ kind: "text_delta", runId: rt.runId, roleId: orchestrator.id, seq: 0, text: t }),
    onReasoning: (t: string) => rt.bus.emit({ kind: "reasoning_delta", runId: rt.runId, roleId: orchestrator.id, seq: 0, text: t }),
    onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) =>
      rt.bus.emit({ kind: "tool.request", runId: rt.runId, roleId: orchestrator.id, callId: call.id, tool: call.name, args: call.arguments, category: call.name }),
    onToolOutcome: (call: { id: string }, outcome: { kind: string }) =>
      rt.bus.emit({ kind: "tool.outcome", runId: rt.runId, roleId: orchestrator.id, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind }),
    onUsage: (usage: { in: number; out: number } | undefined, reported: number | undefined) => {
      const costUsd = costOfCall(agent, usage, reported);
      rt.cost.accrued = rt.cost.accrued + costUsd;
      void rt.ledger.record({
        runId: rt.runId,
        roleId: orchestrator.id,
        agentId: agent.id,
        model: agent.model,
        billing: agent.billing ?? "reported",
        inTokens: usage?.in ?? 0,
        outTokens: usage?.out ?? 0,
        costUsd,
      });
    },
  };

  let result: LoopResult;
  try {
    result = await loop.run(agent.model, [{ role: "user", content: userText }], listener, rt.signal);
  } catch (e) {
    if (e instanceof RunCancelledError || rt.signal.aborted) {
      rt.leases.releaseAll();
      return { status: "cancelled", suggestions };
    }
    if (e instanceof LeaseCycleError) {
      rt.leases.releaseAll();
      return { status: "failed", error: e.message, suggestions };
    }
    rt.leases.releaseAll();
    return { status: "failed", error: e instanceof Error ? e.message : String(e), suggestions };
  }

  if (rt.cost.reached()) {
    if (!limitAnnounced) rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
    suggestions = suggestions.length ? suggestions : rankDeterministic(
      freeCandidates(parked.map((t) => ({ roleId: graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels),
      rt.config.channels,
    );
    rt.bus.emit({ kind: "cost.summary", runId: rt.runId, ...costSummary(rt, graph, parked, freeFinished, suggestions) });
    const choice = await rt.ask(
      `Cost limit reached: $${rt.cost.accrued.toFixed(2)} of $${rt.cost.cap.toFixed(2)}. ${parked.length} task(s) parked.`,
      ["Continue (+cost cap)", ...(suggestions.length ? ["Use suggested replacements"] : []), "Stop"],
    );
    if (choice.startsWith("Continue")) {
      const cap = rt.cost.raise();
      rt.bus.emit({ kind: "cost.limit_raised", runId: rt.runId, capUsd: cap });
    }
  }

  rt.leases.releaseAll();
  if (result.kind === "failed") return { status: "failed", error: result.message, suggestions };
  if (result.kind === "turn_limit") return { status: "stopped", error: "turn limit reached", suggestions };
  if (rt.signal.aborted) return { status: "cancelled", suggestions };
  return { status: "done", suggestions };
}

function costSummary(rt: OrchestrationRuntime, graph: TaskGraph, parked: string[], freeFinished: string[], suggestions: Replacement[]) {
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

export function isOrchestrationRole(roleId: string): boolean {
  return ORCHESTRATION_ROLES.has(roleId);
}
