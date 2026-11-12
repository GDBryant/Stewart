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
import { engineFor as defaultEngineFor, type Engine, type EngineEvent, type EngineTurn, type WriteRecord } from "@stewart/engines";
import { declaredCheck, isReportGoal, runCheck, type Check, type CheckInput, type CheckResult } from "@stewart/tasks";
import { leadAgent, leadRole, systemPrompt } from "./lead.js";
import { askUserTool, loadSkillTool, setCheckTool, type DeclaredCheck } from "./sessionTools.js";
import { questionPrompt } from "@stewart/interaction";
import { ChildRunner } from "./child.js";
import { handoverText, type Tried } from "./handover.js";
import { PlanRunner } from "./plan.js";
import { compactTranscript } from "./compact.js";

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

type FinishReason = "stop" | "turn_limit" | "cancelled" | "loop_guard" | "error" | "";

interface RunState {
  controller: AbortController;
  seq: number;
  writes: WriteRecord[];
  accrued: number;
  reason: FinishReason;
  error?: string;
  costCapped: boolean;
  tried: Tried[];
  /** File content before its first write this turn (null = absent). */
  before: Record<string, string | null>;
  /** The lead's `set_check` declaration. */
  declared: { value?: DeclaredCheck };
  /** The turn's user request, for report detection. */
  goal: string;
}

interface EvCtx {
  runId: string;
  rs: RunState;
  agent: AgentDef;
  ledger: RunLedger;
  cap: number;
  plan: PlanRunner;
  host: HostPort;
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
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["path", "file_path", "notebook_path"];

/** Remember a file's content before the first write to it this turn (best effort; unreadable = absent). */
async function snapshotBefore(host: HostPort, rs: RunState, tool: string, args: unknown): Promise<void> {
  if (!WRITE_TOOLS.has(tool)) return;
  const a = (args ?? {}) as Record<string, unknown>;
  const key = PATH_KEYS.find((k) => typeof a[k] === "string");
  if (!key) return;
  const path = a[key] as string;
  if (path in rs.before) return;
  try {
    rs.before[path] = (await host.files.exists(path)) ? (await host.files.read(path)).content : null;
  } catch {
    /* no snapshot: the changed-content check skips this path */
  }
}

function lastUserText(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
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
    const rs: RunState = { controller: new AbortController(), seq: 0, writes: [], accrued: 0, reason: "", costCapped: false, tried: [], before: {}, declared: {}, goal: req.text };
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

  private async runTurn(runId: string, sessionId: string, req: SendRequest, rs: RunState): Promise<void> {
    const { host, bus } = this.deps;
    try {
      const stateDir = await host.workspace.stateDir();
      const store = await this.historyStore();
      const w: TurnWork = {
        runId, sessionId, rs, stateDir, store,
        transcript: (await store.load(sessionId)) ?? [],
        state: await this.engineState(stateDir, sessionId),
        paths: await ProjectPaths.forProject(host),
      plan: undefined as unknown as PlanRunner,
      };
      w.plan = new PlanRunner({ host, paths: w.paths, stateDir, sessionId, runId, bus, interaction: this.deps.interaction });
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
    const env = { lead, tools, hostTools, ledger, config };
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

  /** Summarise older turns when the transcript nears the window; the plan rides in the system prompt, the open task is kept verbatim. */
  private async compact(w: TurnWork, agent: AgentDef, config: EffectiveConfig): Promise<void> {
    const did = await compactTranscript({
      host: this.deps.host,
      transcript: w.transcript,
      channel: this.deps.channelFor(agent.channel),
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

  private async attempt(w: TurnWork, agent: AgentDef, env: { lead: ReturnType<typeof leadRole>; tools: ToolRegistry; hostTools: ToolRegistry; ledger: RunLedger; config: EffectiveConfig }): Promise<void> {
    const { lead, tools, hostTools, ledger, config } = env;
    const channel = this.deps.channelFor(agent.channel);
    const engine = (this.deps.engineFor ?? defaultEngineFor)(channel.cfg.type);
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
    };
    const c: EvCtx = { runId: w.runId, rs: w.rs, agent, ledger, cap: config.settings.costLimit.perRunUsd, plan: w.plan, host: this.deps.host };
    try {
      for await (const ev of engine.run(turn)) await this.onEvent(ev, c);
    } catch (e) {
      w.rs.reason = "error";
      w.rs.error = err(e);
    }
  }

  private async attemptCheck(w: TurnWork) {
    const input = this.checkInput(w.transcript, w.rs);
    return await runCheck({ check: this.turnChecks(w.rs, input), input, host: this.deps.host, cwd: w.paths.base });
  }

  /** Changed files must differ and exist; the lead's declared command runs; report requests must cite real files. */
  private turnChecks(rs: RunState, input: CheckInput): Check {
    const check = declaredCheck(input, rs.declared.value);
    return !input.changed.length && isReportGoal(rs.goal) ? { ...check, cites: true } : check;
  }

  private async retryOrStop(w: TurnWork, agent: AgentDef, env: { lead: ReturnType<typeof leadRole>; tools: ToolRegistry; hostTools: ToolRegistry; ledger: RunLedger; config: EffectiveConfig }): Promise<void> {
    const { lead } = env;
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
        await snapshotBefore(c.host, rs, ev.tool, ev.args);
        rs.tried.push({ name: ev.tool, args: JSON.stringify(ev.args ?? {}) });
        return bus.emit({ kind: "tool.request", runId, roleId: "lead", callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
      case "tool.outcome": {
        const t = rs.tried[rs.tried.length - 1];
        if (t) t.ok = ev.ok;
        return bus.emit({ kind: "tool.outcome", runId, roleId: "lead", callId: ev.callId, ok: ev.ok, summary: ev.summary });
      }
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

  private checkInput(transcript: ChatMessage[], rs: RunState): CheckInput {
    let reply = "";
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (m.role === "assistant" && m.content.trim()) {
        reply = m.content;
        break;
      }
      if (m.role === "user") break;
    }
    const changed = [...new Set(rs.writes.filter((w) => w.ok).map((w) => w.path))];
    return { reply, writes: rs.writes, changed, before: rs.before };
  }

  private finishedEvent(runId: string, rs: RunState, res: CheckResult): RunEvent {
    if (rs.costCapped) return { kind: "run.finished", runId, roleId: "lead", status: "failed", error: "cost cap reached" };
    if (rs.reason === "cancelled") return { kind: "run.finished", runId, roleId: "lead", status: "cancelled" };
    if (rs.reason === "stop" && res.passed) return { kind: "run.finished", runId, roleId: "lead", status: "done" };
    const error = rs.error ?? (res.passed ? rs.reason || "failed" : res.evidence.join("; "));
    return { kind: "run.finished", runId, roleId: "lead", status: "failed", error };
  }

  private async finish(w: TurnWork): Promise<void> {
    const { runId, rs } = w;
    const input = this.checkInput(w.transcript, rs);
    const res = await runCheck({ check: this.turnChecks(rs, input), input, host: this.deps.host, cwd: w.paths.base });
    const pending = await w.plan.sweepFinish();
    if (pending) res.evidence.push(`plan incomplete: ${pending.id} ${pending.title}: ${pending.evidence}`);
    this.deps.bus.emit({ kind: "check.result", runId, roleId: "lead", passed: res.passed && !pending, evidence: res.evidence });
    if (rs.accrued > 0) await this.emitCost(runId, rs.accrued);
    if (pending && rs.reason !== "cancelled" && !rs.costCapped) {
      this.deps.bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: `plan incomplete: ${pending.id} ${pending.title}: ${pending.evidence}` });
      return;
    }
    this.deps.bus.emit(this.finishedEvent(runId, rs, res));
  }

  /** Revert the session's worktree to a checkpoint (id, "baseline", or latest). */
  async revert(sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
    const stateDir = await this.deps.host.workspace.stateDir();
    const paths = await ProjectPaths.forProject(this.deps.host);
    const runId = this.deps.ids.next("revert");
    const plan = new PlanRunner({ host: this.deps.host, paths, stateDir, sessionId, runId, bus: this.deps.bus, interaction: this.deps.interaction });
    const done = await plan.revertTo(checkpoint);
    if (!done) return { ok: false, reason: "no checkpoint for this session" };
    const filesRestored = [...done.restored, ...done.deleted.map((p) => `-${p}`)];
    this.deps.bus.emit({ kind: "run.reverted", runId, roleId: "lead", filesRestored });
    return { ok: true, filesRestored };
  }

  /** Latest session plan summary for history.load. */
  async planFor(sessionId: string): Promise<unknown> {
    const stateDir = await this.deps.host.workspace.stateDir();
    const paths = await ProjectPaths.forProject(this.deps.host);
    const plan = new PlanRunner({ host: this.deps.host, paths, stateDir, sessionId, runId: "history", bus: this.deps.bus, interaction: this.deps.interaction });
    const cps = await plan.checkpoints();
    const text = await plan.resumeText();
    const st = await (plan as unknown as { load(): Promise<{ plan: { goal: string; status: string; milestones: { id: string; title: string; status: string; checkpoint?: string }[] } } | undefined> }).load();
    if (!st) return undefined;
    return { goal: st.plan.goal, status: st.plan.status, active: text !== undefined, milestones: st.plan.milestones, latest: cps.latest, baseline: cps.baseline };
  }

  /** Start a lead turn resuming an active plan. */
  async resume(sessionId: string): Promise<{ runId?: string; ok?: boolean; reason?: string }> {
    const stateDir = await this.deps.host.workspace.stateDir();
    const paths = await ProjectPaths.forProject(this.deps.host);
    const plan = new PlanRunner({ host: this.deps.host, paths, stateDir, sessionId, runId: "resume", bus: this.deps.bus, interaction: this.deps.interaction });
    const text = await plan.resumeText();
    if (!text) return { ok: false, reason: "no active plan for this session" };
    return await this.send({ sessionId, text });
  }

  private async emitCost(runId: string, accrued: number): Promise<void> {
    const c = (await this.ledgerFor()).cost(runId);
    const cap = this.deps.config().settings.costLimit.perRunUsd;
    this.deps.bus.emit({
      kind: "cost.summary", runId, roleId: "lead", capUsd: cap, accruedUsd: c.costUsd || accrued,
      overshootUsd: Math.max(0, c.costUsd - cap), byRole: c.byRole, byAgent: c.byAgent, parked: [], freeFinished: [], suggestions: [],
    });
  }
}
