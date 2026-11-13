import type { HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { Interaction } from "@stewart/interaction";
import { ProjectPaths } from "@stewart/tools";
import { PlanRunner } from "./plan.js";

/** What the out-of-turn plan operations (revert, history, resume) need. */
export interface PlanOpsDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  ids: IdGen;
  interaction: Interaction;
}

async function runnerFor(d: PlanOpsDeps, sessionId: string, runId: string): Promise<PlanRunner> {
  const stateDir = await d.host.workspace.stateDir();
  const paths = await ProjectPaths.forProject(d.host);
  return new PlanRunner({ host: d.host, paths, stateDir, sessionId, runId, bus: d.bus, interaction: d.interaction });
}

/** Revert the session's worktree to a checkpoint (id, "baseline", or latest); later milestones become pending. */
export async function revertSession(d: PlanOpsDeps, sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
  const runId = d.ids.next("revert");
  const done = await (await runnerFor(d, sessionId, runId)).revertTo(checkpoint);
  if (!done) return { ok: false, reason: "no checkpoint for this session" };
  const filesRestored = [...done.restored, ...done.deleted.map((p) => `-${p}`)];
  d.bus.emit({ kind: "run.reverted", runId, roleId: "lead", filesRestored });
  return { ok: true, filesRestored };
}

/** Latest session plan summary for history.load. */
export async function planSummary(d: PlanOpsDeps, sessionId: string): Promise<unknown> {
  const plan = await runnerFor(d, sessionId, "history");
  const st = await plan.summary();
  if (!st) return undefined;
  const cps = await plan.checkpoints();
  const text = await plan.resumeText();
  return { goal: st.goal, status: st.status, active: text !== undefined, milestones: st.milestones, latest: cps.latest, baseline: cps.baseline };
}

/** "Resume" prompt for an active plan, or undefined. */
export async function planResumeText(d: PlanOpsDeps, sessionId: string): Promise<string | undefined> {
  return await (await runnerFor(d, sessionId, "resume")).resumeText();
}
