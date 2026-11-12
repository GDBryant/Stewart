import type { AgentDef, RoleDef } from "@stewart/config";
import type { ChatMessage, HostPort, Json } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { ManagedChannel } from "@stewart/channels";
import type { Permissions, ApproveFn } from "@stewart/permissions";
import type { RunLedger } from "@stewart/ledger";
import { costOfCall } from "@stewart/ledger";
import { checkReadOnlyCommand, roleIsReadOnly, ToolRegistry, type ProjectPaths, type Tool } from "@stewart/tools";
import { projectTools } from "@stewart/tools";
import type { Engine, EngineEvent, WriteRecord } from "@stewart/engines";
import { engineFor as defaultEngineFor } from "@stewart/engines";
import { runCheck, turnCheck, type CheckInput } from "@stewart/tasks";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthReport } from "@stewart/code-health";
import { loadSkillTool } from "./sessionTools.js";
import { systemPrompt } from "./lead.js";

function lastReply(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && m.content.trim()) return m.content;
  }
  return "";
}

const MAX_CHILDREN = 4;
const REPLY_CAP = 8000;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;

export interface ChildDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  ids: { next(prefix: string): string };
  permissions: Permissions;
  channelFor: (id: string) => ManagedChannel;
  config: () => EffectiveConfig;
  engineFor?: (channelType: string) => Engine;
  paths: ProjectPaths;
  stateDir: string;
  runId: string;
  sessionId: string;
  agent: AgentDef;
  ledger: RunLedger;
  /** Shared counters with the parent turn: accrued cost, stream seq, cancel signal. */
  parent: { controller: AbortController; seq: number; accrued: number; costCapped: boolean };
  costCapUsd: number;
}

interface ChildCtx extends ChildDeps {
  role: RoleDef;
  taskId: string;
  agent: AgentDef;
  ledger: RunLedger;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capReply(raw: string): string {
  if (raw.length <= REPLY_CAP) return raw;
  const head = Math.ceil(REPLY_CAP * 0.7);
  return `${raw.slice(0, head)}\n[reply truncated: ${raw.length - REPLY_CAP} chars omitted]\n${raw.slice(-Math.floor(REPLY_CAP * 0.3))}`;
}

/** Deny reason for calls a read-only role must not make, or null. Applies to claude-code children (no tool registry). */
function readOnlyDeny(role: RoleDef, call: { name: string }, preview: { kind: string; command?: string } | null): string | null {
  if (!roleIsReadOnly(role)) return null;
  if (preview?.kind === "file") return `read-only role '${role.id}' cannot edit files`;
  if (preview?.kind === "command" && typeof preview.command === "string") {
    try {
      checkReadOnlyCommand(preview.command, role.id);
    } catch (e) {
      return err(e);
    }
  }
  void call;
  return null;
}

/** Per-lead-run child runs behind the delegate/health_report tools. Depth 1: children never get these tools. */
interface ChildJob {
  role: RoleDef;
  taskId: string;
  agent: AgentDef;
  task: string;
  report: "text" | "health";
}

export class ChildRunner {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly reports = new Map<string, HealthReport>();

  constructor(private readonly d: ChildDeps) {}

  delegateTool(): Tool {
    const roles = this.d.config().roles.filter((r) => r.enabled && r.id !== "lead").map((r) => r.id);
    return {
      spec: {
        name: "delegate",
        description: "Delegate a task to another role and get its report. Runs in parallel with other delegate calls.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: roles.length ? roles : ["_none_"] },
            task: { type: "string" },
            report: { type: "string", enum: ["text", "health"] },
          },
          required: ["role", "task"],
        },
      },
      requiresApproval: false,
      parallel: true,
      execute: async (args) => this.delegate(args),
    };
  }

  healthReportTool(): Tool {
    return {
      spec: {
        name: "health_report",
        description: "Merge this run's health reports, write the combined report file and return the rendered text.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
      },
      requiresApproval: false,
      execute: async () => this.healthReport(),
    };
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_CHILDREN) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  private async delegate(args: Json): Promise<string> {
    const roleId = String(args.role ?? "");
    const role = this.d.config().roles.find((r) => r.id === roleId);
    if (!role || role.id === "lead" || !role.enabled) throw new Error(`unknown delegate role '${roleId}'`);
    const report = args.report === undefined ? "text" : String(args.report);
    if (report !== "text" && report !== "health") throw new Error(`unknown report mode '${report}'`);
    await this.acquire();
    try {
      return await this.childTurn(role, String(args.task ?? ""), report);
    } finally {
      this.release();
    }
  }

  private childAgent(role: RoleDef): AgentDef {
    const bound = this.d.config().agents.find((a) => a.id === role.agent);
    return bound ?? this.d.agent;
  }

  private childApprove(role: RoleDef): ApproveFn {
    const gate = this.d.permissions.gate(this.d.runId, this.d.parent.controller.signal);
    return async (call, preview, meta) => {
      const deny = readOnlyDeny(role, call, preview as { kind: string; command?: string } | null);
      if (deny) return { kind: "rejected", reason: deny };
      return gate(call, preview, { ...meta, roleId: role.id });
    };
  }

  private async onChildEvent(ev: EngineEvent, c: ChildCtx, writes: WriteRecord[]): Promise<void> {
    const { bus, parent, runId, taskId, role } = { runId: c.runId, taskId: c.taskId, role: c.role, bus: c.bus, parent: c.parent };
    const base = { runId, taskId, roleId: role.id };
    switch (ev.kind) {
      case "text":
        return bus.emit({ kind: "text_delta", ...base, seq: parent.seq++, text: ev.text });
      case "reasoning":
        return bus.emit({ kind: "reasoning_delta", ...base, seq: parent.seq++, text: ev.text });
      case "tool.request":
        return bus.emit({ kind: "tool.request", ...base, callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
      case "tool.outcome":
        return bus.emit({ kind: "tool.outcome", ...base, callId: ev.callId, ok: ev.ok, summary: ev.summary });
      case "write":
        return void writes.push(ev.record);
      case "usage":
        return this.childUsage(ev, c);
      case "finished":
        return;
    }
  }

  private async childUsage(ev: Extract<EngineEvent, { kind: "usage" }>, c: ChildCtx): Promise<void> {
    const cost = ev.costUsd ?? costOfCall(c.agent, { in: ev.inTokens, out: ev.outTokens }, undefined);
    c.parent.accrued += cost;
    await c.ledger.record({ runId: c.runId, roleId: c.role.id, agentId: c.agent.id, model: c.agent.model, billing: c.agent.billing ?? "reported", inTokens: ev.inTokens, outTokens: ev.outTokens, costUsd: cost });
    if (c.costCapUsd > 0 && c.parent.accrued > c.costCapUsd) {
      c.parent.costCapped = true;
      c.bus.emit({ kind: "cost.limit_reached", runId: c.runId, roleId: c.role.id, taskId: c.taskId, capUsd: c.costCapUsd, accruedUsd: c.parent.accrued });
      c.parent.controller.abort();
    }
  }

  private async childTurn(role: RoleDef, task: string, report: "text" | "health"): Promise<string> {
    const { host, bus, ids } = this.d;
    const taskId = ids.next("task");
    const agent = this.childAgent(role);
    bus.emit({ kind: "task.created", runId: this.d.runId, taskId, roleId: role.id, title: task.slice(0, 80), dependsOn: [] });
    bus.emit({ kind: "task.started", runId: this.d.runId, taskId, roleId: role.id, agentId: agent.id });
    const outcome = await this.runChild({ role, taskId, agent, task, report });
    const reply = capReply(outcome.reply);
    const line = `status: ${outcome.ok ? "done" : "failed"}`;
    return outcome.ok ? `${line}\n${reply}` : `${line}\n${reply}\ncheck: ${outcome.evidence}`;
  }

  private async runChild(job: ChildJob): Promise<{ ok: boolean; reply: string; evidence: string }> {
    const { role, taskId, agent, task, report } = job;
    const channel = this.d.channelFor(agent.channel);
    const engine = (this.d.engineFor ?? defaultEngineFor)(channel.cfg.type);
    const base = projectTools(this.d.host, this.d.paths).for(role);
    const tools = new ToolRegistry([...base.tools, loadSkillTool(this.d.config().skills)]);
    const transcript: ChatMessage[] = [{ role: "user", content: task }];
    const writes: WriteRecord[] = [];
    const c: ChildCtx = { ...this.d, role, taskId, agent, ledger: this.d.ledger };
    let reason = "stop";
    let engineErr: string | undefined;
    const turn = {
      sessionId: `${this.d.sessionId}/${taskId}`,
      transcript,
      system: await systemPrompt(this.d.host, role, this.d.config()),
      agent,
      channel,
      tools,
      approve: this.childApprove(role),
      state: {},
      cwd: this.d.paths.base,
      signal: this.d.parent.controller.signal,
      maxTurns: role.turnBudget === "unlimited" ? 200 : role.turnBudget,
    };
    try {
      for await (const ev of engine.run(turn)) await this.onChildEvent(ev, c, writes);
    } catch (e) {
      reason = "error";
      engineErr = err(e);
    }
    return this.finishChild(job, transcript, writes, { reason, engineErr });
  }

  private async finishChild(
    job: ChildJob,
    transcript: ChatMessage[],
    writes: WriteRecord[],
    fin: { reason: string; engineErr?: string },
  ): Promise<{ ok: boolean; reply: string; evidence: string }> {
    const { role, taskId, report } = job;
    const reply = lastReply(transcript);
    const input: CheckInput = { reply, writes, changed: [...new Set(writes.filter((w) => w.ok).map((w) => w.path))] };
    const check = { ...turnCheck(input), cites: roleIsReadOnly(role), ...(report === "health" ? { schema: "health" as const } : {}) };
    const res = await runCheck({ check, input, host: this.d.host, cwd: this.d.paths.base });
    await this.persistChild(taskId, transcript);
    const ok = fin.reason === "stop" && res.passed;
    if (ok && report === "health") this.keepReport(taskId, reply);
    const evidence = fin.engineErr ?? res.evidence.join("; ");
    this.d.bus.emit({ kind: "check.result", runId: this.d.runId, taskId, roleId: role.id, passed: res.passed, evidence: res.evidence });
    if (ok) this.d.bus.emit({ kind: "task.done", runId: this.d.runId, taskId, roleId: role.id, summary: reply.split("\n")[0] ?? "" });
    else this.d.bus.emit({ kind: "task.failed", runId: this.d.runId, taskId, roleId: role.id, error: evidence });
    return { ok, reply, evidence };
  }

  private keepReport(taskId: string, reply: string): void {
    const block = [...reply.matchAll(JSON_BLOCK)][0];
    if (!block) return;
    try {
      this.reports.set(taskId, JSON.parse(block[1]) as HealthReport);
    } catch {
      /* invalid JSON cannot reach here: the schema check already passed */
    }
  }

  private async persistChild(taskId: string, transcript: ChatMessage[]): Promise<void> {
    try {
      await this.d.host.files.writeAtomic(`${this.d.stateDir}/sessions/${this.d.sessionId}/${taskId}.json`, JSON.stringify(transcript));
    } catch (e) {
      this.d.host.log(`child transcript save failed: ${err(e)}`);
    }
  }

  private async healthReport(): Promise<string> {
    if (!this.reports.size) throw new Error("no health reports in this run");
    const merged = mergeReports([...this.reports.values()]);
    const rendered = renderReport(aggregate(merged), merged, "issues", await this.measure(merged));
    const path = `.stewart/reports/health-${this.d.runId}.md`;
    await this.d.host.files.writeAtomic(path, rendered);
    return `${rendered}\n\nReport: ${path}`;
  }

  private async measure(report: HealthReport): Promise<string | undefined> {
    const metrics: FileMetrics[] = [];
    for (const f of report.files) {
      try {
        metrics.push(scanMetrics(f.path, (await this.d.host.files.read(f.path)).content));
      } catch {
        /* unreadable files stay unmeasured */
      }
    }
    return metrics.length ? renderMetricsSummary(summarizeMetrics(metrics)) : undefined;
  }
}
