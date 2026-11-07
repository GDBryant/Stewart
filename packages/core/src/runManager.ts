import type { Clock, HostPort, IdGen } from "@stewart/kernel";
import { EventBus } from "./events.js";
import type { AgentDef, RoleDef } from "./config/schema.js";
import type { Config } from "./config/loader.js";
import { roleRegistry } from "./roles.js";
import { DEFAULT_BUDGET_PROFILES, effectiveRunCapMs, type BudgetProfile, DEFAULT_LIMITS } from "@stewart/budget";
import { runRoleTask } from "./orchestration/roleRunner.js";
import { ManagedChannel } from "./channels/registry.js";
import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { projectTools } from "./tools/builtins.js";
import { ProjectPaths } from "./tools/projectPaths.js";
import { Grants, type GrantDecision } from "@stewart/permissions";
import { categoryOf } from "@stewart/permissions";
import { ToolRegistry } from "./tools/types.js";
import { RunCancelledError, type ApprovalDecision } from "./tools/toolLoop.js";
import { RunLedger, CostLimit } from "@stewart/ledger";
import { LeaseManager, TaskGraph, type TaskRecord, type TaskSpec } from "@stewart/scheduling";
import { IdempotencyLog } from "./orchestration/idempotency.js";
import { leasedTools, revertRunSnapshots } from "./orchestration/writeGuard.js";
import { resolveRole, runOrchestrated } from "./orchestration/orchestrator.js";
import { continueQuestion, mapContinueAnswer, recoveryBrain, recoveryState, runTaskRecoverable, type RecoveryState } from "./orchestration/recovery.js";
import type { RunRuntime } from "./orchestration/types.js";
import { ChatHistoryStore } from "./history.js";
import { loadProjectContext } from "@stewart/context";

const DIRECT_TASK_ID = "direct";
const chatRoleDef = (): RoleDef => ({ id: "chat", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: DEFAULT_LIMITS.maxModelTurns });
const timeCapMessage = (ms: number): string => `run time limit reached (${Math.round(ms / 60_000)}min)`;

export type RunStatus ="running" | "done" | "failed" | "cancelled" | "interrupted" | "stopped" | "no_dispatch";

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
    return async (call: ToolCall, preview: import("@stewart/permissions").ToolPreview | null): Promise<ApprovalDecision> => {
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

  /** askUser with a timeout and run-cancel escape; resolves undefined and withdraws the card. */
  private askTimed(runId: string, signal: AbortSignal, roleId?: string): (question: string, options: string[] | undefined, timeoutMs: number) => Promise<string | undefined> {
    const bus = this.deps.bus;
    return (question, options, timeoutMs) => {
      if (signal.aborted) return Promise.resolve(undefined);
      const questionId = this.deps.ids.next("q");
      return new Promise<string | undefined>((resolve) => {
        let settled = false;
        const settle = (v: string | undefined) => {
          if (settled) return;
          settled = true;
          this.answers.delete(questionId);
          timer?.cancel();
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const withdraw = () => {
          if (settled) return;
          bus.emit({ kind: "question.withdrawn", runId, questionId, roleId });
          settle(undefined);
        };
        const onAbort = () => withdraw();
        const timer = timeoutMs > 0 ? this.deps.clock.setTimeout(withdraw, timeoutMs) : undefined;
        this.answers.set(questionId, (a) => settle(a));
        signal.addEventListener("abort", onAbort, { once: true });
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
    images: string[] | undefined,
    role: RoleDef | undefined,
    rolePrompt: string | undefined,
    sessionId: string | undefined,
    history: ChatMessage[] | undefined,
    budget: { config: Config; profile: BudgetProfile; name?: string; recovery?: RecoveryState },
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
      agentId: agent.id,
    };
    this.runs.set(run.id, run);
    const bus = this.deps.bus;
    bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80), ...(budget.name ? { profile: budget.name } : {}) });
    void this.driveDirect(run, channel, agent, role, rolePrompt, budget).catch((e) => {
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
        agentId: run.agentId,
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
    let persisted: { id?: string; projectId?: string; text?: string; status?: string; startedAt?: number; costUsd?: number; tasks?: TaskRecord[]; agentId?: string } | undefined;
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
      agentId: live?.agentId ?? persisted?.agentId,
    };
    this.runs.set(run.id, run);
    this.deps.bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80) });
    void (async () => {
      let timeCap: RunRuntime["timeCap"];
      try {
        const rt = this.buildRuntime(run, {
          config: opts.config,
          channelFor: opts.channelFor,
          ledger,
          stateDir,
          idem,
          ask: opts.ask ?? this.askUser(run.id, "orchestrator"),
        });
        timeCap = rt.timeCap;
        const cost = rt.cost;
        for (const t of interrupted) {
          if (timeCap?.hit) break;
          const isDirect = t.id === DIRECT_TASK_ID;
          const role = resolveRole(rt, t.roleId) ?? (isDirect ? chatRoleDef() : undefined);
          if (!role) {
            t.status = "failed";
            t.summary = `no enabled role for '${t.roleId}'`;
            continue;
          }
          t.status = "running";
          run.tasks = graph.toJSON();
          await this.journal(run, stateDir);
          this.deps.bus.emit({ kind: "task.started", runId: run.id, taskId: t.id, roleId: role.id });
          // Direct run: lean replay (original request only; executed tool calls are skipped via the idempotency log).
          const res = isDirect
            ? await runRoleTask(
                rt,
                { ...t, task: `${text}\n\n(Resumed after interruption: continue; already-executed tool calls are skipped.)` },
                {
                  role,
                  agent: run.agentId ? opts.config.agents.find((a) => a.id === run.agentId) : undefined,
                  prompt: [await loadProjectContext(this.deps.host)].filter(Boolean).join("") || undefined,
                },
              )
            : await runTaskRecoverable(rt, t, { role }, { depth: 0, brain: recoveryBrain(rt) });
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
        if (timeCap?.hit) {
          run.status = "interrupted";
          run.tasks = graph.toJSON();
          await this.journal(run, stateDir);
          this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "stopped", error: timeCapMessage(timeCap.ms) });
          return;
        }
        const anyFailed = graph.all().some((t) => t.status !== "done");
        run.status = anyFailed ? "failed" : "done";
        run.tasks = graph.toJSON();
        await this.journal(run, stateDir);
        this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: run.status });
      } catch (e) {
        run.status = "failed";
        await this.journal(run, stateDir);
        this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
      } finally {
        timeCap?.cancel();
      }
    })();
    return { ok: true, run };
  }

  /** Single construction point for the per-run orchestration runtime (resume and fresh runs). */
  private buildRuntime(
    run: Run,
    opts: {
      config: Config;
      channelFor(channelId: string): ManagedChannel;
      ledger: RunLedger;
      stateDir: string;
      idem: IdempotencyLog;
      profile?: BudgetProfile;
      ask?: (question: string, options?: string[]) => Promise<string>;
      onGraphChange?: RunRuntime["onGraphChange"];
    },
  ): RunRuntime {
    const s = opts.config.settings;
    const cost = new CostLimit(s.costLimit.perRunUsd, s.costLimit.onLimit, opts.ledger.cost(run.id).costUsd);
    const grants = new Grants();
    const profile = opts.profile ?? DEFAULT_BUDGET_PROFILES.normal;
    const ms = effectiveRunCapMs(s.maxRunHours, profile);
    const timeCap: NonNullable<RunRuntime["timeCap"]> = { ms, hit: false, cancel: () => {} };
    if (ms > 0) {
      const timer = this.deps.clock.setTimeout(
        () => {
          if (run.status === "running") {
            timeCap.hit = true;
            run.controller.abort();
          }
        },
        Math.max(0, ms - (this.deps.clock.now() - run.startedAt)),
      );
      timeCap.cancel = () => timer.cancel();
    }
    return {
      runId: run.id,
      projectId: run.projectId,
      host: this.deps.host,
      clock: this.deps.clock,
      ids: this.deps.ids,
      bus: this.deps.bus,
      config: opts.config,
      stateDir: opts.stateDir,
      channelFor: opts.channelFor,
      ledger: opts.ledger,
      leases: new LeaseManager(),
      idem: opts.idem,
      cost,
      signal: run.controller.signal,
      startedAt: run.startedAt,
      leaseWaitMs: s.leaseWaitSeconds * 1000,
      skillBudgetTokens: s.skillBudgetTokens,
      maxNestedDispatches: s.maxNestedDispatches,
      maxReplans: s.maxReplans,
      maxRunHours: s.maxRunHours,
      maxWorkerTurnsCeiling: s.maxWorkerTurnsCeiling,
      budgetProfile: profile,
      planGate: s.planGate,
      onGraphChange: opts.onGraphChange,
      recovery: recoveryState(s),
      ask: opts.ask ?? this.askUser(run.id, "orchestrator"),
      askTimed: this.askTimed(run.id, run.controller.signal, "orchestrator"),
      approve: (call, preview) => this.gate(run.id, grants)(call, preview),
      timeCap,
    };
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
    const rt = this.buildRuntime(run, {
      config: opts.config,
      channelFor: opts.channelFor,
      ledger,
      stateDir,
      idem,
      profile: opts.profile,
      onGraphChange: async (g) => {
        run.tasks = g.toJSON();
        await this.journal(run, stateDir);
      },
      ask: this.askUser(run.id, "orchestrator"),
    });
    const cost = rt.cost;
    let outcome: Awaited<ReturnType<typeof runOrchestrated>>;
    try {
      outcome = await runOrchestrated(rt, opts.text);
    } finally {
      rt.timeCap?.cancel();
    }
    run.costUsd = cost.accrued;
    if (run.status === "cancelled") {
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "cancelled" });
      return;
    }
    if (rt.timeCap?.hit) {
      run.status = "interrupted";
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "stopped", error: timeCapMessage(rt.timeCap.ms) });
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

  /** Direct run = a single-task run of the chat role through `runRoleTask` (same runtime as orchestrated runs). */
  private async driveDirect(
    run: Run,
    channel: ManagedChannel,
    agent: AgentDef,
    role: RoleDef | undefined,
    rolePrompt: string | undefined,
    budget: { config: Config; profile: BudgetProfile; recovery?: RecoveryState },
  ): Promise<void> {
    const bus = this.deps.bus;
    const runId = run.id;
    const ledger = await this.ledgerFor();
    const stateDir = await this.deps.host.workspace.stateDir();
    const idem = new IdempotencyLog(this.deps.host, `${stateDir}/scratch/${runId}/executed.jsonl`, runId);
    await idem.load();
    const rt = this.buildRuntime(run, { config: budget.config, channelFor: () => channel, ledger, stateDir, idem, profile: budget.profile });
    const chatRole: RoleDef = role ?? chatRoleDef();
    const prompt = [rolePrompt, await loadProjectContext(this.deps.host)].filter(Boolean).join("");
    const desc = (run.messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
    const spec: TaskSpec = { id: DIRECT_TASK_ID, roleId: chatRole.id, title: desc, task: desc, files: [], dependsOn: [] };
    const recovery = budget.recovery;
    const askTimed = this.askTimed(runId, run.controller.signal);
    const rec: TaskRecord = { ...spec, status: "running", filesTouched: [] };
    run.tasks = [rec];
    await this.journal(run, stateDir);
    const finish = async (status: RunStatus, event: "done" | "failed" | "cancelled" | "stopped", error?: string) => {
      run.status = status;
      run.costUsd = rt.cost.accrued;
      rec.status = status === "done" ? "done" : "failed";
      if (error) rec.error = error;
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      if (rt.cost.accrued > 0) {
        const c = ledger.cost(runId);
        bus.emit({ kind: "cost.summary", runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued, overshootUsd: rt.cost.overshoot(), byRole: c.byRole, byAgent: c.byAgent, parked: [], freeFinished: [], suggestions: [] });
      }
      bus.emit({ kind: "run.finished", runId, status: event, ...(error ? { error } : {}) });
    };
    try {
      let history = run.messages;
      let offset = 0;
      let continuations = 0;
      let questions = 0;
      let res = await runRoleTask(rt, spec, { role: chatRole, agent, prompt: prompt || undefined, history });
      while (res.status === "stopped" && res.fault === "turn_limit" && res.transcript && recovery?.askOnTurnLimit && continuations < recovery.maxContinuations && questions < recovery.maxContinueQuestionsPerRun) {
        questions++;
        const transcript = res.transcript;
        const { question, options } = continueQuestion({
          spec: { ...spec, roleId: role?.id ?? "chat" },
          turns: res.turnBudget ?? 0,
          transcript,
          maxActions: recovery.maxActionsInRecoveryBrief,
          canSplit: false,
        });
        const raw = await askTimed(question, options, recovery.continueQuestionTimeoutMs);
        const answer = raw === undefined ? ({ kind: "timeout" } as const) : mapContinueAnswer(raw);
        this.deps.host.log(`[run ${runId}] continue question: ${answer.kind === "text" ? "guidance" : answer.kind}`);
        if (answer.kind === "stop" || answer.kind === "timeout") break;
        continuations++;
        offset = transcript.length;
        history = answer.kind === "text" ? [...transcript, { role: "user", content: answer.text }] : transcript;
        res = await runRoleTask(rt, spec, { role: chatRole, agent, prompt: prompt || undefined, history, idemOffset: offset });
      }
      rt.leases.releaseAll();
      if (res.transcript) run.messages = res.transcript;
      if (res.status === "cancelled" || run.status === "cancelled") {
        if (rt.timeCap?.hit) return await finish("interrupted", "stopped", timeCapMessage(rt.timeCap.ms));
        return await finish("cancelled", "cancelled");
      }
      if (res.status === "failed") return await finish("failed", "failed", res.summary);
      if (res.status === "stopped" || res.status === "parked") return await finish("interrupted", "stopped", res.summary);
      await finish("done", "done");
    } catch (e) {
      rt.leases.releaseAll();
      rec.status = "failed";
      await this.journal(run, stateDir);
      await this.saveHistory(run);
      throw e;
    } finally {
      rt.timeCap?.cancel();
    }
  }
}
