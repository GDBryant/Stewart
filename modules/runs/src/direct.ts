import type { AgentDef, RoleDef } from "@stewart/config";
import type { Config } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage } from "@stewart/kernel";
import type { TaskRecord, TaskSpec } from "@stewart/scheduling";
import { IdempotencyLog } from "@stewart/run-state";
import { runRoleTask } from "@stewart/orchestration";
import { continueQuestion } from "@stewart/recovery";
import type { RecoveryState } from "@stewart/agent-loop";
import { loadProjectContext } from "@stewart/context";
import { buildRunRuntime } from "./runtime.js";
import { DIRECT_TASK_ID, chatRoleDef, timeCapMessage } from "./consts.js";
import type { Run, RunHost, RunStatus } from "./types.js";

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
export const directStrategy = {
  async start(svc: RunHost, projectId: string, req: DirectRequest): Promise<Run> {
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
    svc.register(run);
    const bus = svc.deps.bus;
    bus.emit({ kind: "run.started", runId: run.id, title: req.text.slice(0, 80), ...(req.budget.name ? { profile: req.budget.name } : {}) });
    void drive(svc, run, req).catch((e) => {
      if (run.status === "running") run.status = "failed";
      bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  },
};

async function drive(svc: RunHost, run: Run, req: DirectRequest): Promise<void> {
  const bus = svc.deps.bus;
  const runId = run.id;
  const ledger = await svc.ledgerFor();
  const stateDir = await svc.deps.host.workspace.stateDir();
  const idem = new IdempotencyLog(svc.deps.host, `${stateDir}/scratch/${runId}/executed.jsonl`, runId);
  await idem.load();
  const rt = buildRunRuntime(svc, run, { config: req.budget.config, channelFor: () => req.channel, ledger, stateDir, idem, profile: req.budget.profile });
  const chatRole: RoleDef = req.role ?? chatRoleDef();
  const prompt = [req.rolePrompt, await loadProjectContext(svc.deps.host)].filter(Boolean).join("");
  const desc = (run.messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
  const spec: TaskSpec = { id: DIRECT_TASK_ID, roleId: chatRole.id, title: desc, task: desc, files: [], dependsOn: [] };
  const recovery = req.budget.recovery;
  const rec: TaskRecord = { ...spec, status: "running", filesTouched: [] };
  run.tasks = [rec];
  await svc.journal(run, stateDir);
  const finish = async (status: RunStatus, event: "done" | "failed" | "cancelled" | "stopped", error?: string) => {
    run.status = status;
    run.costUsd = rt.cost.accrued;
    rec.status = status === "done" ? "done" : "failed";
    if (error) rec.error = error;
    await svc.journal(run, stateDir);
    await svc.saveHistory(run);
    if (rt.cost.accrued > 0) {
      const c = ledger.cost(runId);
      bus.emit({ kind: "cost.summary", runId, capUsd: rt.cost.cap, accruedUsd: rt.cost.accrued, overshootUsd: rt.cost.overshoot(), byRole: c.byRole, byAgent: c.byAgent, parked: [], freeFinished: [], suggestions: [] });
    }
    bus.emit({ kind: "run.finished", runId, status: event, ...(error ? { error } : {}) });
  };
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
    if (res.status === "cancelled" || run.status === "cancelled") {
      if (rt.timeCap?.hit) return await finish("interrupted", "stopped", timeCapMessage(rt.timeCap.ms));
      return await finish("cancelled", "cancelled");
    }
    if (res.status === "failed") return await finish("failed", "failed", res.summary);
    if (res.status === "stopped" || res.status === "parked") return await finish("interrupted", "stopped", res.summary);
    await finish("done", "done");
  } catch (e) {
    rt.leases.releaseAll();
    rec.status = "failed";
    await svc.journal(run, stateDir);
    await svc.saveHistory(run);
    throw e;
  } finally {
    rt.timeCap?.cancel();
  }
}
