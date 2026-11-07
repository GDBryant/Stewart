import type { ChatMessage } from "@stewart/kernel";
import { isWriteCapableRole } from "@stewart/roles-skills";
import { countToolCalls, type OrchestrationRuntime, type RecoveryContext, type RoleTaskDeps, type RunTaskOnce, type TaskResult } from "@stewart/agent-loop";
import type { TaskSpec } from "@stewart/scheduling";
import { SIZE_HINT, ensureRecovery, logRecovery } from "./consts.js";
import { splitTask, type Recoverable } from "./split.js";
import { continueQuestion, mapContinueAnswer } from "./continue.js";

export function recoverable(runOnce: RunTaskOnce): Recoverable {
  const self: Recoverable = (rt, spec, deps, ctx) => runTaskRecoverable(rt, spec, deps, ctx, runOnce, self);
  return self;
}

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
  let retried = false;
  let continuations = 0;
  let history: ChatMessage[] | undefined;
  let idemOffset: number | undefined;
  let extraBriefing = deps.extraBriefing;

  while (true) {
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched: [] };
    const res = await runOnce(rt, spec, { ...deps, history, idemOffset, extraBriefing });
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
      return splitTask(rt, spec, deps.role, res, { ...ctx, recurse: self }, R);
    }
    return res;
  }
}
