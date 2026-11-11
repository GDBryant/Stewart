import type { RoleDef } from "@stewart/config";
import type { ToolCall } from "@stewart/kernel";
import type { FaultKind } from "@stewart/kernel";
import { actionsSoFar } from "@stewart/agent-loop";
import { type RunRuntime, type RecoveryState, type RecoveryContext, type RoleTaskDeps, type TaskResult } from "@stewart/run-contract";
import type { ToolPreview } from "@stewart/permissions";
import { ProjectPaths } from "@stewart/tools";
import type { TaskSpec } from "@stewart/scheduling";
import { logRecovery } from "./consts.js";
import { scratchGate, roleWithScratch, taskScratchDir } from "./scratch.js";
import { type RecoveryPlan } from "./plan.js";
import { recoveryCall } from "./brain.js";

/** Runs a task with the full recovery layers; passed in so split and recover do not import each other. */
export type Recoverable = (rt: RunRuntime, spec: TaskSpec, deps: RoleTaskDeps, ctx: RecoveryContext) => Promise<TaskResult>;
export type SplitContext = RecoveryContext & { recurse: Recoverable };

export async function assembleFinalFile(
  rt: RunRuntime,
  spec: TaskSpec,
  role: RoleDef,
  plan: RecoveryPlan,
  taskDir: string,
): Promise<{ ok: boolean; error?: string; rel?: string }> {
  if (!plan.finalFile) return { ok: true };
  const paths = await ProjectPaths.forProject(rt.host);
  let rel: string;
  try {
    rel = paths.resolve(plan.finalFile);
  } catch (e) {
    return { ok: false, error: `final_file rejected: ${e instanceof Error ? e.message : e}` };
  }
  const parts: string[] = [];
  for (const s of plan.subtasks) {
    const p = `${taskDir}/${s.outputFile}`;
    try {
      parts.push((await rt.host.files.read(p)).content);
    } catch (e) {
      return { ok: false, error: `cannot read ${p}: ${e instanceof Error ? e.message : e}` };
    }
  }
  const joined = parts.join("\n");
  let before: string | null = null;
  try {
    if (await rt.host.files.exists(rel)) before = (await rt.host.files.read(rel)).content;
  } catch {
    /* treated as new */
  }
  const call: ToolCall = { id: `recovery-${spec.id}`, name: "WriteFile", arguments: { path: rel, content: joined } };
  const preview: ToolPreview = { kind: "file", path: rel, before, after: joined };
  const decision = await rt.approve(call, preview, { roleId: role.id, taskId: spec.id });
  if (decision.kind === "rejected") return { ok: false, error: `final_file write rejected: ${decision.reason}` };
  try {
    await rt.host.files.edit({ path: rel, content: joined });
  } catch (e) {
    return { ok: false, error: `final_file write failed: ${e instanceof Error ? e.message : e}` };
  }
  return { ok: true, rel };
}

/** Layer-1 split: planner brief, serial sub-tasks under the scratch gate, assembly, merge. */
function splitBrief(spec: TaskSpec, parent: TaskResult, fault: FaultKind, taskDir: string, scratchFiles: string[], acts: string[], R: RecoveryState): string {
  return [
    `A worker task hit a fault and must be split into smaller sub-tasks.`,
    `Fault: ${fault}: ${parent.summary}`,
    `Task: ${spec.task}`,
    spec.expect ? `Expected: ${spec.expect}` : "",
    acts.length ? `Actions already completed (do not redo or undo them):\n${acts.map((a) => `- ${a}`).join("\n")}` : "",
    scratchFiles.length ? `Existing scratch files under ${taskDir}:\n${scratchFiles.join("\n")}` : "",
    `Submit 2..${R.maxSubTasks} sub-tasks via submit_recovery. Each sub-task writes its own output_file (a bare name under ${taskDir}). Set final_file when the outputs should be assembled into one project file.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface SplitRun {
  results: { file: string; res: TaskResult }[];
  filesTouched: Set<string>;
  allDone: boolean;
}

async function runSplitSubtasks(
  rt: RunRuntime,
  spec: TaskSpec,
  plan: RecoveryPlan,
  subRole: RoleDef,
  taskDir: string,
  ctx: SplitContext,
  R: RecoveryState,
  gate: Parameters<SplitContext["recurse"]>[2]["approve"],
  run: SplitRun,
): Promise<void> {
  for (const [i, sub] of plan.subtasks.entries()) {
    const prior = run.results
      .map((r, k) => `${plan.subtasks[k].outputFile}: ${r.res.summary.slice(0, R.recoverySummaryChars)}`)
      .join("\n");
    const subSpec: TaskSpec = {
      id: `${spec.id}/s${i + 1}`,
      roleId: spec.roleId,
      title: `${spec.title} (${i + 1}/${plan.subtasks.length})`,
      task: sub.description,
      files: [],
      dependsOn: [],
      expect: spec.expect,
    };
    const extra = [
      `Write your full output to '${taskDir}/${sub.outputFile}' with WriteFile. Then finish with a summary of at most ${R.recoverySummaryChars} chars.`,
      prior ? `Earlier sub-task results:\n${prior}` : "",
      plan.advice ? `Advice: ${plan.advice}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const res = await ctx.recurse(rt, subSpec, { role: subRole, extraBriefing: extra, approve: gate }, { depth: ctx.depth + 1, brain: ctx.brain });
    rt.leases.release(subSpec.id);
    run.results.push({ file: sub.outputFile, res });
    for (const f of res.filesTouched) run.filesTouched.add(f);
    if (res.status !== "done") {
      run.allDone = false;
      break;
    }
  }
}

async function assembleSplit(
  rt: RunRuntime,
  spec: TaskSpec,
  role: RoleDef,
  plan: RecoveryPlan,
  taskDir: string,
  parent: TaskResult,
  run: SplitRun,
  R: RecoveryState,
): Promise<TaskResult> {
  const asm = await assembleFinalFile(rt, spec, role, plan, taskDir);
  if (!asm.ok) {
    return { ...parent, status: "failed", summary: `${parent.summary}; recovery: assembly failed (${asm.error}); scratch: ${taskDir}`, filesTouched: [...run.filesTouched] };
  }
  if (asm.rel) run.filesTouched.add(asm.rel);
  for (const s of plan.subtasks) {
    try {
      await rt.host.files.delete(`${taskDir}/${s.outputFile}`);
    } catch {
      /* cleanup is best-effort */
    }
  }
  const parts = run.results.map((r) => `${r.file}: ${r.res.summary.slice(0, R.recoverySummaryChars)}`);
  return {
    status: "done",
    summary: [`split into ${run.results.length} sub-tasks: ${parts.join(" | ")}`, plan.finalFile ? `assembled -> ${plan.finalFile}` : ""]
      .filter(Boolean)
      .join("; ")
      .slice(0, 1000),
    filesTouched: [...run.filesTouched],
  };
}

function splitFailed(parent: TaskResult, run: SplitRun, taskDir: string): TaskResult {
  const failed = run.results[run.results.length - 1]?.res;
  return {
    ...parent,
    status: "failed",
    summary: `${parent.summary}; recovery: sub-task failed (${failed?.summary ?? "unknown"}); scratch: ${taskDir}`,
    filesTouched: [...run.filesTouched],
  };
}

/** Layer-1 split: planner brief, serial sub-tasks under the scratch gate, assembly, merge. */
export async function splitTask(
  rt: RunRuntime,
  spec: TaskSpec,
  role: RoleDef,
  parent: TaskResult,
  ctx: SplitContext,
  R: RecoveryState,
): Promise<TaskResult> {
  const taskDir = taskScratchDir(rt.runId, spec.id);
  const fault: FaultKind = parent.fault ?? "turn_limit";
  let scratchFiles: string[] = [];
  try {
    scratchFiles = (await rt.host.files.list(taskDir)).map((f) => f.slice(taskDir.length + 1));
  } catch {
    /* no scratch yet */
  }
  const acts = actionsSoFar(parent.transcript ?? [], R.maxActionsInRecoveryBrief);
  const brief = splitBrief(spec, parent, fault, taskDir, scratchFiles, acts, R);
  R.recoveriesUsed++;
  const plan = await recoveryCall(rt, ctx.brain!, brief, R);
  if (!plan) {
    return { ...parent, status: "failed", summary: `${parent.summary}; recovery: no valid submit_recovery; scratch: ${taskDir}` };
  }
  logRecovery(rt, `layer 1: ${fault} on task ${spec.id} -> ${plan.subtasks.length} sub-tasks`);
  const subRole = roleWithScratch(role, taskDir);
  const gate = scratchGate(taskDir, rt.approve);
  const run: SplitRun = { results: [], filesTouched: new Set(parent.filesTouched), allDone: true };
  await runSplitSubtasks(rt, spec, plan, subRole, taskDir, ctx, R, gate, run);
  if (run.allDone) return assembleSplit(rt, spec, role, plan, taskDir, parent, run, R);
  return splitFailed(parent, run, taskDir);
}

