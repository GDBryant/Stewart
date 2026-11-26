import type { ChatMessage, Clock, HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Interaction } from "@stewart/interaction";
import type { Permissions } from "@stewart/permissions";
import type { AgentDef } from "@stewart/config";
import { agentContext, eligibleChain, type EffectiveConfig } from "@stewart/roles-skills";
import { ChatHistoryStore } from "./history.js";
import { RunLedger } from "@stewart/ledger";
import { HealthBatches, ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { engineFor as defaultEngineFor, type Engine } from "@stewart/engines";
import { changeTracker, type ChangeTracker } from "@stewart/tasks";
import { leadRole, systemPrompt } from "./lead.js";
import { askUserTool, loadSkillTool, setCheckTool, type Declared } from "./sessionTools.js";
import { ChildRunner } from "./child.js";
import { PlanRunner } from "./plan.js";
import { compactTranscript, expandArchived, type CompactState } from "./compact.js";
import { planSummary, revertSession, showFileDiff } from "./planOps.js";
import { drivePlan, leadContract } from "./planDrive.js";
import { abortRace, AbortedRun, err, newRunState, lastUserText, runOutcome, closeOpenCalls, type RunState } from "./turnState.js";
import { failedRunEvent, finishedEvent } from "./runEvents.js";
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
  /** Requests since the last model summary (compaction cooldown). */
  compactState: CompactState;
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

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(sessionId, next);
    void next.then(() => this.dropChain(sessionId, next), () => this.dropChain(sessionId, next));
    return next;
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
    const paths = await ProjectPaths.forProject(host, { readRoots: this.deps.config().project.readRoots });
    const tracker = changeTracker(host, { cwd: paths.base, stateDir, sessionId });
    const transcript = (await store.load(sessionId)) ?? [];
    closeOpenCalls(transcript);
    const w: TurnWork = {
      runId, sessionId, rs, stateDir, store, paths, tracker, declared: {}, transcript,
      state: await loadEngineState(host, stateDir, sessionId),
      plan: new PlanRunner({ host, paths, stateDir, sessionId, runId, bus, interaction: this.deps.interaction, tracker }),
      stepSave: () => {},
      compactState: { sinceSummary: Number.POSITIVE_INFINITY },
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
      bus.emit(failedRunEvent(runId, rs, err(e)));
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
    const hostTools = new ToolRegistry([loadSkillTool(config.skills), askUserTool(this.deps.interaction, w.runId), children.delegateTool(), children.healthReportTool(), new HealthBatches(this.deps.host, w.paths), setCheckTool(w.declared), ...(o.planTool ? w.plan.tools() : [])]);
    const tools = new ToolRegistry([...projectTools(this.deps.host, w.paths).for(lead).tools, ...hostTools.tools]);
    const res = await runTask(
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
        maxTurns: config.settings.runTurnLimit,
        run: w.rs,
        beforeModelTurn: async (agent: AgentDef, ctx?: { measured?: { tokens: number; len: number } }) => this.compact(w, agent, config, ctx?.measured),
        onStep: w.stepSave,
        ...(o.baseline ? { baseline: o.baseline } : {}),
      },
      deps,
    );
    const verdict = children.healthVerdict();
    return verdict && res.status === "done" ? { ...res, status: "failed", error: verdict } : res;
  }

  /** Summarise older turns near the window; the plan rides in the system prompt. Skipped when the engine owns context. */
  private async compact(w: TurnWork, agent: AgentDef, config: EffectiveConfig, measured?: { tokens: number; len: number }): Promise<boolean> {
    const channel = this.deps.channelFor(agent.channel);
    if ((this.deps.engineFor ?? defaultEngineFor)(channel.cfg.type).caps.ownContext) return false;
    const did = await compactTranscript({
      host: this.deps.host,
      transcript: w.transcript,
      channel,
      agent,
      window: agentContext(agent, config.channels),
      archivePath: `${w.stateDir}/sessions/${w.sessionId}.archive.jsonl`,
      signal: w.rs.controller.signal,
      measured,
      state: w.compactState,
    });
    if (did) this.deps.host.log(`session ${w.sessionId}: transcript compacted`);
    return did;
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
    const changed =
      first.kind === "unavailable"
        ? undefined
        : await abortRace(w.tracker.diff(first), w.rs).catch((e) => {
            if (e instanceof AbortedRun) return undefined;
            throw e;
          });
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
      if (!plan) return bus.emit(failedRunEvent(runId, rs, "no active plan for this session"));
      bus.emit({ kind: "run.started", runId, roleId: "lead", title: `Resume plan: ${plan.goal}` });
      const first = await abortRace(w.tracker.begin(`resume-${runId}`), rs).catch((e) => {
        if (!(e instanceof AbortedRun)) throw e;
        return undefined;
      });
      if (!first) return bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "cancelled" });
      const res = await this.drive(w, first);
      await this.persist(w);
      await this.finish(w, res, first);
    } catch (e) {
      bus.emit(failedRunEvent(runId, rs, err(e)));
    } finally {
      this.active.delete(runId);
    }
  }

  /** Revert the session's worktree: "turn" = last turn baseline; else a checkpoint id, "baseline", or latest. */
  async revert(sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
    return await revertSession(this.deps, sessionId, checkpoint);
  }

  /** Diff one file of a finished run: baseline content vs the current file, in the host diff viewer. */
  async fileDiff(sessionId: string, path: string, baseline: string): Promise<void> {
    return await showFileDiff(this.deps, sessionId, path, baseline);
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

  /**
   * Shared guarded drop behind /clear and history.delete: refuse while a turn is
   * queued or running for [sessionId], otherwise enqueue the history delete on the
   * session's turn chain — synchronously, so sends/resumes issued from now on queue
   * behind it — then emit `chat.cleared` carrying the sessionId. The delete's
   * onDelete hook also drops the engine/plan/turn/archive/child artifacts, the
   * tracker and the checkpoints. A deletion failure is reported back instead of a
   * silent clear.
   */
  private async dropSession(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const { bus, host, ids } = this.deps;
    if (this.chains.has(sessionId)) return { ok: false, reason: "a run is active for this session" };
    const runId = ids.next("clear");
    try {
      await this.enqueue(sessionId, async () => {
        await (await this.historyStore()).delete(sessionId);
      });
    } catch (e) {
      const reason = err(e);
      host.log(`clear session ${sessionId} failed: ${reason}`);
      return { ok: false, reason };
    }
    bus.emit({ kind: "chat.cleared", runId, sessionId });
    return { ok: true };
  }

  async clear(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    return await this.dropSession(sessionId);
  }

  /** history.delete: same guarded drop as /clear; a refusal or failure throws for the host to surface. */
  async delete(sessionId: string): Promise<void> {
    const res = await this.dropSession(sessionId);
    if (!res.ok) throw new Error(res.reason);
  }

  private async emitCost(runId: string, accrued: number): Promise<void> {
    const c = (await this.ledgerFor()).cost(runId);
    const cap = this.deps.config().settings.costLimit.perRunUsd;
    this.deps.bus.emit({ kind: "cost.summary", runId, roleId: "lead", capUsd: cap, accruedUsd: c.costUsd || accrued, overshootUsd: Math.max(0, c.costUsd - cap), byRole: c.byRole, byAgent: c.byAgent });
  }
}

