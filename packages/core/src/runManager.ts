import type { Clock, HostPort, IdGen } from "./ports.js";
import { EventBus } from "./events.js";
import type { AgentDef, RoleDef } from "./config/schema.js";
import type { Config } from "./config/loader.js";
import { roleRegistry } from "./roles.js";
import { DEFAULT_BUDGET_PROFILES, effectiveRunCapMs, resolveLimits, type BudgetProfile } from "./limits.js";
import { ManagedChannel } from "./channels/registry.js";
import type { ChatMessage, ToolCall } from "./channels/types.js";
import { DEFAULT_CAPS } from "./channels/types.js";
import { projectTools } from "./tools/builtins.js";
import { ProjectPaths } from "./tools/projectPaths.js";
import { Grants, type GrantDecision } from "./tools/approvals.js";
import { categoryOf, ToolRegistry } from "./tools/types.js";
import { RunCancelledError, ToolLoop, type ApprovalDecision, type ToolsMode } from "./tools/toolLoop.js";
import { RunLedger, CostLimit } from "./orchestration/ledger.js";
import { LeaseManager } from "./orchestration/leases.js";
import { IdempotencyLog } from "./orchestration/idempotency.js";
import { TaskGraph, type TaskRecord } from "./orchestration/tasks.js";
import { leasedTools, revertRunSnapshots } from "./orchestration/writeGuard.js";
import { runRoleTask } from "./orchestration/roleRunner.js";
import { resolveRole, runOrchestrated } from "./orchestration/orchestrator.js";
import type { OrchestrationRuntime } from "./orchestration/types.js";
import { ChatHistoryStore } from "./history.js";
import { loadProjectContext } from "./projectContext.js";

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
  sessionId?: string;
  externalRefs?: { tracker?: string; branch?: string; pr?: string };
}

export interface RunDeps {
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: EventBus;
}

/**
 * Owns runs for one project. Direct-mode runs stream through a ToolLoop
 * (tools + approvals); orchestrated runs plug in here at M7.
 */
export class RunManager {
  private runs = new Map<string, Run>();
  private approvals = new Map<string, (d: GrantDecision) => void>();
  private answers = new Map<string, (a: string) => void>();
  private sessionGrants = new Grants();
  private ledger?: RunLedger;
  private history?: ChatHistoryStore;
  /** Updated from settings on config (re)load. */
  historyRetentionDays = 30;

  constructor(private deps: RunDeps) {}

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  cancel(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || r.status !== "running") return false;
    r.controller.abort();
    r.status = "cancelled";
    return true;
  }

  approve(approvalId: string, decision: GrantDecision): boolean {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return false;
    this.approvals.delete(approvalId);
    resolve(decision);
    return true;
  }

  answer(questionId: string, answer: string): boolean {
    const resolve = this.answers.get(questionId);
    if (!resolve) return false;
    this.answers.delete(questionId);
    resolve(answer);
    return true;
  }

  /** Approval gate shared by direct and orchestrated runs. */
  private gate(runId: string, runGrants: Grants) {
    const bus = this.deps.bus;
    return async (call: ToolCall, preview: import("./tools/types.js").ToolPreview | null): Promise<ApprovalDecision> => {
      const cat = categoryOf(preview) ?? "OTHER";
      if (runGrants.isGranted(cat, preview) || this.sessionGrants.isGranted(cat, preview)) return { kind: "approved" };
      const approvalId = this.deps.ids.next("appr");
      return new Promise<ApprovalDecision>((resolve) => {
        this.approvals.set(approvalId, (d) => {
          if (d === "deny") resolve({ kind: "rejected", reason: "denied by user" });
          else {
            if (d === "chat") runGrants.record("chat", cat, preview);
            if (d === "always") this.sessionGrants.record("always", cat, preview);
            resolve({ kind: "approved" });
          }
        });
        bus.emit({ kind: "approval.request", runId, approvalId, tool: call.name, args: call.arguments, category: cat });
      });
    };
  }

  /** Ask the user (also used by the cost-limit card). */
  private askUser(runId: string, roleId?: string): (question: string, options?: string[]) => Promise<string> {
    const bus = this.deps.bus;
    return (question, options) => {
      const questionId = this.deps.ids.next("q");
      return new Promise<string>((resolve) => {
        this.answers.set(questionId, resolve);
        bus.emit({ kind: "ask_user", runId, questionId, question, options, roleId });
      });
    };
  }

  private async ledgerFor(): Promise<RunLedger> {
    if (!this.ledger) {
      const stateDir = await this.deps.host.workspace.stateDir();
      this.ledger = new RunLedger(this.deps.host, `${stateDir}/ledger.jsonl`, this.deps.clock);
      await this.ledger.load();
    }
    return this.ledger;
  }

  private async historyFor(): Promise<ChatHistoryStore> {
    if (!this.history) {
      const stateDir = await this.deps.host.workspace.stateDir();
      this.history = new ChatHistoryStore(this.deps.host, `${stateDir}/history`, this.historyRetentionDays);
    }
    return this.history;
  }

  /** Persist the transcript under its session id; best-effort, never fails a run. */
  async saveHistory(run: Run): Promise<void> {
    if (!run.sessionId) return;
    try {
      const store = await this.historyFor();
      await store.save(run.sessionId, run.messages);
      await store.prune();
    } catch (e) {
      this.deps.host.log(`history save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async historyStore(): Promise<ChatHistoryStore> {
    return this.historyFor();
  }

  /** Direct-mode run: stream one agent through the tool loop under a role's constraints. */
  async direct(
    projectId: string,
    channel: ManagedChannel,
    agent: AgentDef,
    text: string,
    images?: string[],
    role?: RoleDef,
    rolePrompt?: string,
    sessionId?: string,
    history?: ChatMessage[],
    budget?: { profile: BudgetProfile; name?: string; ceiling: number; maxRunHours: number },
  ): Promise<Run> {
    const run: Run = {
      id: this.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      messages: [...(history ?? []), { role: "user", content: text, images }],
      costUsd: 0,
      sessionId,
    };
    this.runs.set(run.id, run);
    const bus = this.deps.bus;
    bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80), ...(budget?.name ? { profile: budget.name } : {}) });
    void this.drive(run, channel, agent, role, rolePrompt, budget).catch((e) => {
      if (run.status === "running") run.status = "failed";
      bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  }

  /**
   * Orchestrated run: the Orchestrator routes work through `dispatch`; core
   * schedules tasks, meters cost in the ledger and parks work at the cap.
   */
  async orchestrated(
    projectId: string,
    opts: { config: Config; channelFor(channelId: string): ManagedChannel; text: string; runId?: string; sessionId?: string; profile?: BudgetProfile; profileName?: string },
  ): Promise<Run> {
    const run: Run = {
      id: opts.runId ?? this.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      messages: [{ role: "user", content: opts.text }],
      costUsd: 0,
      sessionId: opts.sessionId,
    };
    this.runs.set(run.id, run);
    this.deps.bus.emit({ kind: "run.started", runId: run.id, title: opts.text.slice(0, 80), ...(opts.profileName ? { profile: opts.profileName } : {}) });
    void this.driveOrchestrated(run, opts).catch((e) => {
      if (run.status === "running") run.status = "failed";
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  }

  private journalPath(runId: string, stateDir: string): string {
    return `${stateDir}/scratch/${runId}/run.json`;
  }

  private async journal(run: Run, stateDir: string): Promise<void> {
    try {
      const body = {
        id: run.id,
        projectId: run.projectId,
        text: run.messages.find((m) => m.role === "user")?.content ?? "",
        status: run.status,
        startedAt: run.startedAt,
        costUsd: run.costUsd,
        tasks: run.tasks,
        externalRefs: run.externalRefs,
      };
      await this.deps.host.files.writeAtomic(this.journalPath(run.id, stateDir), JSON.stringify(body));
    } catch {
      /* journal is best-effort; it must never fail a run */
    }
  }

  async revert(runId: string): Promise<{ ok: boolean; filesRestored: string[]; reason?: string }> {
    const live = this.runs.get(runId);
    if (live && live.status === "running") {
      return { ok: false, filesRestored: [], reason: "run is still running" };
    }
    const stateDir = await this.deps.host.workspace.stateDir();
    const filesRestored = await revertRunSnapshots(this.deps.host, stateDir, runId);
    if (filesRestored.length === 0) {
      return { ok: false, filesRestored: [], reason: "no snapshots for run" };
    }
    this.deps.bus.emit({ kind: "run.reverted", runId, filesRestored });
    return { ok: true, filesRestored };
  }

  /**
   * `/resume` reconstructs a persisted task graph, marks in-flight tasks
   * `failed: interrupted`, and re-dispatches them using their original task ids
   * and persisted `IdempotencyLog`. Fails closed when task-graph state is absent
   * or unreadable so a prompt is never replayed with fresh task ids.
   */
  async resume(
    projectId: string,
    runId: string,
    opts: { config: Config; channelFor(channelId: string): ManagedChannel; ask?(question: string, options?: string[]): Promise<string> },
  ): Promise<{ ok: boolean; reason?: string; run?: Run }> {
    const live = this.runs.get(runId);
    if (live && live.status !== "interrupted") return { ok: false, reason: `run is ${live.status}` };
    const stateDir = await this.deps.host.workspace.stateDir();
    const jPath = this.journalPath(runId, stateDir);
    const hasJournal = await this.deps.host.files.exists(jPath);
    if (!live && !hasJournal) {
      return { ok: false, reason: "run not found" };
    }
    let persisted: { id?: string; projectId?: string; text?: string; status?: string; startedAt?: number; costUsd?: number; tasks?: TaskRecord[] } | undefined;
    if (hasJournal) {
      try {
        persisted = JSON.parse((await this.deps.host.files.read(jPath)).content);
      } catch {
        return { ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" };
      }
    }
    const taskRecords = live?.tasks ?? persisted?.tasks;
    if (!Array.isArray(taskRecords) || taskRecords.length === 0) {
      return { ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" };
    }
    const graph = TaskGraph.fromJSON(taskRecords);
    const interrupted = graph.all().filter((t) => t.status !== "done");
    for (const t of interrupted) {
      t.status = "failed";
      t.error = "interrupted";
      this.deps.bus.emit({ kind: "task.failed", runId, taskId: t.id, roleId: t.roleId, error: "failed: interrupted" });
    }
    if (opts.ask && interrupted.length > 0) {
      const ans = await opts.ask(`Resume ${interrupted.length} interrupted task(s)?`, ["Resume", "Cancel"]);
      if (!ans.startsWith("Resume")) {
        return { ok: false, reason: "resume declined by user" };
      }
    }
    const ledger = await this.ledgerFor();
    const idem = new IdempotencyLog(this.deps.host, `${stateDir}/scratch/${runId}/executed.jsonl`, runId);
    await idem.load();
    const text = live?.messages.find((m) => m.role === "user")?.content ?? persisted?.text ?? "";
    const run: Run = {
      id: runId,
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: live?.startedAt ?? persisted?.startedAt ?? this.deps.clock.now(),
      messages: [{ role: "user", content: text }],
      costUsd: ledger.cost(runId).costUsd,
      tasks: graph.toJSON(),
    };
    this.runs.set(run.id, run);
    this.deps.bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80) });
    void (async () => {
      try {
        const s = opts.config.settings;
        const cost = new CostLimit(s.costLimit.perRunUsd, s.costLimit.onLimit, ledger.cost(run.id).costUsd);
        const grants = new Grants();
        const rt: OrchestrationRuntime = {
          runId: run.id,
          projectId: run.projectId,
          host: this.deps.host,
          clock: this.deps.clock,
          ids: this.deps.ids,
          bus: this.deps.bus,
          config: opts.config,
          stateDir,
          channelFor: opts.channelFor,
          ledger,
          leases: new LeaseManager(),
          idem,
          cost,
          signal: run.controller.signal,
          startedAt: run.startedAt,
          leaseWaitMs: s.leaseWaitSeconds * 1000,
          skillBudgetTokens: s.skillBudgetTokens,
          maxNestedDispatches: s.maxNestedDispatches,
          maxReplans: s.maxReplans,
          maxRunHours: s.maxRunHours,
          maxWorkerTurnsCeiling: s.maxWorkerTurnsCeiling,
          budgetProfile: DEFAULT_BUDGET_PROFILES.normal,
          planGate: s.planGate,
          ask: opts.ask ?? this.askUser(run.id, "orchestrator"),
          approve: (call, preview) => this.gate(run.id, grants)(call, preview),
        };
        for (const t of interrupted) {
          const role = resolveRole(rt, t.roleId);
          if (!role) {
            t.status = "failed";
            t.summary = `no enabled role for '${t.roleId}'`;
            continue;
          }
          t.status = "running";
          run.tasks = graph.toJSON();
          await this.journal(run, stateDir);
          this.deps.bus.emit({ kind: "task.started", runId: run.id, taskId: t.id, roleId: role.id });
          const res = await runRoleTask(rt, t, { role });
          rt.leases.release(t.id);
          t.filesTouched = res.filesTouched;
          t.status = res.status === "done" ? "done" : "failed";
          t.summary = res.summary;
          run.tasks = graph.toJSON();
          await this.journal(run, stateDir);
          this.deps.bus.emit(
            res.status === "done"
              ? { kind: "task.done", runId: run.id, taskId: t.id, roleId: role.id, summary: res.summary.slice(0, 400) }
              : { kind: "task.failed", runId: run.id, taskId: t.id, roleId: role.id, error: res.summary.slice(0, 400) },
          );
        }
        run.costUsd = cost.accrued;
        const anyFailed = graph.all().some((t) => t.status !== "done");
        run.status = anyFailed ? "failed" : "done";
        run.tasks = graph.toJSON();
        await this.journal(run, stateDir);
        this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: run.status });
      } catch (e) {
        run.status = "failed";
        await this.journal(run, stateDir);
        this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return { ok: true, run };
  }

  private async driveOrchestrated(
    run: Run,
    opts: { config: Config; channelFor(channelId: string): ManagedChannel; text: string; profile?: BudgetProfile },
  ): Promise<void> {
    const ledger = await this.ledgerFor();
    const stateDir = await this.deps.host.workspace.stateDir();
    await this.journal(run, stateDir);
    const idem = new IdempotencyLog(this.deps.host, `${stateDir}/scratch/${run.id}/executed.jsonl`, run.id);
    await idem.load();
    const s = opts.config.settings;
    const cost = new CostLimit(s.costLimit.perRunUsd, s.costLimit.onLimit, ledger.cost(run.id).costUsd);
    const grants = new Grants();
    const rt: OrchestrationRuntime = {
      runId: run.id,
      projectId: run.projectId,
      host: this.deps.host,
      clock: this.deps.clock,
      ids: this.deps.ids,
      bus: this.deps.bus,
      config: opts.config,
      stateDir,
      channelFor: opts.channelFor,
      ledger,
      leases: new LeaseManager(),
      idem,
      cost,
      signal: run.controller.signal,
      startedAt: run.startedAt,
      leaseWaitMs: s.leaseWaitSeconds * 1000,
      skillBudgetTokens: s.skillBudgetTokens,
      maxNestedDispatches: s.maxNestedDispatches,
      maxReplans: s.maxReplans,
      maxRunHours: s.maxRunHours,
      maxWorkerTurnsCeiling: s.maxWorkerTurnsCeiling,
      budgetProfile: opts.profile ?? DEFAULT_BUDGET_PROFILES.normal,
      planGate: s.planGate,
      onGraphChange: async (g) => {
        run.tasks = g.toJSON();
        await this.journal(run, stateDir);
      },
      ask: this.askUser(run.id, "orchestrator"),
      approve: (call, preview) => this.gate(run.id, grants)(call, preview),
    };
    const outcome = await runOrchestrated(rt, opts.text);
    run.costUsd = cost.accrued;
    if (run.status === "cancelled") {
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "cancelled" });
      return;
    }
    if (outcome.status === "failed") {
      run.status = "failed";
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: outcome.error });
      return;
    }
    const finalStatus: RunStatus = outcome.status === "stopped" || outcome.status === "no_dispatch" ? outcome.status : "done";
    run.status = finalStatus;
    await this.journal(run, stateDir);
    await this.saveHistory(run);
    this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: finalStatus, error: outcome.error });
  }

  private async drive(
    run: Run,
    channel: ManagedChannel,
    agent: AgentDef,
    role?: RoleDef,
    rolePrompt?: string,
    budget?: { profile: BudgetProfile; ceiling: number; maxRunHours: number },
  ): Promise<void> {
    const bus = this.deps.bus;
    const stateDir = await this.deps.host.workspace.stateDir();
    const paths = await ProjectPaths.forProject(this.deps.host);
    const baseRegistry = role ? roleRegistry(projectTools(this.deps.host, paths), role) : projectTools(this.deps.host, paths);
    const leases = new LeaseManager();
    const registry = new ToolRegistry(
      leasedTools(baseRegistry.tools, {
        host: this.deps.host,
        leases,
        taskId: "direct",
        runId: run.id,
        leaseWaitMs: 300_000,
        stateDir,
      }),
    );
    const runGrants = new Grants();
    const runId = run.id;
    const gate = this.gate(runId, runGrants);
    const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
    const profile = budget?.profile ?? DEFAULT_BUDGET_PROFILES.normal;
    const limits = resolveLimits({
      role,
      agent,
      profile,
      ceiling: budget?.ceiling ?? 60,
      perf: channel.cfg.modelCaps?.[agent.model]?.perf,
      channelType: channel.cfg.type,
    });
    const capMs = effectiveRunCapMs(budget?.maxRunHours ?? 0, profile);
    let timeCapped = false;
    const capTimer =
      capMs > 0
        ? this.deps.clock.setTimeout(() => {
            if (run.status === "running") {
              timeCapped = true;
              run.controller.abort();
            }
          }, capMs)
        : undefined;
    const projectContext = await loadProjectContext(this.deps.host);
    const prompt = [rolePrompt, projectContext].filter(Boolean).join("") || undefined;
    const loop = new ToolLoop(channel, registry, gate, limits, this.deps.clock, prompt, new Set(), mode);
    const listener = {
      onText: (t: string) => bus.emit({ kind: "text_delta", runId, seq: 0, text: t }),
      onReasoning: (t: string) => bus.emit({ kind: "reasoning_delta", runId, seq: 0, text: t }),
      onCompacted: (before: number, after: number) =>
        bus.emit({ kind: "compaction", runId, droppedTokens: Math.max(0, before - after) }),
      onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) =>
        bus.emit({ kind: "tool.request", runId, callId: call.id, tool: call.name, args: call.arguments, category: call.name }),
      onToolOutcome: (call: { id: string }, outcome: { kind: string }) =>
        bus.emit({ kind: "tool.outcome", runId, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind }),
    };
    try {
      const result = await loop.run(agent.model, run.messages, listener, run.controller.signal);
      leases.releaseAll();
      run.messages = [...result.base, ...result.messages];
      if (result.kind === "failed") {
        run.status = "failed";
        await this.saveHistory(run);
        bus.emit({ kind: "run.finished", runId, status: "failed", error: result.message });
        return;
      }
      if (result.kind === "turn_limit") {
        run.status = "interrupted";
        await this.saveHistory(run);
        bus.emit({ kind: "run.finished", runId, status: "stopped", error: "turn limit reached" });
        return;
      }
      if (run.status === "running") run.status = "done";
      await this.saveHistory(run);
      bus.emit({ kind: "run.finished", runId, status: run.status === "cancelled" ? "cancelled" : "done" });
    } catch (e) {
      leases.releaseAll();
      if (e instanceof RunCancelledError || run.controller.signal.aborted) {
        run.status = timeCapped ? "interrupted" : "cancelled";
        if (e instanceof RunCancelledError) run.messages = e.transcript;
        await this.saveHistory(run);
        bus.emit({
          kind: "run.finished",
          runId,
          status: timeCapped ? "stopped" : "cancelled",
          error: timeCapped ? `run time limit reached (${Math.round(capMs / 60_000)}min)` : undefined,
        });
        return;
      }
      await this.saveHistory(run);
      throw e;
    } finally {
      capTimer?.cancel();
    }
  }
}
