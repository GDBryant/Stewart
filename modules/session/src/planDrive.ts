import type { ChatMessage } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { EffectiveConfig } from "@stewart/roles-skills";
import { currentMilestone, type Baseline, type ChangeTracker, type Milestone, type Plan } from "@stewart/tasks";
import type { Contract, TaskResult } from "./taskRun.js";
import type { PlanRunner } from "./plan.js";
import type { Declared } from "./sessionTools.js";

/** What the plan driver needs from a TurnWork. */
export interface DriveWork {
  runId: string;
  transcript: ChatMessage[];
  declared: Declared;
  plan: PlanRunner;
  tracker: ChangeTracker;
}

export interface DriveIO {
  task: (o: { goal: string; baseline?: Baseline; contract: () => Contract; needs?: { mustChange?: boolean }; planTool: boolean }) => Promise<TaskResult>;
  bus: { emit(ev: RunEvent): void };
  persist: () => Promise<void>;
  config: () => EffectiveConfig;
}

const verifyCmds = (config: () => EffectiveConfig) => config().project.verify.map((argv) => ({ argv, approved: false, whenChanged: true }));

/** The lead turn's contract: project verify (gated, when-changed) + set_check declarations. */
export function leadContract(config: () => EffectiveConfig, declared: Declared): () => Contract {
  return () => ({
    commands: [...verifyCmds(config), ...(declared.value?.command ? [{ argv: declared.value.command, approved: true }] : [])],
    files: declared.value?.files ?? [],
  });
}

/** A milestone task's contract: its check (approved by the plan approval) + project verify + set_check made during it. */
export function milestoneContract(config: () => EffectiveConfig, declared: Declared, m: Milestone): () => Contract {
  return () => ({
    commands: [
      ...(m.check.command ? [{ argv: m.check.command, approved: true }] : []),
      ...verifyCmds(config),
      ...(declared.value?.command ? [{ argv: declared.value.command, approved: true }] : []),
    ],
    files: [...(m.check.files ?? []), ...(declared.value?.files ?? [])],
  });
}

/** The user message the driver pushes for one milestone task. */
export function milestoneText(plan: Plan, m: Milestone): string {
  const when = [m.check.command ? m.check.command.join(" ") : "", m.check.files?.length ? `files exist: ${m.check.files.join(", ")}` : ""].filter(Boolean).join("; ");
  return `Milestone ${m.id} of ${plan.milestones.length}: ${m.title}\n${m.detail ? `${m.detail}\n` : ""}Done when: ${when}\nWork on this milestone only.`;
}

/**
 * Run each pending milestone as its own task of the same run (plan_write not offered, set_check reset per
 * milestone), checkpointing between them. Done milestones checkpoint; failure pauses the plan and fails the run.
 */
export async function drivePlan(w: DriveWork, first: Baseline, io: DriveIO): Promise<TaskResult> {
  const st = (await w.plan.state())!;
  let res: TaskResult = { status: "done", reason: "stop", changed: undefined, baseline: first, reply: "", contract: { commands: [], files: [] } };
  for (;;) {
    const m = currentMilestone(st.plan);
    if (!m) {
      st.plan.status = "done";
      await w.plan.save();
      return res;
    }
    io.bus.emit({ kind: "milestone.started", runId: w.runId, roleId: "lead", milestoneId: m.id, title: m.title });
    const text = milestoneText(st.plan, m);
    w.transcript.push({ role: "user", content: text });
    w.declared.value = undefined;
    const baseline = await w.plan.baselineFor(w.plan.nextBaseline(st));
    res = await io.task({ goal: text, baseline, contract: milestoneContract(io.config, w.declared, m), needs: { mustChange: !m.check.command }, planTool: false });
    await io.persist();
    if (res.status === "done") {
      await w.plan.markDone(m);
      continue;
    }
    if (res.status === "cancelled") {
      await w.plan.pause();
      return res;
    }
    await w.plan.markFailed(m, res.error ?? "failed");
    return { ...res, error: `milestone ${m.id} failed: ${res.error ?? "failed"}` };
  }
}
