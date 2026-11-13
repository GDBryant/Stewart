import type { HostPort, Json } from "@stewart/kernel";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { Tool, ProjectPaths } from "@stewart/tools";
import { currentMilestone, parsePlan, renderPlan, type Baseline, type ChangeTracker, type Milestone, type Plan } from "@stewart/tasks";
import type { RunEvent } from "@stewart/protocol";

export interface PlanDeps {
  host: HostPort;
  paths: ProjectPaths;
  stateDir: string;
  sessionId: string;
  runId: string;
  bus: { emit(ev: RunEvent): void };
  interaction: Interaction;
  /** Shared change tracker (calls serialize): plan baseline and milestone checkpoints are baselines. */
  tracker: ChangeTracker;
}

interface PlanState {
  plan: Plan;
  /** Baseline id of the approved-plan checkpoint ("start"). */
  baseline: string;
}

/** Plan facts for history.load. */
export interface PlanSummary {
  goal: string;
  status: string;
  milestones: Milestone[];
}

/** Owns `.stewart/plans/<sessionId>.md`: plan_write, baseline, milestone checkpoints, revert, resume. */
export class PlanRunner {
  private st?: PlanState;
  private loaded = false;

  constructor(private readonly d: PlanDeps) {}

  private planFile(): string {
    return `${this.d.paths.base}/.stewart/plans/${this.d.sessionId}.md`;
  }

  private baselineFile(): string {
    return `${this.d.stateDir}/sessions/${this.d.sessionId}.plan`;
  }

  async save(): Promise<void> {
    if (this.st) await this.d.host.files.writeAtomic(this.planFile(), renderPlan(this.st.plan));
  }

  private async load(): Promise<PlanState | undefined> {
    if (this.st || this.loaded) return this.st;
    this.loaded = true;
    try {
      const plan = parsePlan((await this.d.host.files.read(this.planFile())).content);
      if (plan.sessionId !== this.d.sessionId) return undefined;
      const baseline = ((await this.d.host.files.readLines(this.baselineFile()))[0] ?? "").trim();
      this.st = { plan, baseline };
    } catch {
      return undefined;
    }
    return this.st;
  }

  async state(): Promise<PlanState | undefined> {
    return await this.load();
  }

  async summary(): Promise<PlanSummary | undefined> {
    const st = await this.load();
    return st ? { goal: st.plan.goal, status: st.plan.status, milestones: st.plan.milestones } : undefined;
  }

  /** Appended to the lead system prompt while a plan is unfinished. */
  async systemNote(): Promise<string | undefined> {
    const st = await this.load();
    if (!st || st.plan.status === "done") return undefined;
    return `\n\n# Plan (${st.plan.status})\n${renderPlan(st.plan).slice(0, 4000)}`;
  }

  /** Baseline id the next milestone's diff should start from: last done milestone's checkpoint, else the plan baseline. */
  nextBaseline(st: PlanState): string {
    return [...st.plan.milestones].reverse().find((m) => m.status === "done" && m.checkpoint)?.checkpoint ?? st.baseline;
  }

  /** Baseline object for a stored id. */
  async baselineFor(id: string): Promise<Baseline> {
    return await this.d.tracker.baseline(id);
  }

  async pause(): Promise<void> {
    const st = await this.load();
    if (st && st.plan.status !== "done") {
      st.plan.status = "paused";
      await this.save();
    }
  }

  /** Resume: re-activate the plan and reset a failed current milestone to pending. */
  async resumePlan(): Promise<Plan | undefined> {
    const st = await this.load();
    if (!st || st.plan.status === "done") return undefined;
    const m = currentMilestone(st.plan);
    if (m?.status === "failed") m.status = "pending";
    st.plan.status = "active";
    await this.save();
    return st.plan;
  }

  /** Checkpoint ids for revert: explicit id > latest milestone checkpoint > baseline. */
  async checkpoints(): Promise<{ latest?: string; baseline?: string; byMilestone: Record<string, string> }> {
    const st = await this.load();
    const byMilestone: Record<string, string> = {};
    if (st) for (const m of st.plan.milestones) if (m.checkpoint) byMilestone[m.id] = m.checkpoint;
    const latest = st?.plan.milestones.filter((m) => m.checkpoint).map((m) => m.checkpoint).pop();
    return { latest, baseline: st?.baseline || undefined, byMilestone };
  }

  async revertTo(id: string | undefined): Promise<{ restored: string[]; deleted: string[] } | undefined> {
    const cps = await this.checkpoints();
    const target = id === "baseline" ? cps.baseline : id ?? cps.latest;
    if (!target) return undefined;
    const out = await this.d.tracker.restore(await this.d.tracker.baseline(target));
    await this.resetAfter(target);
    return out;
  }

  /** Milestones after the restored checkpoint are pending again; the plan pauses (the baseline resets all of them). */
  private async resetAfter(target: string): Promise<void> {
    const st = this.st;
    if (!st) return;
    const keep = st.plan.milestones.findIndex((m) => m.checkpoint === target);
    st.plan.milestones.forEach((m, i) => {
      if (i <= keep) return;
      m.status = "pending";
      m.checkpoint = undefined;
    });
    if (st.plan.status !== "done") st.plan.status = "paused";
    await this.save();
  }

  /** Milestone passed: new checkpoint, milestone done, save. */
  async markDone(m: Milestone): Promise<string> {
    const st = this.st!;
    const b = await this.d.tracker.begin(m.id);
    m.status = "done";
    m.checkpoint = b.id;
    this.d.bus.emit({ kind: "milestone.done", runId: this.d.runId, roleId: "lead", milestoneId: m.id });
    if (!currentMilestone(st.plan)) st.plan.status = "done";
    await this.save();
    return b.id;
  }

  /** Milestone failed: milestone failed, plan paused. */
  async markFailed(m: Milestone, error: string): Promise<void> {
    const st = this.st!;
    m.status = "failed";
    st.plan.status = "paused";
    this.d.bus.emit({ kind: "milestone.failed", runId: this.d.runId, roleId: "lead", milestoneId: m.id, error });
    await this.save();
  }

  tools(): Tool[] {
    return [this.planWriteTool()];
  }

  private planWriteTool(): Tool {
    return {
      spec: {
        name: "plan_write",
        description: "Write the milestone plan for multi-step work and ask the user to approve it.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            goal: { type: "string" },
            milestones: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  detail: { type: "string" },
                  check: {
                    type: "object",
                    additionalProperties: false,
                    properties: { command: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } } },
                  },
                },
                required: ["title", "check"],
              },
            },
          },
          required: ["goal", "milestones"],
        },
      },
      requiresApproval: false,
      awaitsUser: true,
      execute: async (args, _p, signal) => this.writePlan(args, signal),
    };
  }

  private async writePlan(args: Json, signal: AbortSignal): Promise<string> {
    const input = args.milestones as { title: string; detail?: string; check?: { command?: string[]; files?: string[] } }[] | undefined;
    if (!Array.isArray(input) || input.length === 0) throw new Error("milestones must be a non-empty array");
    const milestones: Milestone[] = input.map((m, i) => {
      const check = m.check ?? {};
      if (!check.command?.length && !check.files?.length) throw new Error(`milestone ${i + 1} '${m.title}' needs a check command or files`);
      return { id: `M${i + 1}`, title: String(m.title), detail: m.detail ?? "", check, status: "pending" as const };
    });
    const plan: Plan = { goal: String(args.goal ?? ""), status: "active", sessionId: this.d.sessionId, milestones };
    const text = renderPlan(plan);
    const o = await this.d.interaction.ask(questionPrompt("plan_write", `Approve this plan?\n\n${text}`, ["Approve", "Revise"]), { runId: this.d.runId, roleId: "lead" }, signal);
    if (o.kind !== "answered" || o.value !== "Approve") return `not approved: ${o.kind === "answered" ? o.value : o.kind}`;
    const baseline = await this.d.tracker.begin("start");
    this.st = { plan, baseline: baseline.id };
    await this.save();
    await this.d.host.files.writeAtomic(this.baselineFile(), `${baseline.id}\n`);
    this.d.bus.emit({ kind: "plan.approved", runId: this.d.runId, roleId: "lead", milestoneCount: milestones.length });
    return "Plan approved. Stop now: Stewart will give you each milestone in turn.";
  }
}
