import type { AgentDef, RoleDef } from "@stewart/config";
import type { RunLedger } from "@stewart/ledger";
import type { ChatMessage, Json } from "@stewart/kernel";
import type { ApproveFn } from "@stewart/permissions";
import { roleIsReadOnly, ToolRegistry, type Tool } from "@stewart/tools";
import { projectTools } from "@stewart/tools";
import type { EngineEvent, WriteRecord } from "@stewart/engines";
import { engineFor as defaultEngineFor } from "@stewart/engines";
import { runCheck, turnCheck, type CheckInput } from "@stewart/tasks";
import { eligibleChain } from "@stewart/roles-skills";
import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthReport } from "@stewart/code-health";
import { loadSkillTool } from "./sessionTools.js";
import { recordUsage } from "./usage.js";
import type { ChildDeps } from "./childTypes.js";
import { runFunctionTask } from "./functionTask.js";
import { systemPrompt } from "./lead.js";
import { handoverText, type Tried } from "./handover.js";
import { rolePolicyDeny } from "./childPolicy.js";
import { isReadTool, snapshotBefore } from "./turnState.js";

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

interface ChildCtx extends ChildDeps {
  role: RoleDef;
  taskId: string;
  agent: AgentDef;
  ledger: RunLedger;
  tried: Tried[];
  /** Pre-write content per path (the content-changed check) and successful read calls. */
  facts: ChildFacts;
  fin?: { reason: string; error?: string };
}

/** Per-job facts the child check needs. */
interface ChildFacts {
  before: Record<string, string | null>;
  reads: number;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capReply(raw: string): string {
  if (raw.length <= REPLY_CAP) return raw;
  const head = Math.ceil(REPLY_CAP * 0.7);
  return `${raw.slice(0, head)}\n[reply truncated: ${raw.length - REPLY_CAP} chars omitted]\n${raw.slice(-Math.floor(REPLY_CAP * 0.3))}`;
}

/** Per-lead-run child runs behind the delegate/health_report tools. Depth 1: children never get these tools. */
interface ChildJob {
  role: RoleDef;
  taskId: string;
  agent: AgentDef;
  task: string;
  report: "text" | "health";
  check?: DelegateCheck;
}

/** One delegated job's mutable run state across escalation attempts. */
interface ChildRun {
  transcript: ChatMessage[];
  writes: WriteRecord[];
  tried: Tried[];
  facts: ChildFacts;
}

/** What code verifies after a delegated task: files that must exist, a command that must exit 0. */
export interface DelegateCheck {
  files?: string[];
  command?: string[];
}

function strings(v: unknown): string[] | undefined {
  const out = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  return out.length ? out : undefined;
}

function functionSchema(raw: unknown): Json {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("function roles need a schema (JSON Schema object) argument");
  return raw as Json;
}

/** Parse the `check` argument of `delegate`; absent = none. */
function parseCheck(raw: unknown): DelegateCheck | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("check must be an object {files?, command?}");
  const c = raw as Record<string, unknown>;
  const out = { files: strings(c.files), command: strings(c.command) };
  return out.files || out.command ? out : undefined;
}

/** Match the outcome to its call by id; count successful reads for the "no findings" rule. */
function onChildOutcome(ev: Extract<EngineEvent, { kind: "tool.outcome" }>, c: ChildCtx): void {
  const t = c.tried.find((x) => x.callId === ev.callId);
  if (!t) return;
  t.ok = ev.ok;
  if (ev.ok && isReadTool(t.name)) c.facts.reads++;
}

export class ChildRunner {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly reports = new Map<string, HealthReport>();
  /** Tail of the writer queue: children whose role can write run one at a time. */
  private writerTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ChildDeps) {}

  delegateTool(): Tool {
    const roles = this.d.config().roles.filter((r) => r.enabled && r.id !== "lead").map((r) => r.id);
    return {
      spec: {
        name: "delegate",
        description: "Delegate a task to another role and get its report. Read-only roles run in parallel; roles that can write run one at a time. `check` is verified by code afterwards: files that must exist, a command (argv) that must exit 0.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: roles.length ? roles : ["_none_"] },
            task: { type: "string" },
            report: { type: "string", enum: ["text", "health"] },
            schema: { type: "object", description: "Required for roles of kind function: the JSON Schema of the object they return." },
            check: {
              type: "object",
              additionalProperties: false,
              properties: { files: { type: "array", items: { type: "string" } }, command: { type: "array", items: { type: "string" } } },
            },
          },
          required: ["role", "task"],
        },
      },
      requiresApproval: false,
      parallel: true,
      noTimeout: true,
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
    this.checkReport(role, report);
    if (role.kind === "function") return await this.limited(() => runFunctionTask(this.d, role, String(args.task ?? ""), functionSchema(args.schema)));
    const check = parseCheck(args.check);
    const run = () => this.limited(() => this.childTurn(role, String(args.task ?? ""), report as "text" | "health", check));
    return roleIsReadOnly(role) ? await run() : await this.asWriter(run);
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** One writer at a time: queue behind every earlier write-capable child. */
  private asWriter<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writerTail.then(fn, fn);
    this.writerTail = result.catch(() => undefined);
    return result;
  }

  private checkReport(role: RoleDef, report: string): void {
    if (report !== "text" && report !== "health") throw new Error(`unknown report mode '${report}'`);
    if (report === "health" && !role.skills.includes("code-health")) {
      const able = this.d.config().roles.filter((r) => r.enabled && r.id !== "lead" && roleIsReadOnly(r) && r.skills.includes("code-health")).map((r) => r.id);
      throw new Error(`role '${role.id}' cannot report health (no code-health skill); use ${able.length ? able.join(", ") : "no configured role"}`);
    }
  }

  private childAgent(role: RoleDef): AgentDef {
    const bound = this.d.config().agents.find((a) => a.id === role.agent);
    return bound ?? this.d.agent;
  }

  private childApprove(role: RoleDef): ApproveFn {
    const gate = this.d.permissions.gate(this.d.runId, this.d.parent.controller.signal);
    return async (call, preview, meta) => {
      const deny = rolePolicyDeny(role, preview as { kind: string; path?: string; command?: string } | null);
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
        await this.onChildRequest(ev, c);
        return bus.emit({ kind: "tool.request", ...base, callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
      case "tool.outcome":
        onChildOutcome(ev, c);
        return bus.emit({ kind: "tool.outcome", ...base, callId: ev.callId, ok: ev.ok, summary: ev.summary });
      case "write":
        c.plan?.recordWrite(ev.record);
        return void writes.push(ev.record);
      case "usage":
        return recordUsage(ev, c);
      case "finished":
        c.fin = { reason: ev.reason, error: ev.error };
        return;
    }
  }

  private async onChildRequest(ev: Extract<EngineEvent, { kind: "tool.request" }>, c: ChildCtx): Promise<void> {
    await snapshotBefore({ host: c.host, cwd: c.paths.base, before: c.facts.before, onFirst: (p, content) => c.plan?.beforeWrite(p, content) }, ev.tool, ev.args);
    c.tried.push({ callId: ev.callId, name: ev.tool, args: JSON.stringify(ev.args ?? {}) });
  }

  private async childTurn(role: RoleDef, task: string, report: "text" | "health", check?: DelegateCheck): Promise<string> {
    const { host, bus, ids } = this.d;
    const taskId = ids.next("task");
    bus.emit({ kind: "task.created", runId: this.d.runId, taskId, roleId: role.id, title: task.slice(0, 80) });
    bus.emit({ kind: "task.started", runId: this.d.runId, taskId, roleId: role.id, agentId: this.childAgent(role).id });
    const outcome = await this.runChild({ role, taskId, agent: this.childAgent(role), task, report, check });
    const reply = capReply(outcome.reply);
    const line = `status: ${outcome.ok ? "done" : "failed"}`;
    return outcome.ok ? `${line}\n${reply}` : `${line}\n${reply}\ncheck: ${outcome.evidence}`;
  }

  private async runChild(job: ChildJob): Promise<{ ok: boolean; reply: string; evidence: string }> {
    const { role, taskId, task } = job;
    const cfg = this.d.config();
    const chain = eligibleChain(role, cfg.roles, cfg.agents, cfg.channels);
    const transcript: ChatMessage[] = [{ role: "user", content: task }];
    const writes: WriteRecord[] = [];
    const tried: Tried[] = [];
    const facts: ChildFacts = { before: {}, reads: 0 };
    let fin: { reason: string; engineErr?: string } = { reason: "error", engineErr: `no qualified agent for role ${role.id}: run Qualify in settings` };
    let res: { passed: boolean; evidence: string[] } = { passed: false, evidence: [fin.engineErr!] };
    let prev: AgentDef | undefined;
    for (const agent of chain) {
      const j = { ...job, agent };
      if (prev) {
        const reason = fin.engineErr ?? (fin.reason === "stop" ? res.evidence.join("; ") : fin.reason);
        transcript.push({ role: "user", content: handoverText(prev.id, task, tried, reason) });
        this.d.bus.emit({ kind: "run.escalated", runId: this.d.runId, taskId, roleId: role.id, from: prev.id, to: agent.id, reason });
      }
      fin = await this.attemptChild(j, { transcript, writes, tried, facts });
      if (fin.reason === "cancelled") {
        res = { passed: false, evidence: ["cancelled"] };
        break;
      }
      if (fin.reason === "stop") {
        res = await this.childCheck(j, { transcript, writes, tried, facts });
        if (res.passed) break;
      }
      prev = agent;
    }
    return this.finishChild(job, transcript, { fin, res });
  }

  private async attemptChild(job: ChildJob, run: ChildRun): Promise<{ reason: string; engineErr?: string }> {
    const { role, taskId, agent } = job;
    const { transcript, writes, tried, facts } = run;
    const channel = this.d.channelFor(agent.channel);
    const engine = (this.d.engineFor ?? defaultEngineFor)(channel.cfg.type);
    const base = projectTools(this.d.host, this.d.paths).for(role);
    const tools = new ToolRegistry([...base.tools, loadSkillTool(this.d.config().skills)]);
    const c: ChildCtx = { ...this.d, role, taskId, agent, ledger: this.d.ledger, tried, facts };
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
      return { reason: c.fin?.reason ?? "stop", engineErr: c.fin?.error };
    } catch (e) {
      return { reason: "error", engineErr: err(e) };
    }
  }

  private async childCheck(job: ChildJob, run: ChildRun): Promise<{ passed: boolean; evidence: string[] }> {
    const { role, report } = job;
    const { transcript, writes, facts } = run;
    const reply = lastReply(transcript);
    const input: CheckInput = { reply, writes, changed: [...new Set(writes.filter((w) => w.ok).map((w) => w.path))], before: facts.before, reads: facts.reads };
    const base = turnCheck(input);
    const declared = job.check;
    const check = {
      ...base,
      files: [...(base.files ?? []), ...(declared?.files ?? [])],
      cites: roleIsReadOnly(role),
      ...(report === "health" ? { schema: "health" as const } : {}),
    };
    const denied = declared?.command ? await this.commandDenied(job, declared.command) : undefined;
    if (denied) return { passed: false, evidence: [denied] };
    return await runCheck({ check: { ...check, command: declared?.command }, input, host: this.d.host, cwd: this.d.paths.base });
  }

  /** The check command runs real code, so it goes through the same approval gate as any command. */
  private async commandDenied(job: ChildJob, command: string[]): Promise<string | undefined> {
    const gate = this.d.permissions.gate(this.d.runId, this.d.parent.controller.signal);
    const call = { id: `check-${job.taskId}`, name: "delegate_check", arguments: { command } };
    const d = await gate(call, { kind: "command", command: command.join(" "), cwd: "." }, { roleId: job.role.id, taskId: job.taskId });
    return d.kind === "approved" ? undefined : `check command not approved: ${command.join(" ")}`;
  }

  private async finishChild(
    job: ChildJob,
    transcript: ChatMessage[],
    out: { fin: { reason: string; engineErr?: string }; res: { passed: boolean; evidence: string[] } },
  ): Promise<{ ok: boolean; reply: string; evidence: string }> {
    const { fin, res } = out;
    const { role, taskId, report } = job;
    const reply = lastReply(transcript);
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
