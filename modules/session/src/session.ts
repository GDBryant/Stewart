import type { ChatMessage, Clock, HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Interaction } from "@stewart/interaction";
import type { Permissions } from "@stewart/permissions";
import type { AgentDef } from "@stewart/config";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { ChatHistoryStore } from "./history.js";
import { costOfCall, RunLedger } from "@stewart/ledger";
import { ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { engineFor as defaultEngineFor, type Engine, type EngineEvent, type EngineTurn, type WriteRecord } from "@stewart/engines";
import { runCheck, turnCheck, type CheckInput, type CheckResult } from "@stewart/tasks";
import { leadAgent, leadRole, systemPrompt } from "./lead.js";
import { askUserTool, loadSkillTool } from "./sessionTools.js";
import { ChildRunner } from "./child.js";

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

type FinishReason = "stop" | "turn_limit" | "cancelled" | "error" | "";

interface RunState {
  controller: AbortController;
  seq: number;
  writes: WriteRecord[];
  accrued: number;
  reason: FinishReason;
  error?: string;
  costCapped: boolean;
}

interface EvCtx {
  runId: string;
  rs: RunState;
  agent: AgentDef;
  ledger: RunLedger;
  cap: number;
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
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    const rs: RunState = { controller: new AbortController(), seq: 0, writes: [], accrued: 0, reason: "", costCapped: false };
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
      };
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
      await this.finish(runId, w.transcript, rs, w.paths.base);
    } catch (e) {
      bus.emit({ kind: "run.finished", runId, roleId: "lead", status: "failed", error: err(e) });
    } finally {
      this.active.delete(runId);
    }
  }

  private async drive(w: TurnWork): Promise<void> {
    const config = this.deps.config();
    const lead = leadRole(config);
    const agent = leadAgent(config, lead);
    const channel = this.deps.channelFor(agent.channel);
    const engine = (this.deps.engineFor ?? defaultEngineFor)(channel.cfg.type);
    const base = projectTools(this.deps.host, w.paths).for(lead);
    const ledger = await this.ledgerFor();
    const children = this.children(w, config, agent, ledger);
    const tools = new ToolRegistry([...base.tools, loadSkillTool(config.skills), askUserTool(this.deps.interaction, w.runId), children.delegateTool(), children.healthReportTool()]);
    const turn: EngineTurn = {
      sessionId: w.sessionId,
      transcript: w.transcript,
      system: await systemPrompt(this.deps.host, lead, config),
      agent,
      channel,
      tools,
      approve: this.deps.permissions.gate(w.runId, w.rs.controller.signal),
      state: w.state,
      cwd: w.paths.base,
      signal: w.rs.controller.signal,
      maxTurns: lead.turnBudget === "unlimited" ? 200 : lead.turnBudget,
    };
    const c: EvCtx = { runId: w.runId, rs: w.rs, agent, ledger, cap: config.settings.costLimit.perRunUsd };
    for await (const ev of engine.run(turn)) await this.onEvent(ev, c);
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
        return bus.emit({ kind: "tool.request", runId, roleId: "lead", callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
      case "tool.outcome":
        return bus.emit({ kind: "tool.outcome", runId, roleId: "lead", callId: ev.callId, ok: ev.ok, summary: ev.summary });
      case "write":
        return void rs.writes.push(ev.record);
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
    return { reply, writes: rs.writes, changed };
  }

  private finishedEvent(runId: string, rs: RunState, res: CheckResult): RunEvent {
    if (rs.costCapped) return { kind: "run.finished", runId, roleId: "lead", status: "failed", error: "cost cap reached" };
    if (rs.reason === "cancelled") return { kind: "run.finished", runId, roleId: "lead", status: "cancelled" };
    if (rs.reason === "stop" && res.passed) return { kind: "run.finished", runId, roleId: "lead", status: "done" };
    const error = rs.error ?? (res.passed ? rs.reason || "failed" : res.evidence.join("; "));
    return { kind: "run.finished", runId, roleId: "lead", status: "failed", error };
  }

  private async finish(runId: string, transcript: ChatMessage[], rs: RunState, cwd: string): Promise<void> {
    const input = this.checkInput(transcript, rs);
    const res = await runCheck({ check: turnCheck(input), input, host: this.deps.host, cwd });
    this.deps.bus.emit({ kind: "check.result", runId, roleId: "lead", passed: res.passed, evidence: res.evidence });
    if (rs.accrued > 0) await this.emitCost(runId, rs.accrued);
    this.deps.bus.emit(this.finishedEvent(runId, rs, res));
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
