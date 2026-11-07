import type { AgentDef, RoleDef, Settings } from "../config/schema.js";
import type { ChatMessage, ToolCall } from "../channels/types.js";
import { DEFAULT_CAPS } from "../channels/types.js";
import type { ManagedChannel } from "../channels/registry.js";
import { isWriteCapableRole } from "../roles.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type ApprovalDecision, type ToolsMode } from "../tools/toolLoop.js";
import { ToolRegistry, type Json, type Tool, type ToolPreview } from "../tools/types.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { actionsSoFar, countToolCalls, detectStuck, type FaultKind } from "./faults.js";
import { costOfCall } from "./ledger.js";
import { runRoleTask, type TaskResult } from "./roleRunner.js";
import type { TaskSpec } from "./tasks.js";
import type { OrchestrationRuntime } from "./types.js";

/** Per-run recovery limits (from settings) plus live counters. */
export interface RecoveryState {
  maxRecoveryDepth: number;
  maxRecoveriesPerRun: number;
  maxSubTasks: number;
  recoverySummaryChars: number;
  maxActionsInRecoveryBrief: number;
  maxContinuations: number;
  maxContinueQuestionsPerRun: number;
  askOnTurnLimit: boolean;
  continueQuestionTimeoutMs: number;
  recoveriesUsed: number;
  questionsUsed: number;
}

export function recoveryState(s: Settings): RecoveryState {
  return {
    maxRecoveryDepth: s.maxRecoveryDepth,
    maxRecoveriesPerRun: s.maxRecoveriesPerRun,
    maxSubTasks: s.maxSubTasks,
    recoverySummaryChars: s.recoverySummaryChars,
    maxActionsInRecoveryBrief: s.maxActionsInRecoveryBrief,
    maxContinuations: s.maxContinuations,
    maxContinueQuestionsPerRun: s.maxContinueQuestionsPerRun,
    askOnTurnLimit: s.askOnTurnLimit,
    continueQuestionTimeoutMs: s.continueQuestionTimeoutMinutes * 60_000,
    recoveriesUsed: 0,
    questionsUsed: 0,
  };
}

/** Lazily attach the per-run recovery state so hand-built runtimes get defaults. */
export function ensureRecovery(rt: OrchestrationRuntime): RecoveryState {
  return (rt.recovery ??= recoveryState(rt.config.settings));
}

/** Layer-0 size hint appended to level retries; layer-2 rule for re-plans. */
export const SIZE_HINT =
  "Your previous reply hit the output limit. Submit at most half as much work, keep each description under 300 chars, and put large data in files.";
export const SIZE_RULE =
  "Keep milestones and tasks small. No single reply or file write should exceed ~150 lines; split larger output across files.";

/** Recovery decisions go to the host log, prefixed like the v1 `recovery` category. */
export function logRecovery(rt: OrchestrationRuntime, line: string): void {
  rt.host.log(`[run ${rt.runId}] ${line}`);
}

export function taskScratchDir(runId: string, taskId: string): string {
  return `.stewart/scratch/${runId}/task-${taskId.replace(/[^\w.-]/g, "_")}`;
}

function insideDir(dir: string, p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
  return norm === d || norm.startsWith(`${d}/`);
}

/** Auto-approves writes strictly inside the task's scratch dir; everything else delegates. */
export function scratchGate(
  taskDir: string,
  approve: OrchestrationRuntime["approve"],
): NonNullable<OrchestrationRuntime["approve"]> {
  return async (call: ToolCall, preview: ToolPreview | null, meta) => {
    if (preview?.kind === "file" && insideDir(taskDir, preview.path)) return { kind: "approved" };
    return approve(call, preview, meta);
  };
}

/** Role clone whose writePaths also cover the task scratch dir (empty list stays unrestricted). */
export function roleWithScratch(role: RoleDef, taskDir: string): RoleDef {
  if (role.writePaths.length === 0) return role;
  return { ...role, writePaths: [...role.writePaths, `${taskDir}/**`] };
}

export interface RecoveryPlan {
  subtasks: { description: string; outputFile: string; maxTurns?: number }[];
  finalFile?: string;
  advice?: string;
}

/** Validates `submit_recovery` args; throws with a resubmit-able error. */
export function parseRecoveryArgs(args: Json, limits: { maxSubTasks: number; ceiling: number }): RecoveryPlan {
  const raw = args.subtasks;
  if (!Array.isArray(raw)) throw new Error("'subtasks' must be an array");
  if (raw.length < 2 || raw.length > limits.maxSubTasks) {
    throw new Error(`'subtasks' must have 2..${limits.maxSubTasks} entries (got ${raw.length})`);
  }
  const subtasks = raw.map((s, i) => {
    if (typeof s !== "object" || s === null) throw new Error(`subtask ${i + 1}: not an object`);
    const o = s as Record<string, unknown>;
    const description = o.description;
    if (typeof description !== "string" || !description.trim()) throw new Error(`subtask ${i + 1}: 'description' required`);
    const outputFile = o.output_file;
    if (typeof outputFile !== "string" || !outputFile.trim()) throw new Error(`subtask ${i + 1}: 'output_file' required`);
    if (/[/\\]/.test(outputFile) || outputFile.includes("..") || outputFile === ".") {
      throw new Error(`subtask ${i + 1}: 'output_file' must be a bare file name (got '${outputFile}')`);
    }
    let maxTurns: number | undefined;
    if (o.max_turns !== undefined) {
      if (typeof o.max_turns !== "number" || !Number.isInteger(o.max_turns) || o.max_turns < 1 || o.max_turns > limits.ceiling) {
        throw new Error(`subtask ${i + 1}: 'max_turns' must be an integer 1..${limits.ceiling}`);
      }
      maxTurns = o.max_turns;
    }
    return { description: description.trim(), outputFile, maxTurns };
  });
  const finalFile = args.final_file;
  if (finalFile !== undefined && (typeof finalFile !== "string" || !finalFile.trim())) {
    throw new Error("'final_file' must be a project path");
  }
  const advice = args.advice;
  return { subtasks, finalFile: typeof finalFile === "string" ? finalFile.trim() : undefined, advice: typeof advice === "string" ? advice : undefined };
}

function submitRecoveryTool(onSubmit?: (args: Json) => string): Tool {
  return {
    spec: {
      name: "submit_recovery",
      description:
        "Submit the split plan for a faulted task: 2..N sub-tasks, each writing its own output_file. Ends the turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          subtasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string" },
                output_file: { type: "string", description: "bare file name under the task scratch dir" },
                max_turns: { type: "integer" },
              },
              required: ["description", "output_file"],
            },
          },
          final_file: { type: "string", description: "project path the sub-task outputs are assembled into" },
          advice: { type: "string" },
        },
        required: ["subtasks"],
      },
    },
    requiresApproval: false,
    coreHandled: true,
    execute: async (args) => onSubmit?.(args) ?? "Recovery plan recorded.",
  };
}

export type ContinueChoice = { kind: "continue" } | { kind: "split" } | { kind: "stop" } | { kind: "text"; text: string };

export function mapContinueAnswer(answer: string): ContinueChoice {
  if (/^continue/i.test(answer)) return { kind: "continue" };
  if (/^split/i.test(answer)) return { kind: "split" };
  if (/^stop/i.test(answer)) return { kind: "stop" };
  return { kind: "text", text: answer };
}

/** Turn-limit question text, capped at ~600 chars; recommended option first. */
export function continueQuestion(opts: {
  spec: TaskSpec;
  turns: number;
  transcript: ChatMessage[];
  maxActions: number;
  canSplit: boolean;
}): { question: string; options: string[] } {
  const stuck = detectStuck(opts.transcript);
  const acts = actionsSoFar(opts.transcript, opts.maxActions);
  const desc = opts.spec.task.replace(/\s+/g, " ").slice(0, 120);
  const lines = [
    `Worker hit its turn limit (${opts.turns}) on task ${opts.spec.id}: "${desc}".`,
    `Done so far: ${acts.slice(-5).join("; ") || "nothing yet"}.${acts.length ? ` Last action: ${acts[acts.length - 1]}.` : ""}`,
  ];
  if (stuck.stuck) lines.push(`Looks stuck: ${stuck.reason}`);
  const continueOpt = `Continue (+${opts.turns} turns)`;
  const options = opts.canSplit
    ? stuck.stuck
      ? ["Split into smaller tasks", continueOpt, "Stop this task"]
      : [continueOpt, "Split into smaller tasks", "Stop this task"]
    : [continueOpt, "Stop this task"];
  const question = lines.join("\n").slice(0, 600);
  return { question, options };
}

export interface RecoveryBrain {
  channel: ManagedChannel;
  agent: AgentDef;
}

/** The recovery call runs on the run's routing brain (the orchestrator's agent). */
export function recoveryBrain(rt: OrchestrationRuntime): RecoveryBrain | undefined {
  const orch = rt.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  const agent = rt.config.agents.find((a) => a.id === orch?.agent);
  if (!agent) return undefined;
  const channel = rt.channelFor(agent.channel);
  return channel.unhealthy ? undefined : { channel, agent };
}

/** Planner-route call with only `submit_recovery`; returns the validated plan or undefined. */
async function recoveryCall(rt: OrchestrationRuntime, brain: RecoveryBrain, brief: string, R: RecoveryState): Promise<RecoveryPlan | undefined> {
  let plan: RecoveryPlan | undefined;
  const ceiling = rt.maxWorkerTurnsCeiling ?? 60;
  const tool = submitRecoveryTool((args) => {
    plan = parseRecoveryArgs(args, { maxSubTasks: R.maxSubTasks, ceiling });
    return `Recovery plan recorded with ${plan.subtasks.length} sub-task(s).`;
  });
  const registry = new ToolRegistry([tool]);
  const mode: ToolsMode = (brain.channel.cfg.modelCaps?.[brain.agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
  const loop = new ToolLoop(
    brain.channel,
    registry,
    async () => ({ kind: "approved" }) as ApprovalDecision,
    { ...DEFAULT_LIMITS, maxModelTurns: 4 },
    rt.clock,
    "You split an oversized or stuck task into smaller sub-tasks. Reply only with submit_recovery.",
    new Set(["submit_recovery"]),
    mode,
  );
  try {
    const result = await loop.run(brain.agent.model, [{ role: "user", content: brief }], {
      onUsage: async (usage, reported) => {
        const costUsd = costOfCall(brain.agent, usage, reported);
        await rt.ledger.record({
          runId: rt.runId,
          roleId: "recovery",
          agentId: brain.agent.id,
          model: brain.agent.model,
          billing: brain.agent.billing ?? "reported",
          inTokens: usage?.in ?? 0,
          outTokens: usage?.out ?? 0,
          costUsd,
        });
        rt.cost.accrued += costUsd;
      },
    }, rt.signal);
    if (result.kind !== "completed") {
      logRecovery(rt, `layer 1: recovery call failed (${result.kind === "failed" ? result.message : result.kind})`);
      return undefined;
    }
  } catch (e) {
    if (e instanceof RunCancelledError || rt.signal.aborted) throw e instanceof Error ? e : new Error("cancelled");
    logRecovery(rt, `layer 1: recovery call failed (${e instanceof Error ? e.message : e})`);
    return undefined;
  }
  return plan;
}

/** Read the sub-task outputs in order and write them to `final_file` through the normal edit path. */
async function assembleFinalFile(
  rt: OrchestrationRuntime,
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
async function splitTask(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  role: RoleDef,
  parent: TaskResult,
  ctx: RecoveryContext,
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
  const brief = [
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
  R.recoveriesUsed++;
  const plan = await recoveryCall(rt, ctx.brain!, brief, R);
  if (!plan) {
    return { ...parent, status: "failed", summary: `${parent.summary}; recovery: no valid submit_recovery; scratch: ${taskDir}` };
  }
  logRecovery(rt, `layer 1: ${fault} on task ${spec.id} -> ${plan.subtasks.length} sub-tasks`);
  const subRole = roleWithScratch(role, taskDir);
  const gate = scratchGate(taskDir, rt.approve);
  const results: { file: string; res: TaskResult }[] = [];
  const filesTouched = new Set(parent.filesTouched);
  let allDone = true;
  for (const [i, sub] of plan.subtasks.entries()) {
    const prior = results
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
    const res = await runTaskRecoverable(rt, subSpec, { role: subRole, extraBriefing: extra, approve: gate }, { ...ctx, depth: ctx.depth + 1 });
    rt.leases.release(subSpec.id);
    results.push({ file: sub.outputFile, res });
    for (const f of res.filesTouched) filesTouched.add(f);
    if (res.status !== "done") {
      allDone = false;
      break;
    }
  }
  if (allDone) {
    const asm = await assembleFinalFile(rt, spec, role, plan, taskDir);
    if (!asm.ok) {
      return { ...parent, status: "failed", summary: `${parent.summary}; recovery: assembly failed (${asm.error}); scratch: ${taskDir}`, filesTouched: [...filesTouched] };
    }
    if (asm.rel) filesTouched.add(asm.rel);
    for (const s of plan.subtasks) {
      try {
        await rt.host.files.delete(`${taskDir}/${s.outputFile}`);
      } catch {
        /* cleanup is best-effort */
      }
    }
    const parts = results.map((r) => `${r.file}: ${r.res.summary.slice(0, R.recoverySummaryChars)}`);
    return {
      status: "done",
      summary: [`split into ${results.length} sub-tasks: ${parts.join(" | ")}`, plan.finalFile ? `assembled -> ${plan.finalFile}` : ""]
        .filter(Boolean)
        .join("; ")
        .slice(0, 1000),
      filesTouched: [...filesTouched],
    };
  }
  const failed = results[results.length - 1]?.res;
  return {
    ...parent,
    status: "failed",
    summary: `${parent.summary}; recovery: sub-task failed (${failed?.summary ?? "unknown"}); scratch: ${taskDir}`,
    filesTouched: [...filesTouched],
  };
}

export interface RecoveryContext {
  depth: number;
  brain?: RecoveryBrain;
}

/**
 * runRoleTask with v1 recovery layers: layer-0 retry (transient once, size
 * hint for read-only level roles), the worker continue question on
 * turn_limit, and layer-1 split for write-capable roles.
 */
export async function runTaskRecoverable(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: Parameters<typeof runRoleTask>[2],
  ctx: RecoveryContext,
): Promise<TaskResult> {
  const R = ensureRecovery(rt);
  const worker = isWriteCapableRole(deps.role);
  const allowSplit = (rt.budgetProfile?.allowSplit ?? true) && ctx.depth < R.maxRecoveryDepth && !!ctx.brain;
  let retried = false;
  let continuations = 0;
  let history: ChatMessage[] | undefined;
  let idemOffset: number | undefined;
  let extraBriefing = deps.extraBriefing;

  while (true) {
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched: [] };
    const res = await runRoleTask(rt, spec, { ...deps, history, idemOffset, extraBriefing });
    const fault = res.fault;
    if (!fault) return res;
    const canRecover = R.recoveriesUsed < R.maxRecoveriesPerRun;

    if (fault === "incomplete_stream" && !retried && canRecover) {
      retried = true;
      R.recoveriesUsed++;
      logRecovery(rt, `layer 0: incomplete_stream on task ${spec.id}, retrying`);
      continue;
    }

    if (!worker) {
      if ((fault === "truncated" || fault === "turn_limit") && !retried && canRecover) {
        retried = true;
        R.recoveriesUsed++;
        logRecovery(rt, `layer 0: ${fault} on task ${spec.id}, retrying with size hint`);
        extraBriefing = [extraBriefing, SIZE_HINT].filter(Boolean).join("\n\n");
        history = undefined;
        idemOffset = undefined;
        continue;
      }
      return res;
    }

    if (fault === "turn_limit") {
      const canAsk =
        R.askOnTurnLimit &&
        continuations < R.maxContinuations &&
        R.questionsUsed < R.maxContinueQuestionsPerRun;
      if (canAsk) {
        R.questionsUsed++;
        const { question, options } = continueQuestion({
          spec,
          turns: res.turnBudget ?? 0,
          transcript: res.transcript ?? [],
          maxActions: R.maxActionsInRecoveryBrief,
          canSplit: allowSplit,
        });
        const raw = rt.askTimed
          ? await rt.askTimed(question, options, R.continueQuestionTimeoutMs)
          : await rt.ask(question, options);
        const answer = raw === undefined ? ({ kind: "timeout" } as const) : mapContinueAnswer(raw);
        logRecovery(rt, `continue question on ${spec.id}: ${answer.kind === "text" ? "guidance" : answer.kind}`);
        if (answer.kind === "continue" || answer.kind === "text") {
          continuations++;
          history = [...(res.transcript ?? [])];
          if (answer.kind === "text") history.push({ role: "user", content: answer.text });
          idemOffset = countToolCalls(history);
          continue;
        }
        if (answer.kind === "stop") {
          return { ...res, status: "failed", summary: "stopped by user at turn limit" };
        }
        // "split" or timeout: fall through to layer 1
      }
    }

    if ((fault === "turn_limit" || fault === "truncated") && allowSplit && canRecover && !rt.signal.aborted) {
      return splitTask(rt, spec, deps.role, res, ctx, R);
    }
    return res;
  }
}
