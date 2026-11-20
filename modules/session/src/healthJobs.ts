import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthCoverage, type HealthReport } from "@stewart/code-health";
import type { ChildDeps, ChildJob } from "./childTypes.js";
import type { TaskResult } from "./taskRun.js";

const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/g;

interface HealthJob {
  job: ChildJob;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
}

/** Health-report bookkeeping for one lead run: per-job status, kept worker reports, coverage and the merged report. */
export class HealthTracker {
  private readonly reports = new Map<string, HealthReport>();
  private readonly jobs = new Map<string, HealthJob>();

  constructor(private readonly d: ChildDeps) {}

  start(job: ChildJob): void {
    if (job.report === "health") this.jobs.set(job.taskId, { job, status: "running" });
  }

  keep(taskId: string, reply: string): void {
    const block = [...reply.matchAll(JSON_BLOCK)][0];
    if (!block) return;
    try {
      this.reports.set(taskId, JSON.parse(block[1]) as HealthReport);
    } catch {
      /* invalid JSON cannot reach here: the schema check already passed */
    }
  }

  fail(job: ChildJob, error: string): void {
    const j = this.jobs.get(job.taskId);
    if (j) {
      j.status = "failed";
      j.error = error;
    }
  }

  mark(job: ChildJob, res: TaskResult): void {
    const j = this.jobs.get(job.taskId);
    if (j) j.status = res.status;
    if (j && res.status !== "done") j.error = res.error ?? res.reason ?? "failed";
  }

  private coverage(): HealthCoverage {
    const jobs = [...this.jobs.values()];
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
    if (!this.jobs.size) return undefined;
    const c = this.coverage();
    return c.status === "partial" ? `health coverage partial: ${c.checked.length}/${c.declared.length} scopes checked, ${c.failed.length} delegated task(s) failed` : undefined;
  }

  async report(): Promise<string> {
    if (!this.reports.size && !this.jobs.size) throw new Error("no health reports in this run");
    const merged = mergeReports([...this.reports.values()]);
    const coverage = this.coverage();
    merged.notChecked = [...new Set([...merged.notChecked, ...coverage.missing])];
    const rendered = renderReport(aggregate(merged), merged, "issues", { measured: await this.measure(merged), coverage });
    const path = `.stewart/reports/health-${this.d.runId}.md`;
    await this.d.host.files.writeAtomic(path, rendered);
    const running = [...this.jobs.values()].filter((j) => j.status === "running").length;
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
