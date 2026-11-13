import type { ChatMessage, Clock, HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Interaction } from "@stewart/interaction";
import type { Permissions } from "@stewart/permissions";
import type { AgentDef } from "@stewart/config";
import { agentContext, eligibleChain, type EffectiveConfig } from "@stewart/roles-skills";
import { ChatHistoryStore } from "./history.js";
import { RunLedger } from "@stewart/ledger";
import { ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { engineFor as defaultEngineFor, type Engine } from "@stewart/engines";
import { changeTracker, type ChangeTracker } from "@stewart/tasks";
import { leadRole, systemPrompt } from "./lead.js";
import { askUserTool, loadSkillTool, setCheckTool, type Declared } from "./sessionTools.js";
import { ChildRunner } from "./child.js";
import { PlanRunner } from "./plan.js";
import { compactTranscript, expandArchived } from "./compact.js";
import { planSummary, revertSession } from "./planOps.js";
import { drivePlan, leadContract } from "./planDrive.js";
import { err, newRunState, lastUserText, runOutcome, closeOpenCalls, type RunState } from "./turnState.js";
import { stepSaver } from "./stepSave.js";
import { runTask, type Contract, type TaskDeps, type TaskResult } from "./taskRun.js";
import { policyApprove } from "./policyApprove.js";
import { dropSessionArtifacts, loadEngineState, persistTurn } from "./persist.js";

export interface SessionDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  ids: IdGen;
  clock: Clock;
  interaction: Interaction;
  permissions: Permissions;
  channelFor: (id: string) => ManagedChannel;
  config: () => EffectiveConfig;
  engineFor?: (channelType: string) => Engine;
}

export interface SendRequest {
  sessionId?: string;
  text: string;
  images?: string[];
}

/** One in-flight turn: what runTurn assembles once and finish/persist share. */
interface TurnWork {
  runId: string;
  sessionId: string;
  transcript: ChatMessage[];
  state: Record<string, unknown>;
  rs: RunState;
  /** The lead's set_check declarations for this turn (part of the verify contract). */
  declared: Declared;
  paths: ProjectPaths;
  stateDir: string;
  store: ChatHistoryStore;
  plan: PlanRunner;
  tracker: ChangeTracker;
  /** Coalesced mid-turn persist (user message, tool batches, model turns). */
  stepSave: () => void;
}

/** One session service per project: a chat's full transcript, the lead's turn, and the after-turn check. */
export class SessionService {
  private ledger?: RunLedger;
  private history?: ChatHistoryStore;
  private readonly active = new Map<string, RunState>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionDeps) {}

  /** Starts a lead turn in the background; resolves once the run is registered. Turns on one session serialize. */
  async send(req: SendRequest): Promise<{ runId: string; sessionId: string }> {
    const sessionId = req.sessionId ?? this.deps.ids.next("sess");
    const runId = this.deps.ids.next("run");
    const rs = newRunState();
    this.active.set(runId, rs);
    this.enqueue(sessionId, () => this.runTurn(runId, sessionId, req, rs));
    return { runId, sessionId };
  }

  cancel(runId: string): boolean {
    const rs = this.active.get(runId);
    if (!rs) return false;
    rs.controller.abort();
    return true;
  }

  /** Shared per-project history store; also backs the history.* handlers. */
  async historyStore(): Promise<ChatHistoryStore> {
    if (!this.history) {
      const stateDir = await this.deps.host.workspace.stateDir();
      this.history = new ChatHistoryStore(this.deps.host, `${stateDir}/history`, this.deps.config().settings.historyRetentionDays, (id) => dropSessionArtifacts(this.deps.host, id));
    }
    return this.history;
  }

  /** The chat's full transcript for display: compaction summaries are expanded back from the archive. */
  async fullHistory(sessionId: string): Promise<ChatMessage[]> {
    const stored = (await (await this.historyStore()).load(sessionId)) ?? [];
    const stateDir = await this.deps.host.workspace.stateDir();
    return await expandArchived(this.deps.host, stored, `${stateDir}/sessions/${sessionId}.archive.jsonl`);
  }

  private async ledgerFor(): Promise<RunLedger> {
    if (this.ledger) return this.ledger;
    const stateDir = await this.deps.host.workspace.stateDir();
    this.ledger = new RunLedger(this.deps.host, `${stateDir}/ledger.jsonl`, this.deps.clock);
    await this.ledger.load();
    return this.ledger;
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn);
    this.chains.set(sessionId, next);
    void next.then(() => this.dropChain(sessionId, next), () => this.dropChain(sessionId, next));
  }

  private dropChain(sessionId: string, settled: Promise<void>): void {
    if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId);
  }

  private async persist(w: TurnWork): Promise<void> {
    await persistTurn(this.deps.host, w);
  }

  private async turnWork(runId: string, sessionId: string, rs: RunState): Promise<TurnWork> {
    const { host, bus } = this.deps;
    const stateDir = await host.workspace.stateDir();
    const store = await this.historyStore();
    const paths = await ProjectPaths.forProject(host);
    const tracker = changeTracker(host, { cwd: paths.base, stateDir, sessionId });
    const transcript = (await store.load(sessionId)) ?? [];
    closeOpenCalls(transcript);
    const w: TurnWork = {
      runId, sessionId, rs, stateDir, store, paths, tracker, declared: {}, transcript,
      state: await loadEngineState(host, stateDir, sessionId),
      plan: new PlanRunner({ host, paths, stateDir, sessionId, runId, bus, interaction: this.deps.interaction, tracker }),
      stepSave: () => {},
    };
    w.stepSave = stepSaver(() => this.persist(w));
    return w;
  }

  private async runTurn(runId: string, sessionId: string, req: SendRequest, rs: RunState): Promise<void> {
    const { bus } = this.deps;
    try {
      const w = await this.turnWork(runId, sessionId, rs);
      w.transcript.push({ role: "user", content: req.text, images: req.images?.length ? req.images : undefined });
      w.stepSave();
      bus.emit({ kind: "run.started", runId, roleId: "lead", title: req.text.slice(0, 60) });
      const res = await this.task(w, { goal: lastUserText(w.transcript), contract: leadContract(this.deps.config, w.declared), planTool: true });
      await this.persist(w);
      await this.finish(w, res);
    } catch (e) {
      bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: err(e) });
    } finally {
      this.active.delete(runId);
    }
  }

  private async taskDeps(w: TurnWork): Promise<TaskDeps> {
    const d = this.deps;
    return {
      host: d.host, bus: d.bus, permissions: d.permissions, interaction: d.interaction,
      channelFor: d.channelFor, config: d.config, engineFor: d.engineFor, ledger: await this.ledgerFor(),
      tracker: w.tracker, paths: w.paths, costCapUsd: d.config().settings.costLimit.perRunUsd,
    };
  }

  private async task(w: TurnWork, o: { goal: string; contract: () => Contract; baseline?: TaskResult["baseline"]; needs?: { mustChange?: boolean }; planTool: boolean }): Promise<TaskResult> {
    const config = this.deps.config();
    const lead = leadRole(config);
    const deps = await this.taskDeps(w);
    const chain = eligibleChain(lead, config.roles, config.agents, config.channels);
    const children = new ChildRunner({ ...deps, ids: this.deps.ids, stateDir: w.stateDir, sessionId: w.sessionId, runId: w.runId, agent: chain[0], ledger: deps.ledger, parent: w.rs });
    const hostTools = new ToolRegistry([loadSkillTool(config.skills), askUserTool(this.deps.interaction, w.runId), children.delegateTool(), children.healthReportTool(), setCheckTool(w.declared), ...(o.planTool ? w.plan.tools() : [])]);
    const tools = new ToolRegistry([...projectTools(this.deps.host, w.paths).for(lead).tools, ...hostTools.tools]);
    return await runTask(
      {
        runId: w.runId,
        sessionId: w.sessionId,
        role: lead,
        goal: o.goal,
        transcript: w.transcript,
        system: async () => (await systemPrompt(this.deps.host, lead, config)) + ((await w.plan.systemNote()) ?? ""),
        tools,
        hostTools,
        approve: policyApprove(lead, this.deps.permissions.gate(w.runId, w.rs.controller.signal)),
        engineState: w.state,
        contract: o.contract,
        needs: o.needs ?? {},
        interactive: true,
        run: w.rs,
        beforeModelTurn: async (agent: AgentDef) => this.compact(w, agent, config),
        onStep: w.stepSave,
        ...(o.baseline ? { baseline: o.baseline } : {}),
      },
      deps,
    );
  }

  /** Summarise older turns near the window; the plan rides in the system prompt. Skipped when the engine owns context. */
  private async compact(w: TurnWork, agent: AgentDef, config: EffectiveConfig): Promise<void> {
    const channel = this.deps.channelFor(agent.channel);
    if ((this.deps.engineFor ?? defaultEngineFor)(channel.cfg.type).caps.ownContext) return;
    const did = await compactTranscript({
      host: this.deps.host,
      transcript: w.transcript,
      channel,
      agent,
      window: agentContext(agent, config.channels),
      archivePath: `${w.stateDir}/sessions/${w.sessionId}.archive.jsonl`,
      signal: w.rs.controller.signal,
    });
    if (did) this.deps.host.log(`session ${w.sessionId}: transcript compacted`);
  }

  private drive(w: TurnWork, first: TaskResult["baseline"]): Promise<TaskResult> {
    return drivePlan(w, first, { task: (o) => this.task(w, o), bus: this.deps.bus, persist: () => this.persist(w), config: this.deps.config });
  }

  private async finish(w: TurnWork, res: TaskResult, first = res.baseline): Promise<void> {
    let out = res;
    const st = await w.plan.state();
    if (st?.plan.status === "active") {
      if (res.status === "done") out = await this.drive(w, first);
      else await w.plan.pause();
    }
    if (first.kind !== "unavailable") {
      await this.deps.host.files.writeAtomic(`${w.stateDir}/sessions/${w.sessionId}.turn`, `${first.id}\n`).catch((e) => this.deps.host.log(`turn baseline save failed: ${err(e)}`));
    }
    const changed = first.kind === "unavailable" ? undefined : await w.tracker.diff(first);
    const outcome = runOutcome(out.contract, out.check, changed, first);
    if (w.rs.accrued > 0) await this.emitCost(w.runId, w.rs.accrued);
    this.deps.bus.emit(finishedEvent(w.runId, w.rs, out, outcome));
  }

  /** Resume run: no lead pre-task — the driver continues at the first not-done milestone. */
  private async resumeRun(runId: string, sessionId: string, rs: RunState): Promise<void> {
    const { bus } = this.deps;
    try {
      const w = await this.turnWork(runId, sessionId, rs);
      const plan = await w.plan.resumePlan();
      if (!plan) return bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: "no active plan for this session" });
      bus.emit({ kind: "run.started", runId, roleId: "lead", title: `Resume plan: ${plan.goal}` });
      const first = await w.tracker.begin(`resume-${runId}`);
      const res = await this.drive(w, first);
      await this.persist(w);
      await this.finish(w, res, first);
    } catch (e) {
      bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: err(e) });
    } finally {
      this.active.delete(runId);
    }
  }

  /** Revert the session's worktree: "turn" = last turn baseline; else a checkpoint id, "baseline", or latest. */
  async revert(sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
    return await revertSession(this.deps, sessionId, checkpoint);
  }

  /** Latest session plan summary for history.load. */
  async planFor(sessionId: string): Promise<unknown> {
    return await planSummary(this.deps, sessionId);
  }

  /** Start a run resuming a paused/failed plan: the driver continues at the first not-done milestone. */
  async resume(sessionId: string): Promise<{ runId?: string; ok?: boolean; reason?: string }> {
    const st = (await planSummary(this.deps, sessionId)) as { status?: string } | undefined;
    if (!st || st.status === "done") return { ok: false, reason: "no active plan for this session" };
    const runId = this.deps.ids.next("run");
    const rs = newRunState();
    this.active.set(runId, rs);
    this.enqueue(sessionId, () => this.resumeRun(runId, sessionId, rs));
    return { runId, ok: true };
  }

  private async emitCost(runId: string, accrued: number): Promise<void> {
    const c = (await this.ledgerFor()).cost(runId);
    const cap = this.deps.config().settings.costLimit.perRunUsd;
    this.deps.bus.emit({ kind: "cost.summary", runId, roleId: "lead", capUsd: cap, accruedUsd: c.costUsd || accrued, overshootUsd: Math.max(0, c.costUsd - cap), byRole: c.byRole, byAgent: c.byAgent });
  }
}

/** The terminal run.finished event: cancel and cost cap short-circuit without an outcome. */
function finishedEvent(runId: string, rs: RunState, res: TaskResult, outcome: ReturnType<typeof runOutcome>): RunEvent {
  if (rs.costCapped) return { kind: "run.finished", runId, roleId: "lead", status: "failed", error: "cost cap reached" };
  if (res.reason === "cancelled") return { kind: "run.finished", runId, roleId: "lead", status: "cancelled" };
  if (res.status === "done") return { kind: "run.finished", runId, roleId: "lead", status: "done", outcome };
  return { kind: "run.finished", runId, roleId: "lead", status: "failed", error: res.error ?? "failed", outcome };
}

