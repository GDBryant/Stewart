import type { Clock, HostPort, IdGen } from "@stewart/kernel";
import type { AgentDef, RoleDef } from "@stewart/config";
import type { Config } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage, ToolCall } from "@stewart/kernel";
import { Grants, type GrantDecision, categoryOf, type ToolPreview } from "@stewart/permissions";
import type { ApprovalDecision, RecoveryState } from "@stewart/agent-loop";
import { RunLedger } from "@stewart/ledger";
import type { TaskRecord } from "@stewart/scheduling";
import { revertRunSnapshots, ChatHistoryStore } from "@stewart/run-state";
import { runRoleTask } from "@stewart/orchestration";
import { createRecovery } from "@stewart/recovery";
import type { RunEvent } from "@stewart/protocol";
import { directStrategy } from "./direct.js";
import { orchestratedStrategy, type OrchestratedRequest } from "./orchestrated.js";
import { resumeStrategy, type ResumeRequest, type ResumeResult } from "./resume.js";

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
  /** Direct-run agent id, journaled so `/resume` can rebind it. */
  agentId?: string;
  sessionId?: string;
  externalRefs?: { tracker?: string; branch?: string; pr?: string };
}

export interface RunDeps {
  host: HostPort;
  clock: Clock;
  ids: IdGen;
  bus: { emit(ev: RunEvent): void };
}

/** Owns runs for one project; direct, orchestrated and resume are RunStrategy objects on one shared pipeline. */
export class RunService {
  private runs = new Map<string, Run>();
  private approvals = new Map<string, (d: GrantDecision) => void>();
  private answers = new Map<string, (a: string) => void>();
  private sessionGrants = new Grants();
  private ledger?: RunLedger;
  private history?: ChatHistoryStore;
  /** Updated from settings on config (re)load. */
  historyRetentionDays = 30;

  readonly recoveryService = createRecovery(runRoleTask);

  constructor(readonly deps: RunDeps) {}

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /** Register a freshly created run; called by strategies only. */
  register(run: Run): void {
    this.runs.set(run.id, run);
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
  gate(runId: string, runGrants: Grants) {
    const bus = this.deps.bus;
    return async (call: ToolCall, preview: ToolPreview | null): Promise<ApprovalDecision> => {
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
  askUser(runId: string, roleId?: string): (question: string, options?: string[]) => Promise<string> {
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
  askTimed(runId: string, signal: AbortSignal, roleId?: string): (question: string, options: string[] | undefined, timeoutMs: number) => Promise<string | undefined> {
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

  async ledgerFor(): Promise<RunLedger> {
    if (!this.ledger) {
      const stateDir = await this.deps.host.workspace.stateDir();
      this.ledger = new RunLedger(this.deps.host, `${stateDir}/ledger.jsonl`, this.deps.clock);
      await this.ledger.load();
    }
    return this.ledger;
  }

  async historyFor(): Promise<ChatHistoryStore> {
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
  direct(
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
    return directStrategy.start(this, projectId, { channel, agent, text, images, role, rolePrompt, sessionId, history, budget });
  }

  /**
   * Orchestrated run: the Orchestrator routes work through `dispatch`; core
   * schedules tasks, meters cost in the ledger and parks work at the cap.
   */
  orchestrated(projectId: string, opts: OrchestratedRequest): Promise<Run> {
    return orchestratedStrategy.start(this, projectId, opts);
  }

  journalPath(runId: string, stateDir: string): string {
    return `${stateDir}/scratch/${runId}/run.json`;
  }

  async journal(run: Run, stateDir: string): Promise<void> {
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
  resume(projectId: string, runId: string, opts: ResumeRequest): Promise<ResumeResult> {
    return resumeStrategy.start(this, projectId, runId, opts);
  }
}
