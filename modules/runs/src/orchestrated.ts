import type { Config } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import type { ManagedChannel } from "@stewart/channels";
import { IdempotencyLog } from "@stewart/run-state";
import { runOrchestrated } from "@stewart/orchestration";
import { buildRunRuntime } from "./runtime.js";
import { timeCapMessage } from "./consts.js";
import type { Run, RunHost, RunStatus } from "./types.js";

export interface OrchestratedRequest {
  config: Config;
  channelFor(channelId: string): ManagedChannel;
  text: string;
  runId?: string;
  sessionId?: string;
  profile?: BudgetProfile;
  profileName?: string;
}

/** Orchestrated strategy: the Orchestrator routes work through `dispatch`. */
export const orchestratedStrategy = {
  async start(svc: RunHost, projectId: string, req: OrchestratedRequest): Promise<Run> {
    const run: Run = {
      id: req.runId ?? svc.deps.ids.next("run"),
      projectId,
      status: "running",
      controller: new AbortController(),
      startedAt: svc.deps.clock.now(),
      messages: [{ role: "user", content: req.text }],
      costUsd: 0,
      sessionId: req.sessionId,
    };
    svc.register(run);
    svc.deps.bus.emit({ kind: "run.started", runId: run.id, title: req.text.slice(0, 80), ...(req.profileName ? { profile: req.profileName } : {}) });
    void drive(svc, run, req).catch((e) => {
      if (run.status === "running") run.status = "failed";
      svc.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return run;
  },
};

async function drive(
  svc: RunHost,
  run: Run,
  req: { config: Config; channelFor(channelId: string): ManagedChannel; text: string; profile?: BudgetProfile },
): Promise<void> {
  const ledger = await svc.ledgerFor();
  const stateDir = await svc.deps.host.workspace.stateDir();
  await svc.journal(run, stateDir);
  const idem = new IdempotencyLog(svc.deps.host, `${stateDir}/scratch/${run.id}/executed.jsonl`, run.id);
  await idem.load();
  const rt = buildRunRuntime(svc, run, {
    config: req.config,
    channelFor: req.channelFor,
    ledger,
    stateDir,
    idem,
    profile: req.profile,
    onGraphChange: async (g) => {
      run.tasks = g.toJSON();
      await svc.journal(run, stateDir);
    },
    ask: svc.askUser(run.id, "orchestrator"),
  });
  const cost = rt.cost;
  let outcome: Awaited<ReturnType<typeof runOrchestrated>>;
  try {
    outcome = await runOrchestrated(rt, req.text);
  } finally {
    rt.timeCap?.cancel();
  }
  run.costUsd = cost.accrued;
  if (run.status === "cancelled") {
    await svc.journal(run, stateDir);
    await svc.saveHistory(run);
    svc.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "cancelled" });
    return;
  }
  if (rt.timeCap?.hit) {
    run.status = "interrupted";
    await svc.journal(run, stateDir);
    await svc.saveHistory(run);
    svc.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "stopped", error: timeCapMessage(rt.timeCap.ms) });
    return;
  }
  if (outcome.status === "failed") {
    run.status = "failed";
    await svc.journal(run, stateDir);
    await svc.saveHistory(run);
    svc.deps.bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: outcome.error });
    return;
  }
  const finalStatus: RunStatus = outcome.status === "stopped" || outcome.status === "no_dispatch" ? outcome.status : "done";
  run.status = finalStatus;
  await svc.journal(run, stateDir);
  await svc.saveHistory(run);
  svc.deps.bus.emit({ kind: "run.finished", runId: run.id, status: finalStatus, error: outcome.error });
}
