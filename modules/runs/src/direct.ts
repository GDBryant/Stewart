import type { AgentDef, RoleDef } from "@stewart/config";
import type { Config } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage } from "@stewart/kernel";
import type { TaskRecord, TaskSpec } from "@stewart/scheduling";
import { runRoleTask } from "@stewart/orchestration";
import { continueQuestion } from "@stewart/recovery";
import type { RecoveryState, RunRuntime } from "@stewart/agent-loop";
import { loadProjectContext } from "@stewart/context";
import { DIRECT_TASK_ID, chatRoleDef, timeCapMessage } from "./consts.js";
import type { PlanCtx, Refusal, RunOutcome, RunPlan, RunStrategy } from "./strategy.js";
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
  budget: { config: Config; profile: BudgetProfile; name?: string; recovery?: RecoveryState };
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

  async execute(svc: RunHost, run: Run, rt: RunRuntime, req: DirectRequest, ctx: PlanCtx): Promise<RunOutcome> {
    const runId = run.id;
    const chatRole: RoleDef = req.role ?? chatRoleDef();
    const prompt = [req.rolePrompt, await loadProjectContext(svc.deps.host)].filter(Boolean).join("");
    const rec = run.tasks![0];
    const spec: TaskSpec = { id: rec.id, roleId: rec.roleId, title: rec.title, task: rec.task, files: rec.files, dependsOn: rec.dependsOn };
    const recovery = req.budget.recovery;
    try {
      let history = run.messages;
      let offset = 0;
      let continuations = 0;
      let questions = 0;
      let res = await runRoleTask(rt, spec, { role: chatRole, agent: req.agent, prompt: prompt || undefined, history });
      while (res.status === "stopped" && res.fault === "turn_limit" && res.transcript && recovery?.askOnTurnLimit && continuations < recovery.maxContinuations && questions < recovery.maxContinueQuestionsPerRun) {
        questions++;
        const transcript = res.transcript;
        const contPrompt = continueQuestion({
          spec: { ...spec, roleId: req.role?.id ?? "chat" },
          turns: res.turnBudget ?? 0,
          transcript,
          maxActions: recovery.maxActionsInRecoveryBrief,
          canSplit: false,
          timeoutMs: recovery.continueQuestionTimeoutMs,
        });
        const o = await rt.prompt(contPrompt, { roleId: req.role?.id ?? "chat", taskId: spec.id });
        const answer = o.kind === "answered" ? o.value : ({ kind: "timeout" } as const);
        svc.deps.host.log(`[run ${runId}] continue question: ${answer.kind === "text" ? "guidance" : answer.kind}`);
        if (answer.kind === "stop" || answer.kind === "timeout") break;
        continuations++;
        offset = transcript.length;
        history = answer.kind === "text" ? [...transcript, { role: "user", content: answer.text }] : transcript;
        res = await runRoleTask(rt, spec, { role: chatRole, agent: req.agent, prompt: prompt || undefined, history, idemOffset: offset });
      }
      rt.leases.releaseAll();
      if (res.transcript) run.messages = res.transcript;
      const outcome: RunOutcome =
        res.status === "cancelled" || run.status === "cancelled"
          ? rt.timeCap?.hit
            ? { status: "interrupted", event: "stopped", error: timeCapMessage(rt.timeCap.ms) }
            : { status: "cancelled", event: "cancelled" }
          : res.status === "failed"
            ? { status: "failed", event: "failed", error: res.summary }
            : res.status === "stopped" || res.status === "parked"
              ? { status: "interrupted", event: "stopped", error: res.summary }
              : { status: "done", event: "done" };
      rec.status = outcome.status === "done" ? "done" : "failed";
      if (outcome.error) rec.error = outcome.error;
      if (rt.cost.accrued > 0) {
        const c = ctx.ledger.cost(runId);
        svc.deps.bus.emit({ kind: "cost.summary", runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued, overshootUsd: rt.cost.overshoot(), byRole: c.byRole, byAgent: c.byAgent, parked: [], freeFinished: [], suggestions: [] });
      }
      return outcome;
    } catch (e) {
      rt.leases.releaseAll();
      rec.status = "failed";
      throw e;
    }
  },
};
