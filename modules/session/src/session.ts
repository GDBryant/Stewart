import type { ChatMessage, Clock, HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Interaction } from "@stewart/interaction";
import type { Permissions } from "@stewart/permissions";
import type { AgentDef } from "@stewart/config";
import { agentContext, eligibleChain, type EffectiveConfig } from "@stewart/roles-skills";
import { ChatHistoryStore } from "./history.js";
import { costOfCall, RunLedger } from "@stewart/ledger";
import { ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { engineFor as defaultEngineFor, type Engine, type EngineEvent, type EngineTurn } from "@stewart/engines";
import { declaredCheck, isEditGoal, isReportGoal, runCheck, worktreeChanges, worktreeState, type Check, type CheckInput, type CheckResult, type WorktreeState } from "@stewart/tasks";
import { leadRole, systemPrompt } from "./lead.js";
import { askUserTool, loadSkillTool, setCheckTool } from "./sessionTools.js";
import { questionPrompt } from "@stewart/interaction";
import { ChildRunner } from "./child.js";
import { handoverText } from "./handover.js";
import { PlanRunner } from "./plan.js";
import { compactTranscript, expandArchived } from "./compact.js";
import { planResumeText, planSummary, revertSession } from "./planOps.js";
import { checkInput, err, finishedEvent, isReadTool, lastUserText, newRunState, snapshotBefore, type FinishReason, type RunState } from "./turnState.js";

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

interface EvCtx {
  runId: string;
  rs: RunState;
  agent: AgentDef;
  ledger: RunLedger;
  cap: number;
  plan: PlanRunner;
  host: HostPort;
  cwd: string;
}

/** One in-flight turn: what runTurn assembles once and drive/finish/persist share. */
interface TurnWork {
  runId: string;
  sessionId: string;
  transcript: ChatMessage[];
  state: Record<string, unknown>;
  rs: RunState;
  paths: ProjectPaths;
  stateDir: string;
  store: ChatHistoryStore;
  plan: PlanRunner;
  /** Worktree before the turn (git repos): edits made by shell commands count as changes. */
  disk0: WorktreeState;
}

type Env = { lead: ReturnType<typeof leadRole>; tools: ToolRegistry; hostTools: ToolRegistry; ledger: RunLedger; config: EffectiveConfig };

/** Changed files must differ and exist; the declared command runs; edit requests must change a file; report requests must cite real files. */
function turnChecks(rs: RunState, input: CheckInput): Check {
  const check: Check = { ...declaredCheck(input, rs.declared.value), edit: isEditGoal(rs.goal) || undefined };
  return !input.changed.length && isReportGoal(rs.goal) ? { ...check, cites: true } : check;
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
    const rs = newRunState(req.text);
    this.active.set(runId, rs);
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.runTurn(runId, sessionId, req, rs));
    this.chains.set(sessionId, next);
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
      this.history = new ChatHistoryStore(this.deps.host, `${stateDir}/history`, this.deps.config().settings.historyRetentionDays);
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
    if (!this.ledger) {
      const stateDir = await this.deps.host.workspace.stateDir();
      this.ledger = new RunLedger(this.deps.host, `${stateDir}/ledger.jsonl`, this.deps.clock);
      await this.ledger.load();
    }
    return this.ledger;
  }

  private async engineState(stateDir: string, sessionId: string): Promise<Record<string, unknown>> {
    const path = `${stateDir}/sessions/${sessionId}.engine.json`;
    try {
      if (await this.deps.host.files.exists(path)) {
        return JSON.parse((await this.deps.host.files.read(path)).content) as Record<string, unknown>;
      }
    } catch {
      /* corrupt engine state starts fresh */
    }
    return {};
  }

  private async persist(w: TurnWork): Promise<void> {
    try {
      await w.store.save(w.sessionId, w.transcript);
    } catch (e) {
      this.deps.host.log(`history save failed: ${err(e)}`);
    }
    try {
      await this.deps.host.files.writeAtomic(`${w.stateDir}/sessions/${w.sessionId}.engine.json`, JSON.stringify(w.state));
    } catch (e) {
      this.deps.host.log(`engine state save failed: ${err(e)}`);
    }
  }

  private async turnWork(runId: string, sessionId: string, rs: RunState): Promise<TurnWork> {
    const { host, bus } = this.deps;
    const stateDir = await host.workspace.stateDir();
    const store = await this.historyStore();
    const paths = await ProjectPaths.forProject(host);
    return {
      runId, sessionId, rs, stateDir, store, paths,
      transcript: (await store.load(sessionId)) ?? [],
      state: await this.engineState(stateDir, sessionId),
      plan: new PlanRunner({ host, paths, stateDir, sessionId, runId, bus, interaction: this.deps.interaction }),
      disk0: await worktreeState(host, paths.base),
    };
  }

  private async runTurn(runId: string, sessionId: string, req: SendRequest, rs: RunState): Promise<void> {
    const { bus } = this.deps;
    try {
      const w = await this.turnWork(runId, sessionId, rs);
      w.transcript.push({ role: "user", content: req.text, images: req.images?.length ? req.images : undefined });
      bus.emit({ kind: "run.started", runId, roleId: "lead", title: req.text.slice(0, 60) });
      try {
        await this.drive(w);
      } catch (e) {
        if (!rs.reason) {
          rs.reason = "error";
          rs.error = err(e);
        }
      }
      await this.persist(w);
      await this.finish(w);
    } catch (e) {
      bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: err(e) });
    } finally {
      this.active.delete(runId);
    }
  }

  private async drive(w: TurnWork): Promise<void> {
    const config = this.deps.config();
    const lead = leadRole(config);
    const chain = eligibleChain(lead, config.roles, config.agents, config.channels);
    const ledger = await this.ledgerFor();
    if (!chain.length) {
      w.rs.reason = "error";
      w.rs.error = "no qualified agent for role lead: run Qualify in settings";
      return;
    }
    const children = this.children(w, config, chain[0], ledger);
    const hostTools = new ToolRegistry([loadSkillTool(config.skills), askUserTool(this.deps.interaction, w.runId), children.delegateTool(), children.healthReportTool(), setCheckTool(w.rs.declared), ...w.plan.tools()]);
    const tools = new ToolRegistry([...projectTools(this.deps.host, w.paths).for(lead).tools, ...hostTools.tools]);
    await this.compact(w, chain[0], config);
    const goal = lastUserText(w.transcript);
    const env: Env = { lead, tools, hostTools, ledger, config };
    let prev: AgentDef | undefined;
    for (const agent of chain) {
      if (prev) this.escalate(w, prev, agent, goal);
      w.rs.reason = "" as FinishReason;
      w.rs.error = undefined;
      await this.attempt(w, agent, env);
      if (await this.attemptDone(w)) return;
      prev = agent;
    }
    await this.retryOrStop(w, prev ?? chain[0], env);
  }

  /**
   * Summarise older turns (or the older part of a long turn) when the transcript nears the window. The plan
   * rides in the system prompt; the open task is kept verbatim. Claude CLI agents manage their own context.
   */
  private async compact(w: TurnWork, agent: AgentDef, config: EffectiveConfig): Promise<void> {
    const channel = this.deps.channelFor(agent.channel);
    if (channel.cfg.type === "claude-cli") return;
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

  private escalate(w: TurnWork, prev: AgentDef, agent: AgentDef, goal: string): void {
    w.transcript.push({ role: "user", content: handoverText(prev.id, goal, w.rs.tried, w.rs.error ?? "unknown") });
    const reason = w.rs.reason === "stop" || !w.rs.reason ? "check_failed" : w.rs.reason;
    this.deps.bus.emit({ kind: "run.escalated", runId: w.runId, roleId: "lead", from: prev.id, to: agent.id, reason });
  }

  /** true when the chain should stop (cancel, cap, or a passed check); records the failure otherwise. */
  private async attemptDone(w: TurnWork): Promise<boolean> {
    if (w.rs.reason === "cancelled" || w.rs.costCapped) return true;
    if (w.rs.reason !== "stop") {
      if (!w.rs.error) w.rs.error = w.rs.reason;
      return false;
    }
    const res = await this.attemptCheck(w);
    if (res.passed) return true;
    w.rs.error = res.evidence.join("; ");
    return false;
  }

  private async attempt(w: TurnWork, agent: AgentDef, env: Env): Promise<void> {
    const { lead, tools, hostTools, ledger, config } = env;
    const channel = this.deps.channelFor(agent.channel);
    const engine = (this.deps.engineFor ?? defaultEngineFor)(channel.cfg.type);
    w.rs.lastCheck = undefined;
    const turn: EngineTurn = {
      sessionId: w.sessionId,
      transcript: w.transcript,
      system: (await systemPrompt(this.deps.host, lead, config)) + (await w.plan.systemNote() ?? ""),
      agent,
      channel,
      tools,
      hostTools,
      approve: this.deps.permissions.gate(w.runId, w.rs.controller.signal),
      state: w.state,
      cwd: w.paths.base,
      signal: w.rs.controller.signal,
      maxTurns: lead.turnBudget === "unlimited" ? 200 : lead.turnBudget,
      beforeModelTurn: () => this.compact(w, agent, config),
    };
    const c: EvCtx = { runId: w.runId, rs: w.rs, agent, ledger, cap: config.settings.costLimit.perRunUsd, plan: w.plan, host: this.deps.host, cwd: w.paths.base };
    try {
      for await (const ev of engine.run(turn)) await this.onEvent(ev, c);
    } catch (e) {
      w.rs.reason = "error";
      w.rs.error = err(e);
    }
  }

  /** The turn's check; the result is kept so `finish` does not run the same command twice. */
  private async attemptCheck(w: TurnWork): Promise<CheckResult> {
    const input = await this.inputFor(w);
    const res = await runCheck({ check: turnChecks(w.rs, input), input, host: this.deps.host, cwd: w.paths.base });
    w.rs.lastCheck = { res, writes: w.rs.writes.length, declared: w.rs.declared.value };
    return res;
  }

  private async inputFor(w: TurnWork): Promise<CheckInput> {
    const diskChanged = worktreeChanges(w.disk0, await worktreeState(this.deps.host, w.paths.base));
    return { ...checkInput(w.transcript, w.rs), diskChanged };
  }

  private async retryOrStop(w: TurnWork, agent: AgentDef, env: Env): Promise<void> {
    const evidence = w.rs.error ?? "failed";
    const question = `All agents for this task failed. ${evidence}\nReply with guidance to retry once more on ${agent.id}, or stop.`;
    const o = await this.deps.interaction.ask(questionPrompt("fallback", question, ["Stop"]), { runId: w.runId, roleId: "lead" }, w.rs.controller.signal);
    if (o.kind === "answered" && o.value !== "Stop") {
      w.transcript.push({ role: "user", content: o.value });
      w.rs.reason = "" as FinishReason;
      w.rs.error = undefined;
      await this.attempt(w, agent, env);
      if (w.rs.reason === "cancelled" || w.rs.costCapped) return;
      if (w.rs.reason === "stop") {
        const res = await this.attemptCheck(w);
        if (!res.passed) {
          w.rs.reason = "error";
          w.rs.error = res.evidence.join("; ");
        }
      }
      return;
    }
    w.rs.error = evidence;
  }

  private children(w: TurnWork, config: EffectiveConfig, agent: AgentDef, ledger: RunLedger): ChildRunner {
    return new ChildRunner({
      host: this.deps.host,
      bus: this.deps.bus,
      ids: this.deps.ids,
      permissions: this.deps.permissions,
      channelFor: this.deps.channelFor,
      config: this.deps.config,
      engineFor: this.deps.engineFor,
      paths: w.paths,
      stateDir: w.stateDir,
      runId: w.runId,
      sessionId: w.sessionId,
      agent,
      ledger,
      parent: w.rs,
      costCapUsd: config.settings.costLimit.perRunUsd,
      plan: w.plan,
    });
  }

  private async onEvent(ev: EngineEvent, c: EvCtx): Promise<void> {
    const { runId, rs } = c;
    const bus = this.deps.bus;
    switch (ev.kind) {
      case "text":
        return bus.emit({ kind: "text_delta", runId, roleId: "lead", seq: rs.seq++, text: ev.text });
      case "reasoning":
        return bus.emit({ kind: "reasoning_delta", runId, roleId: "lead", seq: rs.seq++, text: ev.text });
      case "tool.request":
        return await this.onRequest(ev, c);
      case "tool.outcome":
        this.onOutcome(ev, rs);
        return bus.emit({ kind: "tool.outcome", runId, roleId: "lead", callId: ev.callId, ok: ev.ok, summary: ev.summary });
      case "write":
        rs.writes.push(ev.record);
        return void c.plan.recordWrite(ev.record);
      case "usage":
        return this.onUsage(ev, c);
      case "finished":
        rs.reason = ev.reason;
        rs.error = ev.error;
        return;
    }
  }

  private async onRequest(ev: Extract<EngineEvent, { kind: "tool.request" }>, c: EvCtx): Promise<void> {
    const { rs, plan } = c;
    await snapshotBefore({ host: c.host, cwd: c.cwd, before: rs.before, onFirst: (p, content) => plan.beforeWrite(p, content) }, ev.tool, ev.args);
    rs.tried.push({ callId: ev.callId, name: ev.tool, args: JSON.stringify(ev.args ?? {}) });
    this.deps.bus.emit({ kind: "tool.request", runId: c.runId, roleId: "lead", callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
  }

  /** Match the outcome to its call by id (batched and parallel calls finish out of order). */
  private onOutcome(ev: Extract<EngineEvent, { kind: "tool.outcome" }>, rs: RunState): void {
    const t = rs.tried.find((x) => x.callId === ev.callId);
    if (!t) return;
    t.ok = ev.ok;
    if (ev.ok && isReadTool(t.name)) rs.reads++;
  }

  private async onUsage(ev: Extract<EngineEvent, { kind: "usage" }>, c: EvCtx): Promise<void> {
    const { runId, rs, agent, ledger, cap } = c;
    const cost = ev.costUsd ?? costOfCall(agent, { in: ev.inTokens, out: ev.outTokens }, undefined);
    rs.accrued += cost;
    await ledger.record({ runId, roleId: "lead", agentId: agent.id, model: agent.model, billing: agent.billing ?? "reported", inTokens: ev.inTokens, outTokens: ev.outTokens, costUsd: cost });
    if (cap > 0 && rs.accrued > cap) {
      rs.costCapped = true;
      this.deps.bus.emit({ kind: "cost.limit_reached", runId, roleId: "lead", capUsd: cap, accruedUsd: rs.accrued });
      rs.controller.abort();
    }
  }

  /** The final check: reuses the last attempt's result when nothing was written or declared since. */
  private async finalCheck(w: TurnWork): Promise<CheckResult> {
    const last = w.rs.lastCheck;
    if (last && last.writes === w.rs.writes.length && last.declared === w.rs.declared.value) return { passed: last.res.passed, evidence: [...last.res.evidence] };
    const input = await this.inputFor(w);
    return await runCheck({ check: turnChecks(w.rs, input), input, host: this.deps.host, cwd: w.paths.base });
  }

  /** Plan sweep runs only after a turn that did plan work (writes or plan tools), never on cancel or cost cap. */
  private async sweep(w: TurnWork): Promise<{ id: string; title: string; evidence: string } | undefined> {
    const { rs } = w;
    if (rs.reason === "cancelled" || rs.costCapped) return undefined;
    if (!rs.writes.length && !w.plan.touched) return undefined;
    return await w.plan.sweepFinish();
  }

  private async finish(w: TurnWork): Promise<void> {
    const { runId, rs } = w;
    const res = await this.finalCheck(w);
    const pending = await this.sweep(w);
    const planErr = pending ? `plan incomplete: ${pending.id} ${pending.title}: ${pending.evidence}` : undefined;
    if (planErr) res.evidence.push(planErr);
    this.deps.bus.emit({ kind: "check.result", runId, roleId: "lead", passed: res.passed && !pending, evidence: res.evidence });
    if (rs.accrued > 0) await this.emitCost(runId, rs.accrued);
    if (planErr) {
      this.deps.bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: planErr });
      return;
    }
    this.deps.bus.emit(finishedEvent(runId, rs, res));
  }

  /** Revert the session's worktree to a checkpoint (id, "baseline", or latest). */
  async revert(sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
    return await revertSession(this.deps, sessionId, checkpoint);
  }

  /** Latest session plan summary for history.load. */
  async planFor(sessionId: string): Promise<unknown> {
    return await planSummary(this.deps, sessionId);
  }

  /** Start a lead turn resuming an active plan. */
  async resume(sessionId: string): Promise<{ runId?: string; ok?: boolean; reason?: string }> {
    const text = await planResumeText(this.deps, sessionId);
    if (!text) return { ok: false, reason: "no active plan for this session" };
    return await this.send({ sessionId, text });
  }

  private async emitCost(runId: string, accrued: number): Promise<void> {
    const c = (await this.ledgerFor()).cost(runId);
    const cap = this.deps.config().settings.costLimit.perRunUsd;
    this.deps.bus.emit({
      kind: "cost.summary", runId, roleId: "lead", capUsd: cap, accruedUsd: c.costUsd || accrued,
      overshootUsd: Math.max(0, c.costUsd - cap), byRole: c.byRole, byAgent: c.byAgent,
    });
  }
}
