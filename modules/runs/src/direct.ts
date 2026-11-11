import type { AgentDef, RoleDef } from "@stewart/config";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage } from "@stewart/kernel";
import type { TaskRecord, TaskSpec } from "@stewart/scheduling";
import { runRoleTask } from "@stewart/orchestration";
import { continueQuestion } from "@stewart/recovery";
import type { RecoveryState, RunRuntime, TaskResult } from "@stewart/run-contract";
import { loadProjectContext } from "@stewart/context";
import { DIRECT_TASK_ID, chatRoleDef } from "./consts.js";
import { outcomeOf } from "./outcome.js";
import type { ExecCtx, PlanCtx, Refusal, RunOutcome, RunPlan, RunStrategy } from "./strategy.js";
import type { Run, RunHost } from "./types.js";

export interface DirectRequest {
  channel: ManagedChannel;
  agent: AgentDef;
  text: string;
  images?: string[];
  role?: RoleDef;
  rolePrompt?: string;
  sessionId?: string;
  history?: ChatMessage[];
  budget: { config: EffectiveConfig; profile: BudgetProfile; name?: string; recovery?: RecoveryState };
}

/** Direct-mode strategy: a single task of the chat role through `runRoleTask` (same runtime as orchestrated runs). */
export const directStrategy: RunStrategy<DirectRequest> = {
  async plan(svc: RunHost, projectId: string, req: DirectRequest): Promise<RunPlan | Refusal> {
    const run: Run = {
      id: svc.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: svc.deps.clock.now(),
      messages: [...(req.history ?? []), { role: "user", content: req.text, images: req.images }],
      costUsd: 0,
      sessionId: req.sessionId,
      agentId: req.agent.id,
    };
    const desc = (run.messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
    const rec: TaskRecord = { id: DIRECT_TASK_ID, roleId: (req.role ?? chatRoleDef()).id, title: desc, task: desc, files: [], dependsOn: [], status: "running", filesTouched: [] };
    run.tasks = [rec];
    return { run, title: req.text, config: req.budget.config, profileName: req.budget.name, channelFor: () => req.channel, profile: req.budget.profile };
  },

  async execute({ svc, run, rt, req, ctx }: ExecCtx<DirectRequest>): Promise<RunOutcome> {
    const state = await startRun(svc, run, req);
    try {
      const res = await runTask({ svc, run, rt, req, state });
      return finishRun({ svc, run, rt, ctx }, res);
    } catch (e) {
      rt.leases.releaseAll();
      run.tasks![0].status = "failed";
      throw e;
    }
  },
};

type DirectState = {
  chatRole: RoleDef;
  prompt: string;
  spec: TaskSpec;
  recovery: RecoveryState | undefined;
};

/** Everything a direct run's task loop needs; passed as one object to keep helper signatures short. */
interface DirectCtx {
  svc: RunHost;
  run: Run;
  rt: RunRuntime;
  req: DirectRequest;
  state: DirectState;
}

interface FinishCtx {
  svc: RunHost;
  run: Run;
  rt: RunRuntime;
  ctx: PlanCtx;
}

async function startRun(svc: RunHost, run: Run, req: DirectRequest): Promise<DirectState> {
  const rec = run.tasks![0];
  return {
    chatRole: req.role ?? chatRoleDef(),
    prompt: [req.rolePrompt, await loadProjectContext(svc.deps.host)].filter(Boolean).join(""),
    spec: { id: rec.id, roleId: rec.roleId, title: rec.title, task: rec.task, files: rec.files, dependsOn: rec.dependsOn },
    recovery: req.budget.recovery,
  };
}

function wantsContinue(res: TaskResult, recovery: RecoveryState | undefined, continuations: number, questions: number): boolean {
  return !!(
    res.status === "stopped" &&
    res.fault === "turn_limit" &&
    res.transcript &&
    recovery?.askOnTurnLimit &&
    continuations < recovery.maxContinuations &&
    questions < recovery.maxContinueQuestionsPerRun
  );
}

async function askContinue(c: DirectCtx, res: TaskResult): Promise<{ history: ChatMessage[]; offset: number } | null> {
  const transcript = res.transcript!;
  const { spec } = c.state;
  const r = c.state.recovery!;
  const roleId = c.req.role?.id ?? "chat";
  const contPrompt = continueQuestion({
    spec: { ...spec, roleId },
    turns: res.turnBudget ?? 0,
    transcript,
    maxActions: r.maxActionsInRecoveryBrief,
    canSplit: false,
    timeoutMs: r.continueQuestionTimeoutMs,
  });
  const o = await c.rt.prompt(contPrompt, { roleId, taskId: spec.id });
  const answer = o.kind === "answered" ? o.value : ({ kind: "timeout" } as const);
  c.svc.deps.host.log(`[run ${c.run.id}] continue question: ${answer.kind === "text" ? "guidance" : answer.kind}`);
  if (answer.kind === "stop" || answer.kind === "timeout") return null;
  return {
    offset: transcript.length,
    history: answer.kind === "text" ? [...transcript, { role: "user", content: answer.text }] : transcript,
  };
}

async function runTask(c: DirectCtx): Promise<TaskResult> {
  const { spec, chatRole, prompt, recovery } = c.state;
  const { rt, req } = c;
  let history = c.run.messages;
  let continuations = 0;
  let questions = 0;
  let res = await runRoleTask(rt, spec, { role: chatRole, agent: req.agent, prompt: prompt || undefined, history });
  while (wantsContinue(res, recovery, continuations, questions)) {
    questions++;
    const cont = await askContinue(c, res);
    if (!cont) break;
    continuations++;
    history = cont.history;
    res = await runRoleTask(rt, spec, { role: chatRole, agent: req.agent, prompt: prompt || undefined, history, idemOffset: cont.offset });
  }
  return res;
}

function finishRun(c: FinishCtx, res: TaskResult): RunOutcome {
  const { svc, run, rt, ctx } = c;
  rt.leases.releaseAll();
  if (res.transcript) run.messages = res.transcript;
  const outcome = outcomeOf(run, rt, res);
  const rec = run.tasks![0];
  rec.status = outcome.status === "done" ? "done" : "failed";
  if (outcome.error) rec.error = outcome.error;
  if (rt.cost.accrued > 0) {
    const cost = ctx.ledger.cost(run.id);
    svc.deps.bus.emit({ kind: "cost.summary", runId: run.id, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued, overshootUsd: rt.cost.overshoot(), byRole: cost.byRole, byAgent: cost.byAgent, parked: [], freeFinished: [], suggestions: [] });
  }
  return outcome;
}
