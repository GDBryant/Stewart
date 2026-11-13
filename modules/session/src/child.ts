import type { AgentDef, RoleDef } from "@stewart/config";
import type { ChatMessage, Json } from "@stewart/kernel";
import type { ApproveFn } from "@stewart/permissions";
import { roleIsReadOnly, ToolRegistry, type Tool } from "@stewart/tools";
import { projectTools } from "@stewart/tools";
import { failureText } from "@stewart/tasks";
import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthReport } from "@stewart/code-health";
import { loadSkillTool } from "./sessionTools.js";
import { stepSaver } from "./stepSave.js";
import type { ChildDeps } from "./childTypes.js";
import { runFunctionTask } from "./functionTask.js";
import { systemPrompt } from "./lead.js";
import { policyApprove } from "./policyApprove.js";
import { lastReply } from "./turnState.js";
import { runTask, type Contract, type TaskResult } from "./taskRun.js";

function capReply(raw: string): string {
  if (raw.length <= REPLY_CAP) return raw;
  const head = Math.ceil(REPLY_CAP * 0.7);
  return `${raw.slice(0, head)}\n[reply truncated: ${raw.length - REPLY_CAP} chars omitted]\n${raw.slice(-Math.floor(REPLY_CAP * 0.3))}`;
}

const MAX_CHILDREN = 4;
const REPLY_CAP = 8000;
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;

/** Per-lead-run child runs behind the delegate/health_report tools. Depth 1: children never get these tools. */
interface ChildJob {
  role: RoleDef;
  taskId: string;
  task: string;
  report: "text" | "health";
  check?: DelegateCheck;
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

export class ChildRunner {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly reports = new Map<string, HealthReport>();
  /** Read/write lock: a waiting writer blocks later readers (FIFO); readers share. */
  private readers = 0;
  private writerActive = false;
  private readonly lockWaiters: { writer: boolean; grant: () => void }[] = [];

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
    return roleIsReadOnly(role) ? await this.asReader(run) : await this.asWriter(run);
  }

  private pump(): void {
    while (this.lockWaiters.length && !this.lockWaiters[0].writer) this.lockWaiters.shift()!.grant();
    if (this.lockWaiters[0]?.writer && this.readers === 0 && !this.writerActive) this.lockWaiters.shift()!.grant();
  }

  private acquireLock(writer: boolean): Promise<void> {
    const take = () => (writer ? void (this.writerActive = true) : void this.readers++);
    if (!this.writerActive && (writer ? this.readers === 0 : true) && !this.lockWaiters.length) {
      take();
      return Promise.resolve();
    }
    return new Promise<void>((r) => this.lockWaiters.push({ writer, grant: () => { take(); r(); } }));
  }

  private async asReader<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(false);
    try {
      return await fn();
    } finally {
      this.readers--;
      if (this.readers === 0) this.pump();
    }
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** One writer at a time: waits for running readers and blocks readers queued after it. */
  private async asWriter<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(true);
    try {
      return await fn();
    } finally {
      this.writerActive = false;
      this.pump();
    }
  }

  private checkReport(role: RoleDef, report: string): void {
    if (report !== "text" && report !== "health") throw new Error(`unknown report mode '${report}'`);
    if (report === "health" && !role.skills.includes("code-health")) {
      const able = this.d.config().roles.filter((r) => r.enabled && r.id !== "lead" && roleIsReadOnly(r) && r.skills.includes("code-health")).map((r) => r.id);
      throw new Error(`role '${role.id}' cannot report health (no code-health skill); use ${able.length ? able.join(", ") : "no configured role"}`);
    }
  }

  private childAgent(role: RoleDef): AgentDef | undefined {
    return this.d.config().agents.find((a) => a.id === role.agent) ?? this.d.agent;
  }

  private childApprove(role: RoleDef): ApproveFn {
    return policyApprove(role, this.d.permissions.gate(this.d.runId, this.d.parent.controller.signal));
  }

  private async childTurn(role: RoleDef, task: string, report: "text" | "health", check?: DelegateCheck): Promise<string> {
    const { bus, ids } = this.d;
    const taskId = ids.next("task");
    bus.emit({ kind: "task.created", runId: this.d.runId, taskId, roleId: role.id, title: task.slice(0, 80) });
    bus.emit({ kind: "task.started", runId: this.d.runId, taskId, roleId: role.id, agentId: this.childAgent(role)?.id ?? "" });
    const res = await this.runChild({ role, taskId, task, report, check });
    const reply = capReply(res.reply);
    const line = `status: ${res.status === "done" ? "done" : "failed"}`;
    return res.status === "done" ? `${line}\n${reply}` : `${line}\n${reply}\ncheck: ${res.error ?? "failed"}`;
  }

  private contract(job: ChildJob): () => Contract {
    const writable = !roleIsReadOnly(job.role);
    return () => ({
      commands: [
        ...(writable ? this.d.config().project.verify.map((argv) => ({ argv, approved: false, whenChanged: true })) : []),
        ...(job.check?.command ? [{ argv: job.check.command, approved: false }] : []),
      ],
      files: job.check?.files ?? [],
    });
  }

  private async runChild(job: ChildJob): Promise<TaskResult> {
    const { role, taskId, task, report } = job;
    const ro = roleIsReadOnly(role);
    const transcript: ChatMessage[] = [{ role: "user", content: task }];
    const stepSave = stepSaver(() => this.persistChild(taskId, transcript));
    stepSave();
    const tools = new ToolRegistry([...projectTools(this.d.host, this.d.paths).for(role).tools, loadSkillTool(this.d.config().skills)]);
    const res = await runTask(
      {
        runId: this.d.runId,
        taskId,
        sessionId: `${this.d.sessionId}/${taskId}`,
        role,
        goal: task,
        transcript,
        system: () => systemPrompt(this.d.host, role, this.d.config()),
        tools,
        approve: this.childApprove(role),
        engineState: {},
        contract: this.contract(job),
        needs: { cites: ro, needsRead: ro, ...(report === "health" ? { schema: "health" as const } : {}) },
        interactive: false,
        run: this.d.parent,
        onStep: stepSave,
      },
      this.d,
    );
    return this.finishChild(job, transcript, res);
  }

  private async finishChild(job: ChildJob, transcript: ChatMessage[], res: TaskResult): Promise<TaskResult> {
    const { role, taskId, report } = job;
    await this.persistChild(taskId, transcript);
    const ok = res.status === "done";
    if (ok && report === "health") this.keepReport(taskId, res.reply);
    if (ok) this.d.bus.emit({ kind: "task.done", runId: this.d.runId, taskId, roleId: role.id, summary: res.reply.split("\n")[0] ?? "" });
    else this.d.bus.emit({ kind: "task.failed", runId: this.d.runId, taskId, roleId: role.id, error: res.error ?? "failed" });
    return res;
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
      this.d.host.log(`child transcript save failed: ${e instanceof Error ? e.message : String(e)}`);
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
