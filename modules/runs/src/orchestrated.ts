import type { ChatMessage } from "@stewart/kernel";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import { runOrchestrated } from "@stewart/orchestration";
import type { RunRuntime } from "@stewart/run-contract";
import { timeCapMessage } from "./consts.js";
import type { PlanCtx, Refusal, RunOutcome, RunPlan, RunStrategy } from "./strategy.js";
import type { Run, RunHost } from "./types.js";

export interface OrchestratedRequest {
  config: EffectiveConfig;
  channelFor(channelId: string): ManagedChannel;
  text: string;
  runId?: string;
  sessionId?: string;
  history?: ChatMessage[];
  profile?: BudgetProfile;
  profileName?: string;
}

/** Orchestrated strategy: the Orchestrator routes work through `dispatch`. */
export const orchestratedStrategy: RunStrategy<OrchestratedRequest> = {
  async plan(svc: RunHost, projectId: string, req: OrchestratedRequest, ctx: PlanCtx): Promise<RunPlan | Refusal> {
    const run: Run = {
      id: req.runId ?? svc.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: svc.deps.clock.now(),
      messages: [
        ...(req.history ?? [])
          .filter((m) => m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length && !!m.content.trim()))
          .map((m): ChatMessage => (m.role === "assistant" ? { role: "assistant", content: m.content } : m)),
        { role: "user", content: req.text },
      ],
      costUsd: 0,
      sessionId: req.sessionId,
    };
    return {
      run,
      title: req.text,
      config: req.config,
      profileName: req.profileName,
      channelFor: req.channelFor,
      profile: req.profile,
      onGraphChange: async (g) => {
        run.tasks = g.toJSON();
        await svc.journal(run, ctx.stateDir);
      },
    };
  },

  async execute(svc: RunHost, run: Run, rt: RunRuntime, req: OrchestratedRequest): Promise<RunOutcome> {
    const outcome = await runOrchestrated(rt, req.text, run.messages.slice(0, -1));
    if (outcome.reply) run.messages.push({ role: "assistant", content: outcome.reply });
    if (run.status === "cancelled") return { status: "cancelled", event: "cancelled" };
    if (rt.timeCap?.hit) return { status: "interrupted", event: "stopped", error: timeCapMessage(rt.timeCap.ms) };
    if (outcome.status === "failed") return { status: "failed", event: "failed", error: outcome.error };
    const status = outcome.status === "stopped" || outcome.status === "no_dispatch" ? outcome.status : "done";
    return { status, event: status, error: outcome.error };
  },
};
