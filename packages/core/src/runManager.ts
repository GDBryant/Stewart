import type { Clock, HostPort, IdGen } from "./ports.js";
import { EventBus } from "./events.js";
import type { AgentDef, RoleDef } from "./config/schema.js";
import type { Config } from "./config/loader.js";
import { roleRegistry, roleTurnBudget } from "./roles.js";
import { ManagedChannel } from "./channels/registry.js";
import type { ChatMessage, ToolCall } from "./channels/types.js";
import { DEFAULT_CAPS } from "./channels/types.js";
import { projectTools } from "./tools/builtins.js";
import { ProjectPaths } from "./tools/projectPaths.js";
import { Grants, type GrantDecision } from "./tools/approvals.js";
import { categoryOf } from "./tools/types.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type ApprovalDecision, type ToolsMode } from "./tools/toolLoop.js";
import { RunLedger, CostLimit } from "./orchestration/ledger.js";
import { LeaseManager } from "./orchestration/leases.js";
import { IdempotencyLog } from "./orchestration/idempotency.js";
import { runOrchestrated } from "./orchestration/orchestrator.js";
import type { OrchestrationRuntime } from "./orchestration/types.js";

export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  controller: AbortController;
  startedAt: number;
  messages: ChatMessage[];
  costUsd: number;
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

  /** Direct-mode run: stream one agent through the tool loop under a role's constraints. */
  async direct(projectId: string, channel: ManagedChannel, agent: AgentDef, text: string, images?: string[], role?: RoleDef, rolePrompt?: string): Promise<Run> {
    const run: Run = {
      id: this.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      messages: [{ role: "user", content: text, images }],
      costUsd: 0,
    };
    this.runs.set(run.id, run);
    const bus = this.deps.bus;
    bus.emit({ kind: "run.started", runId: run.id, title: text.slice(0, 80) });
    void this.drive(run, channel, agent, role, rolePrompt).catch((e) => {
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
    opts: { config: Config; channelFor(channelId: string): ManagedChannel; text: string; runId?: string },
  ): Promise<Run> {
    const run: Run = {
      id: opts.runId ?? this.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      messages: [{ role: "user", content: opts.text }],
      costUsd: 0,
    };
    this.runs.set(run.id, run);
    this.deps.bus.emit({ kind: "run.started", runId: run.id, title: opts.text.slice(0, 80) });
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
      const body = { id: run.id, projectId: run.projectId, text: run.messages.find((m) => m.role === "user")?.content ?? "", status: run.status, startedAt: run.startedAt, costUsd: run.costUsd };
      await this.deps.host.files.writeAtomic(this.journalPath(run.id, stateDir), JSON.stringify(body));
    } catch {
      /* journal is best-effort; it must never fail a run */
    }
  }

  /** `/resume` after a restart: reuse the run id so the idempotency log skips landed writes. */
  async resume(
    projectId: string,
    runId: string,
    opts: { config: Config; channelFor(channelId: string): ManagedChannel },
  ): Promise<{ ok: boolean; reason?: string; run?: Run }> {
    const live = this.runs.get(runId);
    if (live && live.status !== "interrupted") return { ok: false, reason: `run is ${live.status}` };
    const stateDir = await this.deps.host.workspace.stateDir();
    let text = live?.messages.find((m) => m.role === "user")?.content ?? "";
    if (!live) {
      const path = this.journalPath(runId, stateDir);
      if (!(await this.deps.host.files.exists(path))) return { ok: false, reason: "run not found" };
      let saved: { text?: string; status?: string; projectId?: string };
      try {
        saved = JSON.parse((await this.deps.host.files.read(path)).content) as typeof saved;
      } catch {
        return { ok: false, reason: "run journal is unreadable" };
      }
      if (saved.status && saved.status !== "running" && saved.status !== "interrupted") return { ok: false, reason: `run is ${saved.status}` };
      text = saved.text ?? "";
    }
    if (!text) return { ok: false, reason: "no prompt to resume" };
    const run = await this.orchestrated(projectId, { ...opts, text, runId });
    return { ok: true, run };
  }

  private async driveOrchestrated(
    run: Run,
    opts: { config: Config; channelFor(channelId: string): ManagedChannel; text: string },
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
      planGate: s.planGate,
      ask: this.askUser(run.id, "orchestrator"),
      approve: (call, preview) => this.gate(run.id, grants)(call, preview),
    };
    const outcome = await runOrchestrated(rt, opts.text);
    run.costUsd = cost.accrued;
    if (run.status === "cancelled") {
      await this.journal(run, stateDir);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "cancelled" });
      return;
    }
    if (outcome.status === "failed") {
      run.status = "failed";
      await this.journal(run, stateDir);
      this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: outcome.error });
      return;
    }
    run.status = "done";
    await this.journal(run, stateDir);
    this.deps.bus.emit({ kind: "run.finished", runId: run.id, status: outcome.status === "stopped" ? "stopped" : "done", error: outcome.error });
  }

  private async drive(run: Run, channel: ManagedChannel, agent: AgentDef, role?: RoleDef, rolePrompt?: string): Promise<void> {
    const bus = this.deps.bus;
    const paths = await ProjectPaths.forProject(this.deps.host);
    const registry = role ? roleRegistry(projectTools(this.deps.host, paths), role) : projectTools(this.deps.host, paths);
    const runGrants = new Grants();
    const runId = run.id;
    const gate = this.gate(runId, runGrants);
    const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
    const limits = role ? { ...DEFAULT_LIMITS, maxModelTurns: roleTurnBudget(role) } : DEFAULT_LIMITS;
    const loop = new ToolLoop(channel, registry, gate, limits, this.deps.clock, rolePrompt, new Set(), mode);
    const listener = {
      onText: (t: string) => bus.emit({ kind: "text_delta", runId, seq: 0, text: t }),
      onReasoning: (t: string) => bus.emit({ kind: "reasoning_delta", runId, seq: 0, text: t }),
      onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) =>
        bus.emit({ kind: "tool.request", runId, callId: call.id, tool: call.name, args: call.arguments, category: call.name }),
      onToolOutcome: (call: { id: string }, outcome: { kind: string }) =>
        bus.emit({ kind: "tool.outcome", runId, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind }),
    };
    try {
      const result = await loop.run(agent.model, run.messages, listener, run.controller.signal);
      run.messages = [...result.base, ...result.messages];
      if (result.kind === "failed") {
        run.status = "failed";
        bus.emit({ kind: "run.finished", runId, status: "failed", error: result.message });
        return;
      }
      if (result.kind === "turn_limit") {
        run.status = "interrupted";
        bus.emit({ kind: "run.finished", runId, status: "stopped", error: "turn limit reached" });
        return;
      }
      if (run.status === "running") run.status = "done";
      bus.emit({ kind: "run.finished", runId, status: run.status === "cancelled" ? "cancelled" : "done" });
    } catch (e) {
      if (e instanceof RunCancelledError || run.controller.signal.aborted) {
        run.status = "cancelled";
        if (e instanceof RunCancelledError) run.messages = e.transcript;
        bus.emit({ kind: "run.finished", runId, status: "cancelled" });
        return;
      }
      throw e;
    }
  }
}
