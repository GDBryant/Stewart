import type { HostPort, Json } from "@stewart/kernel";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { Tool, ProjectPaths } from "@stewart/tools";
import { currentMilestone, createCheckpoint, parsePlan, renderPlan, revert as cpRevert, runCheck, type Milestone, type Plan, type WriteRecord } from "@stewart/tasks";
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
  snapFiles: Set<string>;
}

/** Owns `.stewart/plan.md` for one session: plan_write/milestone_done tools, checkpoints, revert, resume text. */
export class PlanRunner {
  private st?: PlanState;
  private loaded = false;

  constructor(private readonly d: PlanDeps) {}

  private planFile(): string {
    return `${this.d.paths.base}/${PLAN_REL}`;
  }

  private cp(label: string, files: string[]): Promise<string> {
    const st = this.st!;
    return createCheckpoint(this.d.host, { cwd: this.d.paths.base, stateDir: this.d.stateDir, sessionId: this.d.sessionId }, label, [...st.snapFiles]);
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
      this.st = { plan, baseline, writesSinceCp: [], snapFiles: new Set() };
    } catch {
      return undefined;
    }
    return this.st;
  }

  recordWrite(w: WriteRecord): void {
    this.st?.writesSinceCp.push(w);
    if (w.ok) this.st?.snapFiles.add(w.path);
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
    return await cpRevert(this.d.host, { cwd: this.d.paths.base, stateDir: this.d.stateDir, sessionId: this.d.sessionId }, target);
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
      execute: async (args, _p, signal) => this.writePlan(args, signal),
    };
  }

  private async writePlan(args: Json, signal: AbortSignal): Promise<string> {
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
    this.st = { plan, baseline: "", writesSinceCp: [], snapFiles: new Set() };
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
      execute: async (args) => this.done(String(args.id ?? "")),
    };
  }

  private async done(id: string): Promise<string> {
    const st = await this.load();
    if (!st) throw new Error("no approved plan for this session");
    const m = currentMilestone(st.plan);
    if (!m || m.id !== id) throw new Error(`milestone '${id}' is not the current milestone (${m?.id ?? "plan complete"})`);
    const writes = st.writesSinceCp;
    const input = { reply: `${m.id}: ${m.title}`, writes, changed: [...new Set(writes.filter((w) => w.ok).map((w) => w.path))] };
    const res = await runCheck({ check: { command: m.check.command ? ["sh", "-c", m.check.command] : undefined, files: [...(m.check.files ?? []), ...input.changed] }, input, host: this.d.host, cwd: this.d.paths.base });
    this.d.bus.emit({ kind: "check.result", runId: this.d.runId, roleId: "lead", passed: res.passed, evidence: res.evidence });
    if (!res.passed) {
      m.attempts += 1;
      const evidence = res.evidence.join("; ");
      if (m.attempts >= 3) {
        m.status = "failed";
        await this.save();
        this.d.bus.emit({ kind: "milestone.failed", runId: this.d.runId, roleId: "lead", milestoneId: m.id, error: evidence });
        return `${m.id} failed 3 times: ${evidence}. Ask the user how to proceed.`;
      }
      await this.save();
      return `check failed for ${m.id}: ${evidence}`;
    }
    const cpId = await this.cp(m.id, [...st.snapFiles]);
    st.writesSinceCp = [];
    m.status = "done";
    m.checkpoint = cpId;
    this.d.bus.emit({ kind: "milestone.done", runId: this.d.runId, roleId: "lead", milestoneId: m.id });
    const next = st.plan.milestones[milestonesIndexOf(st.plan, m) + 1];
    if (!next) {
      st.plan.status = "done";
      await this.save();
      return "plan complete";
    }
    await this.save();
    this.d.bus.emit({ kind: "milestone.started", runId: this.d.runId, roleId: "lead", milestoneId: next.id, title: next.title });
    return `${m.id} done (checkpoint ${cpId.slice(0, 12)}); next: ${next.id}: ${next.title}`;
  }
}

function milestonesIndexOf(plan: Plan, m: Milestone): number {
  return plan.milestones.indexOf(m);
}

export { PLAN_REL };
