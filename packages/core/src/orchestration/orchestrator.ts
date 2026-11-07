import type { AgentDef, RoleDef } from "../config/schema.js";
import type { ChatMessage } from "../channels/types.js";
import type { ManagedChannel } from "../channels/registry.js";
import { DEFAULT_BUDGET_PROFILES } from "../limits.js";
import { createAgentSession } from "../agentSession.js";
import { projectTools } from "../tools/builtins.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { RunCancelledError, type LoopResult } from "../tools/toolLoop.js";
import { ToolRegistry, type Tool } from "../tools/types.js";
import { costOfCall, isCosting } from "./ledger.js";
import { LeaseCycleError } from "./writeGuard.js";
import { TaskGraph, type TaskRecord, type TaskSpec } from "./tasks.js";
import { buildRolePrompt, compactionFor, type TaskResult } from "./roleRunner.js";
import { isWriteCapableRole } from "../roles.js";
import { classifyFault } from "./faults.js";
import { ensureRecovery, logRecovery, runTaskRecoverable, SIZE_HINT } from "./recovery.js";
import { orchestrationTools, type OrchestrationHandlers } from "./tools.js";
import { freeCandidates, parseReplacements, rankDeterministic, validateReplacements, type Replacement } from "./replacements.js";
import type { OrchestrationRuntime } from "./types.js";

export interface OrchestrationOutcome {
  status: "done" | "failed" | "cancelled" | "stopped" | "no_dispatch";
  error?: string;
  suggestions: Replacement[];
}

const ORCHESTRATION_ROLES = new Set(["orchestrator"]);
/** Used when the orchestrator role lists no tools: routing only, never project tools. */
export const ORCHESTRATOR_DEFAULT_TOOLS = ["dispatch", "ask_user", "submit_plan", "submit_verdict", "submit_replacements"];
const ORCHESTRATOR_MAX_TOOL_OUTPUT = 4_000;

/** Resolve an enabled role by id. Unknown or disabled ids return undefined; there is no silent fallback. */
export function resolveRole(rt: OrchestrationRuntime, roleId: string): RoleDef | undefined {
  return rt.config.roles.find((r) => r.id === roleId && r.enabled);
}

/** Warning text for an Orchestrator run that never dispatched; includes the last reply so the user sees it. */
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
  return new OrchestratedRun(rt, orchestrator, agent, rt.channelFor(agent.channel), userText).run();
}

class OrchestratedRun {
  private readonly graph = new TaskGraph();
  private readonly results = new Map<string, TaskResult>();
  private readonly pending = new Map<string, Promise<TaskResult>>();
  private readonly parked: string[] = [];
  private readonly freeFinished: string[] = [];
  private readonly nestedUsed = new Map<string, number>();
  private readonly overrides: Map<string, string>;
  private suggestions: Replacement[] = [];
  private replans = 0;
  /** Dispatch calls that named a valid role; zero means the Orchestrator never routed work. */
  private dispatchCalls = 0;
  private milestoneCount = 0;
  private limitAnnounced = false;
  private planApproved = false;
  private readonly handlers: OrchestrationHandlers;

  constructor(
    private readonly rt: OrchestrationRuntime,
    private readonly orchestrator: RoleDef,
    private readonly agent: AgentDef,
    private readonly channel: ManagedChannel,
    private readonly userText: string,
  ) {
    this.overrides = (rt.roleAgentOverrides ??= new Map<string, string>());
    this.handlers = {
      dispatch: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        return this.dispatchArgs(args, 1);
      },
      askUser: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        return rt.ask(args.question, args.options);
      },
      submitPlan: (args) => this.submitPlan(args),
      submitVerdict: (args) => this.submitVerdict(args),
      submitReplacements: (args) => this.submitReplacements(args),
    };
  }

  async run(): Promise<OrchestrationOutcome> {
    const rt = this.rt;
    const paths = await ProjectPaths.forProject(rt.host);
    const tools = [...projectTools(rt.host, paths).tools, ...orchestrationTools(this.handlers)];
    const allowed = this.orchestrator.tools.length ? this.orchestrator.tools : ORCHESTRATOR_DEFAULT_TOOLS;
    const registry = new ToolRegistry(tools.filter((t) => allowed.includes(t.spec.name)));
    const prompt = await buildRolePrompt(rt, this.orchestrator);
    const { prune, summarize } = compactionFor(rt);
    const session = createAgentSession(
      {
        agent: this.agent,
        role: this.orchestrator,
        channel: this.channel,
        registry,
        approve: (call, preview) => rt.approve(call, preview, { roleId: this.orchestrator.id, taskId: "orchestrator" }),
        prompt,
        terminal: new Set(["submit_replacements"]),
        budget: { profile: rt.budgetProfile ?? DEFAULT_BUDGET_PROFILES.normal, ceiling: rt.maxWorkerTurnsCeiling ?? 60 },
        limitsOverride: { maxToolOutputChars: ORCHESTRATOR_MAX_TOOL_OUTPUT, ...(prune ? { prune: true } : {}) },
        summarize,
        meter: { ledger: rt.ledger, cost: rt.cost, runId: rt.runId, roleId: this.orchestrator.id },
        idem: rt.idem.hooks("orchestrator"),
        events: { bus: rt.bus, runId: rt.runId, roleId: this.orchestrator.id },
      },
      rt.clock,
    );

    let result: LoopResult;
    try {
      const R = ensureRecovery(rt);
      let retried = false;
      let nudged = false;
      let input: ChatMessage[] = [{ role: "user", content: this.userText }];
      while (true) {
        result = await session.loop.run(this.agent.model, input, session.listener, rt.signal);
        const fault = classifyFault(result);
        if (fault && !retried && R.recoveriesUsed < R.maxRecoveriesPerRun) {
          retried = true;
          R.recoveriesUsed++;
          logRecovery(rt, `layer 0: ${fault} on orchestrator, retrying${fault === "incomplete_stream" ? "" : " with size hint"}`);
          input = fault === "incomplete_stream" ? input : [{ role: "user", content: `${this.userText}\n\n${SIZE_HINT}` }];
          continue;
        }
        if (result.kind !== "failed" && !nudged && this.dispatchCalls === 0 && lastReplyHasUnparsedCall(result.messages)) {
          nudged = true;
          logRecovery(rt, "layer 0: unparsed tool call on orchestrator, retrying with format nudge");
          input = [{ role: "user", content: `${this.userText}\n\n${CALL_NUDGE}` }];
          continue;
        }
        break;
      }
    } catch (e) {
      rt.leases.releaseAll();
      if (e instanceof RunCancelledError || rt.signal.aborted) return { status: "cancelled", suggestions: this.suggestions };
      if (e instanceof LeaseCycleError) return { status: "failed", error: e.message, suggestions: this.suggestions };
      return { status: "failed", error: e instanceof Error ? e.message : String(e), suggestions: this.suggestions };
    }

    const early = await this.resolveCostLimit();
    if (early) return early;

    rt.leases.releaseAll();
    if (result.kind === "failed") return { status: "failed", error: result.message, suggestions: this.suggestions };
    if (result.kind === "turn_limit") return { status: "stopped", error: "turn limit reached", suggestions: this.suggestions };
    if (rt.signal.aborted) return { status: "cancelled", suggestions: this.suggestions };
    // Simple rule by design: any completed run with zero valid dispatches is flagged, including
    // direct answers that never routed work. The reply is included so the answer is not lost.
    if (this.dispatchCalls === 0) return { status: "no_dispatch", error: noDispatchMessage(result.messages), suggestions: this.suggestions };
    return { status: "done", suggestions: this.suggestions };
  }

  private async syncGraph(): Promise<void> {
    await this.rt.onGraphChange?.(this.graph);
  }

  private replan(reasons: string[] | undefined): string {
    this.replans++;
    if (this.replans > this.rt.maxReplans) {
      return `Verdict recorded: revise, but the replan limit (${this.rt.maxReplans}) is reached. Proceed with the best plan available and report the open risks.`;
    }
    return `Verdict recorded: revise (${this.replans}/${this.rt.maxReplans}). Re-dispatch the planner with these reasons: ${(reasons ?? []).join("; ")}`;
  }

  private async answerNestedAskUser(roleId: string, taskId: string, question: string, options?: string[]): Promise<string> {
    const rt = this.rt;
    const qId = rt.ids.next("q");
    if (!this.channel.unhealthy && (!rt.cost.reached() || !isCosting(this.agent))) {
      try {
        const prior = [...this.results.entries()].map(([id, r]) => `${id}: ${r.summary}`).join("\n");
        const promptText = [
          `User request: ${this.userText}`,
          prior ? `Completed tasks:\n${prior}` : "",
          `Role '${roleId}' asks: ${question}${options?.length ? ` (options: ${options.join(", ")})` : ""}`,
          "If the user request, plan, or completed tasks already answer this, reply with the direct answer. Otherwise reply with DELEGATE_TO_USER.",
        ]
          .filter(Boolean)
          .join("\n\n");
        let reply = "";
        let delegated = false;
        for await (const ev of this.channel.chat({
          model: this.agent.model,
          messages: [
            { role: "system", content: await buildRolePrompt(rt, this.orchestrator) },
            { role: "user", content: promptText },
          ],
          signal: rt.signal,
        })) {
          if (ev.kind === "text") reply += ev.text;
          if (ev.kind === "tool_calls" && ev.calls.some((c) => c.name === "ask_user")) delegated = true;
          if (ev.kind === "done") {
            const costUsd = costOfCall(this.agent, ev.usage, ev.costUsd);
            await rt.ledger.record({
              runId: rt.runId,
              roleId: this.orchestrator.id,
              agentId: this.agent.id,
              model: this.agent.model,
              billing: this.agent.billing ?? "reported",
              inTokens: ev.usage?.in ?? 0,
              outTokens: ev.usage?.out ?? 0,
              costUsd,
            });
            rt.cost.accrued += costUsd;
          }
        }
        const trimmed = reply.trim();
        if (!delegated && trimmed && !trimmed.includes("DELEGATE_TO_USER")) {
          rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId, roleId, questionId: qId, answer: trimmed, answeredBy: "orchestrator" });
          return trimmed;
        }
      } catch {
        /* fall through to user */
      }
    }
    const userAnswer = await rt.ask(question, options);
    rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId, roleId, questionId: qId, answer: userAnswer, answeredBy: "user" });
    return userAnswer;
  }

  private dispatchAt(spec: TaskSpec, depth: number): Promise<TaskResult> {
    const rt = this.rt;
    const role = resolveRole(rt, spec.roleId);
    if (!role) return Promise.resolve({ status: "failed", summary: `no enabled role for '${spec.roleId}' and no General Worker fallback`, filesTouched: [] } as TaskResult);
    if (rt.planGate && !this.planApproved && isWriteCapableRole(role)) {
      const rec = this.graph.add({ ...spec, roleId: role.id });
      rec.status = "failed";
      const r: TaskResult = { status: "failed", summary: "plan gate active: plan must be validated and approved before dispatching write tasks", filesTouched: [] };
      rec.summary = r.summary;
      this.results.set(rec.id, r);
      void this.syncGraph();
      rt.bus.emit({ kind: "task.created", runId: rt.runId, taskId: rec.id, roleId: role.id, title: rec.title, dependsOn: rec.dependsOn });
      rt.bus.emit({ kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: r.summary });
      return Promise.resolve(r);
    }
    const rec = this.graph.add({ ...spec, roleId: role.id });
    rt.leases.register(rec.id);
    void this.syncGraph();
    rt.bus.emit({ kind: "task.created", runId: rt.runId, taskId: rec.id, roleId: role.id, title: rec.title, dependsOn: rec.dependsOn });
    const unknown = rec.dependsOn.find((d) => !this.pending.has(d));
    if (unknown) {
      rec.status = "failed";
      const r: TaskResult = { status: "failed", summary: `unknown dependsOn '${unknown}'`, filesTouched: [] };
      this.results.set(rec.id, r);
      void this.syncGraph();
      rt.bus.emit({ kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: r.summary });
      return Promise.resolve(r);
    }
    const p = this.executeTask(rec, role, depth);
    this.pending.set(rec.id, p);
    return p;
  }

  private async executeTask(rec: TaskRecord, role: RoleDef, depth: number): Promise<TaskResult> {
    const rt = this.rt;
    const deps = (await Promise.all(rec.dependsOn.map((d) => this.pending.get(d)))).filter((d): d is TaskResult => !!d);
    const blocked = deps.find((d) => d.status !== "done");
    if (blocked) {
      rec.status = "blocked";
      await this.syncGraph();
      rt.bus.emit({ kind: "task.blocked", runId: rt.runId, taskId: rec.id, roleId: role.id, waitingOn: "dependency" });
      const r: TaskResult = { status: "stopped", summary: "dependency did not complete", filesTouched: [] };
      this.results.set(rec.id, r);
      return r;
    }
    rec.status = "running";
    await this.syncGraph();
    rt.bus.emit({ kind: "task.started", runId: rt.runId, taskId: rec.id, roleId: role.id, agentId: this.overrides.get(role.id) ?? role.agent });
    const depSummaries = rec.dependsOn.map((d) => `${d}: ${this.results.get(d)?.summary ?? ""}`).filter(Boolean);
    const brain = { channel: this.channel, agent: this.agent };
    let result = await runTaskRecoverable(rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, depth), depSummaries }, { depth: 0, brain });
    if (result.cycleHolder) {
      const holder = result.cycleHolder;
      rt.leases.release(rec.id);
      rec.status = "waiting";
      await this.syncGraph();
      rt.bus.emit({ kind: "task.blocked", runId: rt.runId, taskId: rec.id, roleId: role.id, waitingOn: holder });
      rt.idem.clearTask(rec.id);
      await this.pending.get(holder);
      rec.status = "running";
      await this.syncGraph();
      rt.bus.emit({ kind: "task.started", runId: rt.runId, taskId: rec.id, roleId: role.id, agentId: this.overrides.get(role.id) ?? role.agent });
      result = await runTaskRecoverable(rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, depth), depSummaries }, { depth: 0, brain });
    }
    await this.applyTaskResult(rec, role, result, { requeueParked: true, announceLimit: true });
    return result;
  }

  /** Shared task-completion tail: store the result, update the record, emit the outcome event. */
  private async applyTaskResult(
    rec: TaskRecord,
    role: RoleDef,
    result: TaskResult,
    opts: { requeueParked: boolean; announceLimit: boolean },
  ): Promise<void> {
    const rt = this.rt;
    this.results.set(rec.id, result);
    rt.leases.release(rec.id);
    rec.filesTouched = result.filesTouched;
    rec.status = result.status === "done" ? "done" : result.status === "failed" ? "failed" : result.status === "parked" ? "parked" : "stopped";
    rec.summary = result.summary;
    await this.syncGraph();
    const agentForRole = rt.config.agents.find((a) => a.id === (this.overrides.get(role.id) ?? role.agent));
    if (opts.requeueParked && result.status === "parked") this.parked.push(rec.id);
    if (result.status === "done" && agentForRole && !isCosting(agentForRole)) this.freeFinished.push(rec.id);
    rt.bus.emit(
      result.status === "done"
        ? { kind: "task.done", runId: rt.runId, taskId: rec.id, roleId: role.id, summary: result.summary.slice(0, 400) }
        : { kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: result.summary.slice(0, 400) },
    );
    if (opts.announceLimit && rt.cost.reached() && !this.limitAnnounced) {
      this.limitAnnounced = true;
      rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
    }
  }

  private async rerunParkedTasks(onlyReplaced: boolean): Promise<void> {
    const rt = this.rt;
    const toRun = [...this.parked];
    for (const taskId of toRun) {
      const rec = this.graph.get(taskId);
      if (!rec) continue;
      const role = resolveRole(rt, rec.roleId);
      if (!role) continue;
      if (onlyReplaced && !this.overrides.has(role.id)) continue;
      const effAgent = rt.config.agents.find((a) => a.id === (this.overrides.get(role.id) ?? role.agent));
      if (!effAgent || (rt.cost.reached() && isCosting(effAgent))) continue;
      const idx = this.parked.indexOf(taskId);
      if (idx >= 0) this.parked.splice(idx, 1);
      rec.status = "running";
      await this.syncGraph();
      rt.bus.emit({ kind: "task.started", runId: rt.runId, taskId: rec.id, roleId: role.id, agentId: this.overrides.get(role.id) ?? role.agent });
      const res = await runTaskRecoverable(rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, 1) }, { depth: 0, brain: { channel: this.channel, agent: this.agent } });
      await this.applyTaskResult(rec, role, res, { requeueParked: false, announceLimit: false });
    }
  }

  private async dispatchArgs(args: { role?: string; task: string; files?: string[]; dependsOn?: string[]; expect?: string; title?: string }, depth: number): Promise<string> {
    // Only an omitted role falls back to General Worker; an unknown id is rejected with the valid list.
    const requested = args.role?.trim() ? args.role.trim() : "general-worker";
    const role = resolveRole(this.rt, requested);
    if (!role) {
      const valid = this.rt.config.roles.filter((r) => r.enabled).map((r) => r.id);
      return JSON.stringify({ status: "rejected", error: `unknown role '${requested}'. Valid role ids: ${valid.join(", ") || "(none enabled)"}` });
    }
    this.dispatchCalls++;
    const id = this.rt.ids.next("task");
    const spec: TaskSpec = {
      id,
      roleId: role.id,
      title: args.title ?? `${role.id}: ${args.task.slice(0, 60)}`,
      task: args.task,
      files: args.files ?? [],
      dependsOn: args.dependsOn ?? [],
      expect: args.expect,
    };
    const result = await this.dispatchAt(spec, depth);
    return JSON.stringify({ taskId: id, role: spec.roleId, status: result.status, summary: result.summary, filesTouched: result.filesTouched });
  }

  /** Orchestration verbs a dispatched role may call: nested dispatch (depth < 2) plus its terminal verb. */
  private roleVerbs(role: RoleDef, parentId: string, depth: number): Tool[] {
    const rt = this.rt;
    const wanted = role.tools.length ? role.tools : ["dispatch", "submit_plan", "submit_verdict"];
    const canDispatch = depth < 2 && wanted.includes("dispatch");
    return orchestrationTools({
      dispatch: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        const used = this.nestedUsed.get(parentId) ?? 0;
        if (used >= rt.maxNestedDispatches) return `Nested dispatch budget exhausted (${rt.maxNestedDispatches} per task).`;
        this.nestedUsed.set(parentId, used + 1);
        return this.dispatchArgs(args, depth + 1);
      },
      askUser: async (args, signal) => (signal.aborted ? "Cancelled." : this.answerNestedAskUser(role.id, parentId, args.question, args.options)),
      submitPlan: (args) => this.handlers.submitPlan(args),
      submitVerdict: (args) => this.handlers.submitVerdict(args),
      submitReplacements: () => "Replacements are submitted by the Orchestrator.",
    }).filter((t) => (t.spec.name === "dispatch" ? canDispatch : wanted.includes(t.spec.name)));
  }

  private submitPlan(args: { milestones: { title: string; acceptance?: string }[] }): string {
    this.milestoneCount = args.milestones?.length ?? 0;
    this.rt.bus.emit({ kind: "plan.created", runId: this.rt.runId, milestoneCount: this.milestoneCount });
    return `Plan recorded with ${this.milestoneCount} milestone(s). Dispatch the plan-validator role next, then implementation tasks.`;
  }

  private async submitVerdict(args: { verdict: "approve" | "revise"; reasons?: string[] }): Promise<string> {
    const rt = this.rt;
    rt.bus.emit({ kind: "plan.validated", runId: rt.runId, verdict: args.verdict, reasons: args.reasons ?? [] });
    if (args.verdict !== "approve") return this.replan(args.reasons);
    if (rt.planGate && !this.planApproved) {
      const choice = await rt.ask(`Plan approved by the validator (${this.milestoneCount} milestones). Proceed?`, ["Proceed", "Revise"]);
      if (!choice.startsWith("Proceed")) return this.replan([choice]);
    }
    this.planApproved = true;
    rt.bus.emit({ kind: "plan.approved", runId: rt.runId, milestoneCount: this.milestoneCount });
    return "Verdict recorded: approved. Proceed with implementation dispatches.";
  }

  private submitReplacements(args: { replacements: { role: string; agent: string; reason: string }[] }): string {
    const rt = this.rt;
    const candidates = freeCandidates(this.parked.map((t) => ({ roleId: this.graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels);
    this.suggestions = validateReplacements(parseReplacements(args), candidates);
    for (const s of this.suggestions) rt.bus.emit({ kind: "cost.replaced", runId: rt.runId, roleId: s.role, agentId: s.agent, reason: s.reason });
    return `Replacements recorded: ${this.suggestions.map((s) => `${s.role}→${s.agent}`).join(", ") || "none valid"}`;
  }

  /** Cost-cap resolution after the Orchestrator loop ends; returns an early outcome or null to continue. */
  private async resolveCostLimit(): Promise<OrchestrationOutcome | null> {
    const rt = this.rt;
    if (!rt.cost.reached()) return null;
    if (!this.limitAnnounced) rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
    this.suggestions = this.suggestions.length
      ? this.suggestions
      : rankDeterministic(
          freeCandidates(this.parked.map((t) => ({ roleId: this.graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels),
          rt.config.channels,
        );
    rt.bus.emit({ kind: "cost.summary", runId: rt.runId, ...costSummary(rt, this.graph, this.parked, this.freeFinished, this.suggestions) });
    if (rt.cost.onLimit === "stop") {
      await this.stopParkedTasks();
      rt.leases.releaseAll();
      return { status: "stopped", error: "cost limit reached", suggestions: this.suggestions };
    }
    const choice = await rt.ask(
      `Cost limit reached: $${rt.cost.accrued.toFixed(2)} of $${rt.cost.cap.toFixed(2)}. ${this.parked.length} task(s) parked.`,
      ["Continue (+cost cap)", ...(this.suggestions.length ? ["Use suggested replacements"] : []), "Stop"],
    );
    if (choice.startsWith("Continue")) {
      const cap = rt.cost.raise();
      rt.bus.emit({ kind: "cost.limit_raised", runId: rt.runId, capUsd: cap });
      await this.rerunParkedTasks(false);
    } else if (choice.startsWith("Use suggested replacements")) {
      for (const s of this.suggestions) {
        this.overrides.set(s.role, s.agent);
        rt.bus.emit({ kind: "cost.replaced", runId: rt.runId, roleId: s.role, agentId: s.agent, reason: s.reason });
      }
      await this.rerunParkedTasks(true);
    } else {
      await this.stopParkedTasks();
    }
    return null;
  }

  private async stopParkedTasks(): Promise<void> {
    for (const taskId of this.parked) {
      const rec = this.graph.get(taskId);
      if (rec) {
        rec.status = "stopped";
        rec.summary = "stopped: cost_limit";
      }
    }
    await this.syncGraph();
  }
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
