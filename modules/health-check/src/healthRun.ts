import { aggregate, mergeReports, renderMetricsSummary, renderReport, scanMetrics, summarizeMetrics, type FileMetrics, type HealthReport } from "@stewart/code-health";
import type { FeatureRun, FeatureRuntime, RunView } from "@stewart/run-contract";
import type { Tool } from "@stewart/tools";
import { healthReportTool, submitHealthTool } from "./healthTools.js";

/** The role id whose dispatched tasks produce health reports. */
export const HEALTH_REVIEWER_ROLE = "code-health-reviewer";

/** True once a task can no longer submit (undefined status counts as final: the host did not report one). */
const isFinal = (status?: string): boolean => status === undefined || !["pending", "running", "waiting", "blocked"].includes(status);

/** Per-run health state: reports recorded by reviewer tasks (keyed by task id) and the merge into one report. */
export class HealthRun implements FeatureRun {
  private readonly reports = new Map<string, HealthReport>();

  constructor(
    private readonly rt: FeatureRuntime,
    private readonly view: RunView,
  ) {}

  orchestratorTools(): Tool[] {
    return [
      healthReportTool((args) => this.report(args)),
      submitHealthTool(() => "Health reports are submitted by dispatched reviewer tasks."),
    ];
  }

  taskTools(taskId: string): Tool[] {
    return [
      submitHealthTool((report) => this.submit(taskId, report)),
      healthReportTool(() => "Reports are aggregated by the Orchestrator."),
    ];
  }

  private submit(taskId: string, report: HealthReport): string {
    this.reports.set(taskId, report);
    if (report.files.length === 0 && report.checks?.length) return `Project checks recorded: ${report.checks.length}`;
    const a = aggregate(mergeReports([report]));
    const worst = a.worst ? `, worst ${a.worst.path} ${a.worst.score}/10` : "";
    const checks = report.checks?.length ? `, checks ${report.checks.length}` : "";
    return `Health report recorded: ${a.files} files, mean ${a.score}/10${worst}${checks}`;
  }

  private async report(args: { mode?: "score" | "issues" }): Promise<string> {
    const unreported = this.view.tasks().filter((t) => t.roleId === HEALTH_REVIEWER_ROLE && !this.reports.has(t.id));
    if (this.reports.size === 0 && unreported.length === 0) return "No health reports recorded.";
    const merged = mergeReports([...this.reports.values()]);
    const label = (t: { title: string; status?: string }) => (isFinal(t.status) ? t.title : `${t.title} (still running)`);
    const report: HealthReport = { ...merged, notChecked: [...merged.notChecked, ...unreported.map(label)] };
    const running = unreported.filter((t) => !isFinal(t.status)).length;
    const note = running ? `\nPartial: ${running} reviewer task(s) still running; call health_report again after they finish.` : "";
    const rendered =
      this.reports.size === 0
        ? `No health reports recorded. Reviewer tasks without a report: ${unreported.map(label).join(", ")}.${note}`
        : renderReport(aggregate(report), report, args.mode ?? "issues", await this.measure(report)) + note;
    const path = `.stewart/scratch/health/${this.rt.runId}.md`;
    await this.rt.host.files.writeAtomic(path, rendered);
    if (rendered.length <= this.view.maxOutputChars) return rendered;
    const tail = `\n… truncated, see ${path}`;
    return rendered.slice(0, this.view.maxOutputChars - tail.length) + tail;
  }

  private async measure(report: HealthReport): Promise<string | undefined> {
    const metrics: FileMetrics[] = [];
    for (const f of report.files) {
      try {
        metrics.push(scanMetrics(f.path, (await this.rt.host.files.read(f.path)).content));
      } catch {}
    }
    return metrics.length ? renderMetricsSummary(summarizeMetrics(metrics)) : undefined;
  }
}
