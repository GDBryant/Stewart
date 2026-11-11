import type { ChatMessage, FaultKind } from "@stewart/kernel";
import { isWriteCapableRole } from "@stewart/roles-skills";
import {
  countToolCalls,
  type OrchestrationRuntime,
  type RecoveryContext,
  type RecoveryState,
  type RoleTaskDeps,
  type RunTaskOnce,
  type TaskResult,
} from "@stewart/agent-loop";
import type { TaskSpec } from "@stewart/scheduling";
import { SIZE_HINT, ensureRecovery, logRecovery } from "./consts.js";
import { splitTask, type Recoverable } from "./split.js";
import { continueQuestion } from "./continue.js";

export function recoverable(runOnce: RunTaskOnce): Recoverable {
  const self: Recoverable = (rt, spec, deps, ctx) => runTaskRecoverable(rt, spec, deps, ctx, runOnce, self);
  return self;
}

type RetryState = { retried: boolean; continuations: number; history?: ChatMessage[]; idemOffset?: number; extraBriefing?: string };

async function runTaskRecoverable(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: RoleTaskDeps,
  ctx: RecoveryContext,
  runOnce: RunTaskOnce,
  self: Recoverable,
): Promise<TaskResult> {
  const R = ensureRecovery(rt);
  const worker = isWriteCapableRole(deps.role);
  const allowSplit = (rt.budgetProfile?.allowSplit ?? true) && ctx.depth < R.maxRecoveryDepth && !!ctx.brain;
  const state: RetryState = { retried: false, continuations: 0, extraBriefing: deps.extraBriefing };

  while (true) {
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched: [] };
    const res = await runOnce(rt, spec, { ...deps, history: state.history, idemOffset: state.idemOffset, extraBriefing: state.extraBriefing });
    const fault = res.fault;
    if (!fault) return res;
    const canRecover = R.recoveriesUsed < R.maxRecoveriesPerRun;

    if (layer0Retry(rt, spec, fault, worker, canRecover, R, state)) continue;
    if (!worker) return res;
    const out = await recoverFault(rt, spec, deps, ctx, res, R, self, allowSplit, canRecover, state);
    if (out === "retry") continue;
    return out;
  }
}

async function recoverFault(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: RoleTaskDeps,
  ctx: RecoveryContext,
  res: TaskResult,
  R: RecoveryState,
  self: Recoverable,
  allowSplit: boolean,
  canRecover: boolean,
  state: RetryState,
): Promise<"retry" | TaskResult> {
  if (res.fault === "turn_limit") {
    const decision = await askContinue(rt, spec, deps.role.id, res, allowSplit, R, state);
    if (decision === "retry") return "retry";
    if (decision === "stop") return { ...res, status: "failed", summary: "stopped by user at turn limit" };
  }
  return (await trySplit(rt, spec, deps, ctx, res, R, self, allowSplit, canRecover)) ?? res;
}

function layer0Retry(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  fault: FaultKind,
  worker: boolean,
  canRecover: boolean,
  R: RecoveryState,
  state: RetryState,
): boolean {
  if (fault === "incomplete_stream" && !state.retried && canRecover) {
    state.retried = true;
    R.recoveriesUsed++;
    logRecovery(rt, `layer 0: incomplete_stream on task ${spec.id}, retrying`);
    return true;
  }
  if (!worker && (fault === "truncated" || fault === "turn_limit") && !state.retried && canRecover) {
    state.retried = true;
    R.recoveriesUsed++;
    logRecovery(rt, `layer 0: ${fault} on task ${spec.id}, retrying with size hint`);
    state.extraBriefing = [state.extraBriefing, SIZE_HINT].filter(Boolean).join("\n\n");
    state.history = undefined;
    state.idemOffset = undefined;
    return true;
  }
  return false;
}

async function askContinue(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  roleId: string,
  res: TaskResult,
  allowSplit: boolean,
  R: RecoveryState,
  state: RetryState,
): Promise<"retry" | "stop" | "fallthrough"> {
  const canAsk = R.askOnTurnLimit && state.continuations < R.maxContinuations && R.questionsUsed < R.maxContinueQuestionsPerRun;
  if (!canAsk) return "fallthrough";
  R.questionsUsed++;
  const prompt = continueQuestion({
    spec,
    turns: res.turnBudget ?? 0,
    transcript: res.transcript ?? [],
    maxActions: R.maxActionsInRecoveryBrief,
    canSplit: allowSplit,
    timeoutMs: R.continueQuestionTimeoutMs,
  });
  const o = await rt.prompt(prompt, { roleId, taskId: spec.id });
  const answer = o.kind === "answered" ? o.value : ({ kind: "timeout" } as const);
  logRecovery(rt, `continue question on ${spec.id}: ${answer.kind === "text" ? "guidance" : answer.kind}`);
  return applyContinueAnswer(answer, res, state);
}

function applyContinueAnswer(answer: { kind: string; text?: string }, res: TaskResult, state: RetryState): "retry" | "stop" | "fallthrough" {
  if (answer.kind === "continue" || answer.kind === "text") {
    state.continuations++;
    state.history = [...(res.transcript ?? [])];
    if (answer.kind === "text") state.history.push({ role: "user", content: answer.text ?? "" });
    state.idemOffset = countToolCalls(state.history);
    return "retry";
  }
  if (answer.kind === "stop") return "stop";
  // "split" or timeout: fall through to layer 1
  return "fallthrough";
}

async function trySplit(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: RoleTaskDeps,
  ctx: RecoveryContext,
  res: TaskResult,
  R: RecoveryState,
  self: Recoverable,
  allowSplit: boolean,
  canRecover: boolean,
): Promise<TaskResult | undefined> {
  if ((res.fault === "turn_limit" || res.fault === "truncated") && allowSplit && canRecover && !rt.signal.aborted) {
    return splitTask(rt, spec, deps.role, res, { ...ctx, recurse: self }, R);
  }
  return undefined;
}
