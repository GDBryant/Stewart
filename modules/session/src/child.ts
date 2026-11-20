import type { AgentDef, RoleDef } from "@stewart/config";
import { eligibleChain } from "@stewart/roles-skills";
import type { ChatMessage, Json } from "@stewart/kernel";
import type { ApproveFn } from "@stewart/permissions";
import { roleIsReadOnly, ToolRegistry, type Tool } from "@stewart/tools";
import { projectTools } from "@stewart/tools";
import { failureText, healthReportInstruction } from "@stewart/tasks";
import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthCoverage, type HealthReport } from "@stewart/code-health";
import { loadSkillTool } from "./sessionTools.js";
import { stepSaver } from "./stepSave.js";
import type { ChildDeps } from "./childTypes.js";
import { runFunctionTask } from "./functionTask.js";
import { systemPrompt } from "./lead.js";
import { policyApprove } from "./policyApprove.js";
import { err, lastReply } from "./turnState.js";
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
  scope?: string[];
}

type ChildRequest = Omit<ChildJob, "taskId">;

interface HealthJob {
  job: ChildJob;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
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
  private readonly healthJobs = new Map<string, HealthJob>();
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
            scope: { type: "array", items: { type: "string" }, description: "Health report scope entries: path or path:start-end" },
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

  private childRequest(args: Json): ChildRequest {
    const roleId = String(args.role ?? "");
    const role = this.d.config().roles.find((r) => r.id === roleId);
    if (!role || role.id === "lead" || !role.enabled) throw new Error(`unknown delegate role '${roleId}'`);
    const report = args.report === undefined ? "text" : String(args.report);
    this.checkReport(role, report);
    const scope = strings(args.scope);
    if (report === "health" && roleIsReadOnly(role) && !scope?.length) throw new Error("health report needs scope entries");
    return { role, task: String(args.task ?? ""), report: report as "text" | "health", check: parseCheck(args.check), scope };
  }

  private async delegate(args: Json): Promise<string> {
    const req = this.childRequest(args);
    if (req.role.kind === "function") return await this.limited(() => this.admitted(req.role, () => runFunctionTask(this.d, req.role, req.task, functionSchema(args.schema))));
    const run = () => this.limited(() => this.childTurn(req));
    return roleIsReadOnly(req.role) ? await this.asReader(run) : await this.asWriter(run);
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
    if (report === "health" && role.kind === "function") throw new Error(`role '${role.id}' cannot report health`);
    if (report === "health" && roleIsReadOnly(role) && !role.skills.includes("code-health")) {
      const able = this.d.config().roles.filter((r) => r.enabled && r.id !== "lead" && roleIsReadOnly(r) && r.skills.includes("code-health")).map((r) => r.id);
      throw new Error(`role '${role.id}' cannot report health (no code-health skill); use ${able.length ? able.join(", ") : "no configured role"}`);
    }
  }

  private childAgent(role: RoleDef): AgentDef | undefined {
    const cfg = this.d.config();
    return eligibleChain(role, cfg.roles, cfg.agents, cfg.channels)[0] ?? this.d.agent;
  }

  /** Holds one admission slot on the role's channel for the whole task, so a channel with maxParallel N never has more than N delegated tasks running (the rest wait as pending). */
  private async admitted<T>(role: RoleDef, fn: () => Promise<T>): Promise<T> {
    const release = await this.admitChannel(role);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async admitChannel(role: RoleDef): Promise<() => void> {
    try {
      const agent = this.childAgent(role);
      return agent ? await this.d.channelFor(agent.channel).admit() : () => {};
    } catch {
      return () => {}; // unknown channel: the run itself reports it
    }
  }

  private childApprove(role: RoleDef): ApproveFn {
    return policyApprove(role, this.d.permissions.gate(this.d.runId, this.d.parent.controller.signal));
  }

  private async childTurn(req: ChildRequest): Promise<string> {
    const { bus, ids } = this.d;
    const { role, task } = req;
    const taskId = ids.next("task");
    bus.emit({ kind: "task.created", runId: this.d.runId, taskId, roleId: role.id, title: task.slice(0, 80) });
    let res: TaskResult;
    try {
      res = await this.admitted(role, () => {
        bus.emit({ kind: "task.started", runId: this.d.runId, taskId, roleId: role.id, agentId: this.childAgent(role)?.id ?? "" });
        return this.runChild({ ...req, taskId });
      });
    } catch (e) {
      bus.emit({ kind: "task.failed", runId: this.d.runId, taskId, roleId: role.id, error: err(e) });
      throw e;
    }
    const reply = capReply(res.reply);
    const line = `status: ${res.status === "done" ? "done" : "failed"}`;
    if (res.status === "done") return `${line}\n${reply}`;
    const check = `check: ${res.error ?? "failed"}`;
    return req.report === "health" ? `${line}\n${check}\nWorker output failed validation; call health_report for merged coverage.` : `${line}\n${reply}\n${check}`;
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
    if (report === "health") this.healthJobs.set(taskId, { job, status: "running" });
    const taskText = report === "health" ? `${healthReportInstruction(job.scope)}

${task}` : task;
    const transcript: ChatMessage[] = [{ role: "user", content: taskText }];
    const stepSave = stepSaver(() => this.persistChild(taskId, transcript));
    stepSave();
    const tools = new ToolRegistry([...projectTools(this.d.host, this.d.paths).for(role).tools, loadSkillTool(this.d.config().skills)]);
    let res: TaskResult;
    try {
      res = await runTask(
        {
          runId: this.d.runId,
          taskId,
          sessionId: `${this.d.sessionId}/${taskId}`,
          role,
          goal: taskText,
          transcript,
          system: () => systemPrompt(this.d.host, role, this.d.config()),
          tools,
          approve: this.childApprove(role),
          engineState: {},
          contract: this.contract(job),
          needs: { cites: ro, needsRead: ro, ...(report === "health" ? { schema: "health" as const, healthScope: job.scope ?? [] } : {}) },
          interactive: false,
          run: this.d.parent,
          onStep: stepSave,
        },
        this.d,
      );
    } catch (e) {
      this.failHealthJob(job, err(e));
      throw e;
    }
    return this.finishChild(job, transcript, res);
  }

  private async finishChild(job: ChildJob, transcript: ChatMessage[], res: TaskResult): Promise<TaskResult> {
    const { role, taskId, report } = job;
    await this.persistChild(taskId, transcript);
    const ok = res.status === "done";
    if (ok && report === "health") this.keepReport(taskId, res.reply);
    this.markHealthJob(job, res);
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

  private failHealthJob(job: ChildJob, error: string): void {
    const j = this.healthJobs.get(job.taskId);
    if (j) {
      j.status = "failed";
      j.error = error;
    }
  }

  private markHealthJob(job: ChildJob, res: TaskResult): void {
    const j = this.healthJobs.get(job.taskId);
    if (j) j.status = res.status;
    if (j && res.status !== "done") j.error = res.error ?? res.reason ?? "failed";
  }

  private async persistChild(taskId: string, transcript: ChatMessage[]): Promise<void> {
    try {
      await this.d.host.files.writeAtomic(`${this.d.stateDir}/sessions/${this.d.sessionId}/${taskId}.json`, JSON.stringify(transcript));
    } catch (e) {
      this.d.host.log(`child transcript save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private coverage(): HealthCoverage {
    const jobs = [...this.healthJobs.values()];
    const declared = [...new Set(jobs.flatMap((j) => j.job.scope ?? []))];
    const checked = [...new Set(jobs.filter((j) => j.status === "done").flatMap((j) => j.job.scope ?? []))];
    const failed = jobs.filter((j) => j.status !== "done").map((j) => ({ taskId: j.job.taskId, title: j.job.task, error: j.error ?? j.status }));
    const done = new Set(checked);
    const missing = declared.filter((s) => !done.has(s));
    const checkFailed = jobs.some((j) => j.status !== "done" && !j.job.scope?.length);
    return { status: missing.length || checkFailed ? "partial" : declared.length ? "complete" : "unknown", declared, checked, missing, failed };
  }

  /** Why the run is not a complete health check, or undefined when coverage is complete or no health tasks ran. */
  healthVerdict(): string | undefined {
    if (!this.healthJobs.size) return undefined;
    const c = this.coverage();
    return c.status === "partial" ? `health coverage partial: ${c.checked.length}/${c.declared.length} scopes checked, ${c.failed.length} delegated task(s) failed` : undefined;
  }

  private async healthReport(): Promise<string> {
    if (!this.reports.size && !this.healthJobs.size) throw new Error("no health reports in this run");
    const merged = mergeReports([...this.reports.values()]);
    const coverage = this.coverage();
    merged.notChecked = [...new Set([...merged.notChecked, ...coverage.missing])];
    const rendered = renderReport(aggregate(merged), merged, "issues", { measured: await this.measure(merged), coverage });
    const path = `.stewart/reports/health-${this.d.runId}.md`;
    await this.d.host.files.writeAtomic(path, rendered);
    const running = [...this.healthJobs.values()].filter((j) => j.status === "running").length;
    const note = running ? `\n${running} delegated health task(s) still running; call health_report again after they finish for the final report.` : "";
    return `${rendered}\n\nReport: ${path}${note}`;
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
