import type { ManagedChannel } from "@stewart/channels";
import type { RunLedger } from "@stewart/ledger";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { BudgetProfile } from "@stewart/budget";
import { IdempotencyLog } from "@stewart/run-state";
import type { RunRuntime } from "@stewart/run-contract";
import { buildRunRuntime } from "./runtime.js";
import { runHandle, type RunHandle } from "./handle.js";
import type { Run, RunHost, RunStatus } from "./types.js";

export interface PlanCtx {
  stateDir: string;
  ledger: RunLedger;
}

export type RunPlan = {
  /** status "running", tasks seeded when the mode knows them. */
  run: Run;
  /** run.started title (sliced to 80 by the pipeline). */
  title: string;
  config: EffectiveConfig;
  profileName?: string;
  channelFor(channelId: string): ManagedChannel;
  profile?: BudgetProfile;
  onGraphChange?: RunRuntime["onGraphChange"];
};

export type Refusal = { ok: false; reason: string };
export type RunOutcome = { status: RunStatus; event: "done" | "failed" | "cancelled" | "stopped" | "no_dispatch"; error?: string };

export interface RunStrategy<Req> {
  /** Pre-flight + Run construction; may refuse before anything is registered or emitted. */
  plan(svc: RunHost, projectId: string, req: Req, ctx: PlanCtx): Promise<RunPlan | Refusal>;
  /** Drives the run on the shared runtime; must not emit run.finished or journal the final state (the pipeline does). */
  execute(svc: RunHost, run: Run, rt: RunRuntime, req: Req, ctx: PlanCtx): Promise<RunOutcome>;
}

/** The one pipeline: plan → register + run.started → idem + journal + runtime → execute → finish (status, costUsd, journal, saveHistory, run.finished). Exceptions → failed. */
export async function runPipeline<Req>(svc: RunHost, strategy: RunStrategy<Req>, projectId: string, req: Req): Promise<{ ok: true; run: Run; handle: RunHandle } | Refusal> {
  const ledger = await svc.ledgerFor();
  const stateDir = await svc.deps.host.workspace.stateDir();
  const ctx: PlanCtx = { stateDir, ledger };
  const plan = await strategy.plan(svc, projectId, req, ctx);
  if ("reason" in plan) return plan;
  const { run } = plan;
  const handle = runHandle(svc.deps.bus, run.id);
  run.handle = handle;
  svc.register(run);
  svc.deps.bus.emit({ kind: "run.started", runId: run.id, title: plan.title.slice(0, 80), ...(plan.profileName ? { profile: plan.profileName } : {}) });
  void drive(svc, strategy, run, plan, req, ctx);
  return { ok: true, run, handle };
}

async function drive<Req>(svc: RunHost, strategy: RunStrategy<Req>, run: Run, plan: RunPlan, req: Req, ctx: PlanCtx): Promise<void> {
  const bus = svc.deps.bus;
  const idem = new IdempotencyLog(svc.deps.host, `${ctx.stateDir}/scratch/${run.id}/executed.jsonl`, run.id);
  await idem.load();
  await svc.journal(run, ctx.stateDir);
  const rt = buildRunRuntime(svc, run, {
    config: plan.config,
    channelFor: plan.channelFor,
    ledger: ctx.ledger,
    stateDir: ctx.stateDir,
    idem,
    profile: plan.profile,
    onGraphChange: plan.onGraphChange,
  });
  try {
    const outcome = await strategy.execute(svc, run, rt, req, ctx);
    run.status = outcome.status;
    run.costUsd = rt.cost.accrued;
    await svc.journal(run, ctx.stateDir);
    await svc.saveHistory(run);
    bus.emit({ kind: "run.finished", runId: run.id, status: outcome.event, ...(outcome.error ? { error: outcome.error } : {}) });
  } catch (e) {
    if (run.status === "running") run.status = "failed";
    await svc.journal(run, ctx.stateDir);
    await svc.saveHistory(run);
    bus.emit({ kind: "run.finished", runId: run.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
  } finally {
    rt.timeCap?.cancel();
  }
}
