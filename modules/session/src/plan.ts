import type { HostPort, Json } from "@stewart/kernel";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { Tool, ProjectPaths } from "@stewart/tools";
import { currentMilestone, createCheckpoint, parsePlan, recordOriginal, renderPlan, revert as cpRevert, runCheck, type Milestone, type Plan, type WriteRecord } from "@stewart/tasks";
import type { RunEvent } from "@stewart/protocol";

export interface PlanDeps {
  host: HostPort;
  paths: ProjectPaths;
  stateDir: string;
  sessionId: string;
  runId: string;
  bus: { emit(ev: RunEvent): void };
  interaction: Interaction;
}

const PLAN_REL = ".stewart/plan.md";

interface PlanState {
  plan: Plan;
  baseline: string;
  writesSinceCp: WriteRecord[];
}

/** Plan facts for history.load. */
export interface PlanSummary {
  goal: string;
  status: string;
  milestones: Milestone[];
}

/** Owns `.stewart/plan.md` for one session: plan_write/milestone_done tools, checkpoints, revert, resume text. */
export class PlanRunner {
  private st?: PlanState;
  private loaded = false;
  /** Successful file writes this turn before any plan existed (plan_write must come first). */
  private wroteBeforePlan = false;
  /** plan_write or milestone_done ran this turn (the end-of-turn sweep runs only after plan work). */
  touched = false;

  constructor(private readonly d: PlanDeps) {}

  private planFile(): string {
    return `${this.d.paths.base}/${PLAN_REL}`;
  }

  private cpPaths() {
    return { cwd: this.d.paths.base, stateDir: this.d.stateDir, sessionId: this.d.sessionId };
  }

  private cp(label: string, files: string[]): Promise<string> {
    return createCheckpoint(this.d.host, this.cpPaths(), label, files);
  }

  private async save(): Promise<void> {
    await this.d.host.files.writeAtomic(this.planFile(), renderPlan(this.st!.plan));
  }

  private async load(): Promise<PlanState | undefined> {
    if (this.st || this.loaded) return this.st;
    this.loaded = true;
    try {
      const plan = parsePlan((await this.d.host.files.read(this.planFile())).content);
      if (plan.sessionId !== this.d.sessionId) return undefined;
      const baseline = (await this.d.host.files.readLines(`${this.d.stateDir}/sessions/${this.d.sessionId}.plan`))[0] ?? "";
      this.st = { plan, baseline, writesSinceCp: [] };
    } catch {
      return undefined;
    }
    return this.st;
  }

  recordWrite(w: WriteRecord): void {
    if (this.st) this.st.writesSinceCp.push(w);
    else if (w.ok) this.wroteBeforePlan = true;
  }

  /** Before the first write to a file: snapshot checkpoints keep its pre-write content (copy-on-write). */
  async beforeWrite(path: string, content: string | null): Promise<void> {
    if (!(await this.load())) return;
    await recordOriginal(this.d.host, this.cpPaths(), path, content);
  }

  async summary(): Promise<PlanSummary | undefined> {
    const st = await this.load();
    return st ? { goal: st.plan.goal, status: st.plan.status, milestones: st.plan.milestones } : undefined;
  }

  /** Appended to the lead system prompt while a plan is active. */
  async systemNote(): Promise<string | undefined> {
    const st = await this.load();
    if (!st || st.plan.status !== "active") return undefined;
    return `\n\n# Active plan\n${renderPlan(st.plan).slice(0, 4000)}`;
  }

  /** Pending milestone that makes a turn fail as "plan incomplete". */
  async unfinished(): Promise<Milestone | undefined> {
    const st = await this.load();
    return st?.plan.status === "active" ? currentMilestone(st.plan) : undefined;
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
    const out = await cpRevert(this.d.host, this.cpPaths(), target);
    await this.resetAfter(target);
    return out;
  }

  /** Milestones after the restored checkpoint are pending again (the baseline resets all of them). */
  private async resetAfter(target: string): Promise<void> {
    const st = this.st;
    if (!st) return;
    const keep = st.plan.milestones.findIndex((m) => m.checkpoint === target);
    st.plan.milestones.forEach((m, i) => {
      if (i <= keep) return;
      m.status = "pending";
      m.attempts = 0;
      m.checkpoint = undefined;
    });
    st.plan.status = "active";
    await this.save();
  }

  /** "Resume" prompt text for chat.resume, or undefined when no active plan. */
  async resumeText(): Promise<string | undefined> {
    const m = await this.unfinished();
    return m ? `Resume the plan in .stewart/plan.md: continue at ${m.id}: ${m.title}.` : undefined;
  }

  tools(): Tool[] {
    return [this.planWriteTool(), this.milestoneDoneTool()];
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
                    properties: { command: { type: "string" }, files: { type: "array", items: { type: "string" } } },
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
    this.touched = true;
    if (this.wroteBeforePlan) throw new Error("plan_write must come before any file edits: write the plan first, then work milestone by milestone");
    const input = args.milestones as { title: string; detail?: string; check?: { command?: string; files?: string[] } }[] | undefined;
    if (!Array.isArray(input) || input.length === 0) throw new Error("milestones must be a non-empty array");
    const milestones: Milestone[] = input.map((m, i) => {
      const check = m.check ?? {};
      if (!check.command && !check.files?.length) throw new Error(`milestone ${i + 1} '${m.title}' needs a check command or files`);
      return { id: `M${i + 1}`, title: String(m.title), detail: m.detail ?? "", check, status: "pending" as const, attempts: 0 };
    });
    const plan: Plan = { goal: String(args.goal ?? ""), status: "active", sessionId: this.d.sessionId, milestones };
    const text = renderPlan(plan);
    const o = await this.d.interaction.ask(questionPrompt("plan_write", `Approve this plan?\n\n${text}`, ["Approve", "Revise"]), { runId: this.d.runId, roleId: "lead" }, signal);
    if (o.kind !== "answered" || o.value !== "Approve") return `not approved: ${o.kind === "answered" ? o.value : o.kind}`;
    this.st = { plan, baseline: "", writesSinceCp: [] };
    await this.save();
    const baseline = await this.cp("start", []);
    this.st.baseline = baseline;
    await this.d.host.files.writeAtomic(`${this.d.stateDir}/sessions/${this.d.sessionId}.plan`, `${baseline}\n`);
    this.d.bus.emit({ kind: "plan.approved", runId: this.d.runId, roleId: "lead", milestoneCount: milestones.length });
    this.d.bus.emit({ kind: "milestone.started", runId: this.d.runId, roleId: "lead", milestoneId: "M1", title: milestones[0].title });
    return `approved; start with M1: ${milestones[0].title}`;
  }

  private milestoneDoneTool(): Tool {
    return {
      spec: {
        name: "milestone_done",
        description: "Run the current milestone's check and mark it done; call once per milestone, in order.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      requiresApproval: false,
      noTimeout: true,
      execute: async (args) => this.done(String(args.id ?? "")),
    };
  }

  private async done(id: string): Promise<string> {
    this.touched = true;
    const st = await this.load();
    if (!st) throw new Error("no approved plan for this session");
    const m = currentMilestone(st.plan);
    if (!m || m.id !== id) throw new Error(`milestone '${id}' is not the current milestone (${m?.id ?? "plan complete"})`);
    const res = await this.checkMilestone(st, m);
    if (!res.passed) return await this.failAttempt(m, res.evidence.join("; "));
    const cpId = await this.markDone(st, m);
    const next = currentMilestone(st.plan);
    if (!next) {
      st.plan.status = "done";
      await this.save();
      return "plan complete";
    }
    await this.save();
    this.d.bus.emit({ kind: "milestone.started", runId: this.d.runId, roleId: "lead", milestoneId: next.id, title: next.title });
    return `${m.id} done (checkpoint ${cpId.slice(0, 12)}); next: ${next.id}: ${next.title}`;
  }

  /** Count a failed check; the third failure marks the milestone failed, which blocks the plan until it passes. */
  private async failAttempt(m: Milestone, evidence: string): Promise<string> {
    m.attempts += 1;
    if (m.attempts >= 3 && m.status !== "failed") {
      m.status = "failed";
      this.d.bus.emit({ kind: "milestone.failed", runId: this.d.runId, roleId: "lead", milestoneId: m.id, error: evidence });
    }
    await this.save();
    if (m.status === "failed") return `${m.id} failed ${m.attempts} times: ${evidence}. Ask the user how to proceed; later milestones stay blocked until ${m.id} passes.`;
    return `check failed for ${m.id}: ${evidence}`;
  }

  private async checkMilestone(st: PlanState, m: Milestone) {
    const writes = st.writesSinceCp;
    const changed = [...new Set(writes.filter((w) => w.ok).map((w) => w.path))];
    const input = { reply: `${m.id}: ${m.title}`, writes, changed };
    let res = await runCheck({ check: { command: m.check.command ? ["sh", "-c", m.check.command] : undefined, files: [...(m.check.files ?? []), ...changed] }, input, host: this.d.host, cwd: this.d.paths.base });
    if (!m.check.command && !changed.length) {
      res = { passed: false, evidence: [...res.evidence, `${m.id}: no file written since the last checkpoint (a files-only check needs this milestone's work)`] };
    }
    this.d.bus.emit({ kind: "check.result", runId: this.d.runId, roleId: "lead", passed: res.passed, evidence: res.evidence });
    return res;
  }

  private async markDone(st: PlanState, m: Milestone): Promise<string> {
    const files = [...new Set(st.writesSinceCp.filter((w) => w.ok).map((w) => w.path))];
    const cpId = await this.cp(m.id, files);
    st.writesSinceCp = [];
    m.status = "done";
    m.checkpoint = cpId;
    this.d.bus.emit({ kind: "milestone.done", runId: this.d.runId, roleId: "lead", milestoneId: m.id });
    return cpId;
  }

  /**
   * End-of-turn sweep (only after a turn that wrote files or used plan tools): the current milestone is checked
   * and checkpointed when it passes. Returns the first milestone still not done; the plan is `done` only when
   * every milestone is.
   */
  async sweepFinish(): Promise<{ id: string; title: string; evidence: string } | undefined> {
    const st = await this.load();
    if (!st || st.plan.status !== "active") return undefined;
    const m = currentMilestone(st.plan);
    if (m && m.status === "pending") {
      const res = await this.checkMilestone(st, m);
      if (!res.passed) {
        await this.save();
        return { id: m.id, title: m.title, evidence: res.evidence.join("; ") };
      }
      await this.markDone(st, m);
    }
    const next = currentMilestone(st.plan);
    if (!next) st.plan.status = "done";
    await this.save();
    return next ? { id: next.id, title: next.title, evidence: next.status === "failed" ? "milestone failed; ask the user how to proceed" : "not started" } : undefined;
  }
}
