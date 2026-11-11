import type { AgentDef, RoleDef } from "@stewart/config";
import type { ChatMessage } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import { TaskGraph, type TaskRecord, type TaskSpec } from "@stewart/scheduling";
import { runPreflight, type FeatureRun, type RunRuntime, type TaskResult } from "@stewart/run-contract";
import { questionPrompt } from "@stewart/interaction";
import { NO_ANSWER } from "./prompts.js";
import { isWriteCapableRole } from "@stewart/roles-skills";
import { orchestrationTools, type OrchestrationHandlers } from "./tools.js";
import type { Tool } from "@stewart/tools";
import { freeCandidates, parseReplacements, validateReplacements, type Replacement } from "./replacements.js";
import { isCosting } from "@stewart/models";
import { answerNestedAskUser } from "./askUser.js";
import { buildSession, finalize, runSession, type RunHost } from "./runSupport.js";
import { ORCHESTRATOR_MAX_TOOL_OUTPUT, resolveRole, type OrchestrationOutcome } from "./orchestrator.js";
import { taskOutcomeEvent, taskRecordStatus } from "./taskEvents.js";
import { PlanVerbs } from "./planVerbs.js";

/**
 * One orchestrated run: the Orchestrator routes work through `dispatch`, core
 * schedules the tasks (parallel where independent), the ledger meters cost and
 * the cap parks costing work.
 */
export async function runOrchestrated(rt: RunRuntime, userText: string, history: ChatMessage[] = []): Promise<OrchestrationOutcome> {
  const orchestrator = rt.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  if (!orchestrator) return { status: "failed", error: "orchestrator role is not enabled", suggestions: [] };
  const agent = rt.config.agents.find((a) => a.id === orchestrator.agent);
  if (!agent) return { status: "failed", error: `role orchestrator: enabled but no agent bound`, suggestions: [] };
  const refused = runPreflight(rt.features, userText, rt);
  if (refused) return { status: "failed", error: refused, suggestions: [] };
  return new OrchestratedRun({ rt, orchestrator, agent, channel: rt.channelFor(agent.channel), userText, history }).run();
}

/** Inputs for one OrchestratedRun; `history` defaults to an empty transcript. */
export interface OrchestratedRunInit {
  rt: RunRuntime;
  orchestrator: RoleDef;
  agent: AgentDef;
  channel: ManagedChannel;
  userText: string;
  history?: ChatMessage[];
}

export class OrchestratedRun implements RunHost {
  readonly rt: RunRuntime;
  readonly orchestrator: RoleDef;
  readonly agent: AgentDef;
  readonly channel: ManagedChannel;
  readonly userText: string;
  readonly history: ChatMessage[];
  readonly graph = new TaskGraph();
  readonly results = new Map<string, TaskResult>();
  private readonly pending = new Map<string, Promise<TaskResult>>();
  readonly parked: string[] = [];
  readonly freeFinished: string[] = [];
  private readonly nestedUsed = new Map<string, number>();
  readonly overrides: Map<string, string>;
  suggestions: Replacement[] = [];
  /** Dispatch calls that named a valid role; zero means the Orchestrator never routed work. */
  dispatchCalls = 0;
  limitAnnounced = false;
  private readonly plan: PlanVerbs;
  readonly handlers: OrchestrationHandlers;
  /** Per-run state of each plugged-in feature (tools offered to the Orchestrator and to dispatched tasks). */
  readonly featureRuns: readonly FeatureRun[];

  constructor(init: OrchestratedRunInit) {
    this.rt = init.rt;
    this.orchestrator = init.orchestrator;
    this.agent = init.agent;
    this.channel = init.channel;
    this.userText = init.userText;
    this.history = init.history ?? [];
    const rt = this.rt;
    this.overrides = (rt.roleAgentOverrides ??= new Map<string, string>());
    this.plan = new PlanVerbs(rt, init.orchestrator);
    this.featureRuns = (rt.features ?? []).map((f) => f.createRun(rt, { tasks: () => this.graph.all(), maxOutputChars: ORCHESTRATOR_MAX_TOOL_OUTPUT }));
    this.handlers = {
      dispatch: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        return this.dispatchArgs(args, 1);
      },
      askUser: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        const o = await rt.prompt(questionPrompt("ask_user", args.question, args.options), { roleId: this.orchestrator.id });
        return o.kind === "answered" ? o.value : NO_ANSWER;
      },
      submitPlan: (args) => this.plan.submitPlan(args),
      submitVerdict: (args) => this.plan.submitVerdict(args),
      submitReplacements: (args) => this.submitReplacements(args),
    };
  }

  async run(): Promise<OrchestrationOutcome> {
    const session = await buildSession(this);
    const ran = await runSession(this, session);
    if ("status" in ran) return ran;
    return finalize(this, ran);
  }

  private async syncGraph(): Promise<void> {
    await this.rt.onGraphChange?.(this.graph);
  }

  private dispatchAt(spec: TaskSpec, depth: number): Promise<TaskResult> {
    const rt = this.rt;
    const role = resolveRole(rt, spec.roleId);
    if (!role) return Promise.resolve({ status: "failed", summary: `no enabled role for '${spec.roleId}' and no General Worker fallback`, filesTouched: [] } as TaskResult);
    if (rt.planGate && !this.plan.isApproved && isWriteCapableRole(role)) {
      const added = this.graph.add({ ...spec, roleId: role.id });
      if (!added.ok) return Promise.resolve({ status: "failed", summary: added.error.message, filesTouched: [] });
      const rec = added.value;
      rec.status = "failed";
      const r: TaskResult = { status: "failed", summary: "plan gate active: plan must be validated and approved before dispatching write tasks", filesTouched: [] };
      rec.summary = r.summary;
      this.results.set(rec.id, r);
      void this.syncGraph();
      rt.bus.emit({ kind: "task.created", runId: rt.runId, taskId: rec.id, roleId: role.id, title: rec.title, dependsOn: rec.dependsOn });
      rt.bus.emit({ kind: "task.failed", runId: rt.runId, taskId: rec.id, roleId: role.id, error: r.summary });
      return Promise.resolve(r);
    }
    const added = this.graph.add({ ...spec, roleId: role.id });
    if (!added.ok) return Promise.resolve({ status: "failed", summary: added.error.message, filesTouched: [] });
    const rec = added.value;
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
    let result = await rt.recoveryService.runTask(rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, depth), depSummaries }, { depth: 0, brain });
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
      result = await rt.recoveryService.runTask(rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, depth), depSummaries }, { depth: 0, brain });
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
    rec.status = taskRecordStatus(result);
    rec.summary = result.summary;
    await this.syncGraph();
    const agentForRole = rt.config.agents.find((a) => a.id === (this.overrides.get(role.id) ?? role.agent));
    if (opts.requeueParked && result.status === "parked") this.parked.push(rec.id);
    if (result.status === "done" && agentForRole && !isCosting(agentForRole)) this.freeFinished.push(rec.id);
    rt.bus.emit(taskOutcomeEvent(rt, rec, role, result));
    if (opts.announceLimit && rt.cost.reached() && !this.limitAnnounced) {
      this.limitAnnounced = true;
      rt.bus.emit({ kind: "cost.limit_reached", runId: rt.runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued });
    }
  }

  async rerunParkedTasks(onlyReplaced: boolean): Promise<void> {
    for (const taskId of [...this.parked]) {
      const rec = this.graph.get(taskId);
      const role = rec && this.rerunRole(rec.roleId, onlyReplaced);
      if (rec && role) await this.rerunTask(rec, role);
    }
  }

  /** Role to rerun a parked task under, or undefined when it cannot run now (unknown, not replaced, or costing past the cap). */
  private rerunRole(roleId: string, onlyReplaced: boolean): RoleDef | undefined {
    const role = resolveRole(this.rt, roleId);
    if (!role || (onlyReplaced && !this.overrides.has(role.id))) return undefined;
    const effAgent = this.rt.config.agents.find((a) => a.id === (this.overrides.get(role.id) ?? role.agent));
    return !effAgent || (this.rt.cost.reached() && isCosting(effAgent)) ? undefined : role;
  }
  private async rerunTask(rec: TaskRecord, role: RoleDef): Promise<void> {
    if (this.parked.includes(rec.id)) this.parked.splice(this.parked.indexOf(rec.id), 1);
    rec.status = "running"; await this.syncGraph();
    this.rt.bus.emit({ kind: "task.started", runId: this.rt.runId, taskId: rec.id, roleId: role.id, agentId: this.overrides.get(role.id) ?? role.agent });
    const res = await this.rt.recoveryService.runTask(this.rt, rec, { role, nestedTools: this.roleVerbs(role, rec.id, 1) }, { depth: 0, brain: { channel: this.channel, agent: this.agent } });
    await this.applyTaskResult(rec, role, res, { requeueParked: false, announceLimit: false });
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
    const verbs = orchestrationTools({
      dispatch: async (args, signal) => {
        if (signal.aborted) return "Cancelled.";
        const used = this.nestedUsed.get(parentId) ?? 0;
        if (used >= rt.maxNestedDispatches) return `Nested dispatch budget exhausted (${rt.maxNestedDispatches} per task).`;
        this.nestedUsed.set(parentId, used + 1);
        return this.dispatchArgs(args, depth + 1);
      },
      askUser: async (args, signal) => (signal.aborted ? "Cancelled." : answerNestedAskUser(this, { roleId: role.id, taskId: parentId, question: args.question, options: args.options })),
      submitPlan: (args) => this.handlers.submitPlan(args),
      submitVerdict: (args) => this.handlers.submitVerdict(args),
      submitReplacements: () => "Replacements are submitted by the Orchestrator.",
    }).filter((t) => (t.spec.name === "dispatch" ? canDispatch : wanted.includes(t.spec.name)));
    const featureTools = this.featureRuns.flatMap((f) => f.taskTools(parentId)).filter((t) => wanted.includes(t.spec.name));
    return [...verbs, ...featureTools];
  }

  private submitReplacements(args: { replacements: { role: string; agent: string; reason: string }[] }): string {
    const rt = this.rt;
    const candidates = freeCandidates(this.parked.map((t) => ({ roleId: this.graph.get(t)?.roleId ?? "" })), rt.config.agents, rt.config.channels);
    this.suggestions = validateReplacements(parseReplacements(args), candidates);
    for (const s of this.suggestions) rt.bus.emit({ kind: "cost.replaced", runId: rt.runId, roleId: s.role, agentId: s.agent, reason: s.reason });
    return `Replacements recorded: ${this.suggestions.map((s) => `${s.role}→${s.agent}`).join(", ") || "none valid"}`;
  }

  async stopParkedTasks(): Promise<void> {
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
