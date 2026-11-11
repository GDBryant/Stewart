import type { ChatMessage, FaultKind } from "@stewart/kernel";
import { isWriteCapableRole } from "@stewart/roles-skills";
import { countToolCalls } from "@stewart/agent-loop";
import { type RunRuntime, type RecoveryContext, type RecoveryState, type RoleTaskDeps, type RunTaskOnce, type TaskResult } from "@stewart/run-contract";
import type { TaskSpec } from "@stewart/scheduling";
import { SIZE_HINT, ensureRecovery, logRecovery } from "./consts.js";
import { splitTask, type Recoverable, type SplitRequest } from "./split.js";
import { continueQuestion } from "./continue.js";

export function recoverable(runOnce: RunTaskOnce): Recoverable {
  const self: Recoverable = (rt, spec, deps, ctx) => runTaskRecoverable({ rt, spec, deps, ctx, runOnce, self });
  return self;
}

type RetryState = { retried: boolean; continuations: number; history?: ChatMessage[]; idemOffset?: number; extraBriefing?: string };

/** Inputs for one recoverable task run, as handed in by `recoverable`. */
export interface RecoverableInput {
  rt: RunRuntime;
  spec: TaskSpec;
  deps: RoleTaskDeps;
  ctx: RecoveryContext;
  runOnce: RunTaskOnce;
  self: Recoverable;
}

/** A recoverable run: the inputs plus the shared recovery counters, the run flags and the mutable retry state. */
export interface RecoveryRun extends RecoverableInput {
  R: RecoveryState;
  worker: boolean;
  allowSplit: boolean;
  state: RetryState;
}

function splitAllowed(rt: RunRuntime, ctx: RecoveryContext, R: RecoveryState): boolean {
  return (rt.budgetProfile?.allowSplit ?? true) && ctx.depth < R.maxRecoveryDepth && !!ctx.brain;
}

async function runTaskRecoverable(input: RecoverableInput): Promise<TaskResult> {
  const R = ensureRecovery(input.rt);
  const run: RecoveryRun = {
    ...input,
    R,
    worker: isWriteCapableRole(input.deps.role),
    allowSplit: splitAllowed(input.rt, input.ctx, R),
    state: { retried: false, continuations: 0, extraBriefing: input.deps.extraBriefing },
  };
  const { rt, spec, deps, state } = run;
  while (true) {
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched: [] };
    const res = await run.runOnce(rt, spec, { ...deps, history: state.history, idemOffset: state.idemOffset, extraBriefing: state.extraBriefing });
    const fault = res.fault;
    if (!fault) return res;
    // Snapshot taken before any recovery layer runs; layers below use this value, not a fresh read.
    const canRecover = R.recoveriesUsed < R.maxRecoveriesPerRun;
    if (layer0Retry(run, fault, canRecover)) continue;
    if (!run.worker) return res;
    const out = await recoverFault(run, res, canRecover);
    if (out === "retry") continue;
    return out;
  }
}

async function recoverFault(run: RecoveryRun, res: TaskResult, canRecover: boolean): Promise<"retry" | TaskResult> {
  if (res.fault === "turn_limit") {
    const decision = await askContinue(run, res);
    if (decision === "retry") return "retry";
    if (decision === "stop") return { ...res, status: "failed", summary: "stopped by user at turn limit" };
  }
  return (await trySplit(run, res, canRecover)) ?? res;
}

function layer0Retry(run: RecoveryRun, fault: FaultKind, canRecover: boolean): boolean {
  const { rt, spec, R, state, worker } = run;
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

async function askContinue(run: RecoveryRun, res: TaskResult): Promise<"retry" | "stop" | "fallthrough"> {
  const { rt, spec, deps, R, state, allowSplit } = run;
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
  const o = await rt.prompt(prompt, { roleId: deps.role.id, taskId: spec.id });
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

async function trySplit(run: RecoveryRun, res: TaskResult, canRecover: boolean): Promise<TaskResult | undefined> {
  const { rt, spec, deps, ctx, R, self, allowSplit } = run;
  if ((res.fault === "turn_limit" || res.fault === "truncated") && allowSplit && canRecover && !rt.signal.aborted) {
    const req: SplitRequest = { rt, spec, role: deps.role, ctx: { ...ctx, recurse: self }, R };
    return splitTask(req, res);
  }
  return undefined;
}
