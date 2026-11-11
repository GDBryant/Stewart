import type { RoleDef } from "@stewart/config";
import type { RunRuntime } from "@stewart/run-contract";
import { planGatePrompt } from "./prompts.js";

/** Plan-phase state of one run: the submitted plan, validator verdicts, replan budget and the plan gate. */
export class PlanVerbs {
  private replans = 0;
  private milestoneCount = 0;
  private approved = false;

  constructor(
    private readonly rt: RunRuntime,
    private readonly orchestrator: RoleDef,
  ) {}

  /** True once a validator approved the plan (or the gate was off and the verdict was approve). */
  get isApproved(): boolean {
    return this.approved;
  }

  submitPlan(args: { milestones: { title: string; acceptance?: string }[] }): string {
    this.milestoneCount = args.milestones?.length ?? 0;
    this.rt.bus.emit({ kind: "plan.created", runId: this.rt.runId, milestoneCount: this.milestoneCount });
    return `Plan recorded with ${this.milestoneCount} milestone(s). Dispatch the plan-validator role next, then implementation tasks.`;
  }

  async submitVerdict(args: { verdict: "approve" | "revise"; reasons?: string[] }): Promise<string> {
    const rt = this.rt;
    rt.bus.emit({ kind: "plan.validated", runId: rt.runId, verdict: args.verdict, reasons: args.reasons ?? [] });
    if (args.verdict !== "approve") return this.replan(args.reasons);
    if (rt.planGate && !this.approved) {
      const o = await rt.prompt(planGatePrompt(this.milestoneCount), { roleId: this.orchestrator.id });
      if (o.kind === "withdrawn") return "Plan not approved: prompt withdrawn.";
      if (o.value.kind === "revise") return this.replan([o.value.reason]);
    }
    this.approved = true;
    rt.bus.emit({ kind: "plan.approved", runId: rt.runId, milestoneCount: this.milestoneCount });
    return "Verdict recorded: approved. Proceed with implementation dispatches.";
  }

  private replan(reasons: string[] | undefined): string {
    this.replans++;
    if (this.replans > this.rt.maxReplans) {
      return `Verdict recorded: revise, but the replan limit (${this.rt.maxReplans}) is reached. Proceed with the best plan available and report the open risks.`;
    }
    return `Verdict recorded: revise (${this.replans}/${this.rt.maxReplans}). Re-dispatch the planner with these reasons: ${(reasons ?? []).join("; ")}`;
  }
}
