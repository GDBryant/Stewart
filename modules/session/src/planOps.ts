import type { HostPort, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";
import type { Interaction } from "@stewart/interaction";
import { ProjectPaths } from "@stewart/tools";
import { changeTracker } from "@stewart/tasks";
import { PlanRunner } from "./plan.js";
import { isBaselineId, isDiffPath } from "./diffArgs.js";

/** What the out-of-turn plan operations (revert, history, resume) need. */
export interface PlanOpsDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  ids: IdGen;
  interaction: Interaction;
}

async function runnerFor(d: PlanOpsDeps, sessionId: string, runId: string): Promise<{ runner: PlanRunner; tracker: ReturnType<typeof changeTracker>; stateDir: string }> {
  const stateDir = await d.host.workspace.stateDir();
  const paths = await ProjectPaths.forProject(d.host);
  const tracker = changeTracker(d.host, { cwd: paths.base, stateDir, sessionId });
  return { runner: new PlanRunner({ host: d.host, paths, stateDir, sessionId, runId, bus: d.bus, interaction: d.interaction, tracker }), tracker, stateDir };
}

/** Revert the session's worktree: "turn" = the last turn baseline; else a checkpoint id, "baseline", or latest. */
export async function revertSession(d: PlanOpsDeps, sessionId: string, checkpoint?: string): Promise<{ ok: boolean; filesRestored?: string[]; reason?: string }> {
  const runId = d.ids.next("revert");
  const { runner, tracker, stateDir } = await runnerFor(d, sessionId, runId);
  if (checkpoint === "turn") {
    const id = ((await d.host.files.readLines(`${stateDir}/sessions/${sessionId}.turn`))[0] ?? "").trim();
    if (!id) return { ok: false, reason: "no turn baseline for this session" };
    const done = await tracker.restore(await tracker.baseline(id));
    const filesRestored = [...done.restored, ...done.deleted.map((p) => `-${p}`)];
    d.bus.emit({ kind: "run.reverted", runId, roleId: "lead", filesRestored });
    return { ok: true, filesRestored };
  }
  const done = await runner.revertTo(checkpoint);
  if (!done) return { ok: false, reason: "no checkpoint for this session" };
  const filesRestored = [...done.restored, ...done.deleted.map((p) => `-${p}`)];
  d.bus.emit({ kind: "run.reverted", runId, roleId: "lead", filesRestored });
  return { ok: true, filesRestored };
}

/** Open the host diff viewer for `path`: baseline content vs the current file. */
export async function showFileDiff(d: PlanOpsDeps, sessionId: string, path: string, baselineId: string): Promise<void> {
  if (!isDiffPath(path)) throw new Error(`invalid diff path: ${path}`);
  if (!isBaselineId(baselineId)) throw new Error(`invalid baseline: ${baselineId}`);
  const { tracker } = await runnerFor(d, sessionId, "diff");
  const b = await tracker.baseline(baselineId);
  const before = await tracker.read(b, path);
  let after: string | undefined;
  try {
    after = (await d.host.files.read(path)).content;
  } catch {
    after = undefined;
  }
  await d.host.diff.show(path, before, after);
}

/** Latest session plan summary for history.load. */
export async function planSummary(d: PlanOpsDeps, sessionId: string): Promise<unknown> {
  const { runner } = await runnerFor(d, sessionId, "history");
  const st = await runner.summary();
  if (!st) return undefined;
  const cps = await runner.checkpoints();
  return { goal: st.goal, status: st.status, active: st.status !== "done", milestones: st.milestones, latest: cps.latest, baseline: cps.baseline };
}
