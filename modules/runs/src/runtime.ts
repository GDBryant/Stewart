import type { ManagedChannel } from "@stewart/channels";
import type { Config } from "@stewart/roles-skills";
import type { RunLedger } from "@stewart/ledger";
import { CostLimit } from "@stewart/ledger";
import { LeaseManager } from "@stewart/scheduling";
import type { IdempotencyLog } from "@stewart/run-state";
import { Grants } from "@stewart/permissions";
import { DEFAULT_BUDGET_PROFILES, effectiveRunCapMs, type BudgetProfile } from "@stewart/budget";
import { recoveryState, type RunRuntime } from "@stewart/agent-loop";
import type { Run, RunService } from "./service.js";

/** Single construction point for the per-run orchestration runtime (resume and fresh runs). */
export function buildRunRuntime(
  svc: RunService,
  run: Run,
  opts: {
    config: Config;
    channelFor(channelId: string): ManagedChannel;
    ledger: RunLedger;
    stateDir: string;
    idem: IdempotencyLog;
    profile?: BudgetProfile;
    ask?: (question: string, options?: string[]) => Promise<string>;
    onGraphChange?: RunRuntime["onGraphChange"];
  },
): RunRuntime {
  const s = opts.config.settings;
  const cost = new CostLimit(s.costLimit.perRunUsd, s.costLimit.onLimit, opts.ledger.cost(run.id).costUsd);
  const grants = new Grants();
  const profile = opts.profile ?? DEFAULT_BUDGET_PROFILES.normal;
  const ms = effectiveRunCapMs(s.maxRunHours, profile);
  const timeCap: NonNullable<RunRuntime["timeCap"]> = { ms, hit: false, cancel: () => {} };
  if (ms > 0) {
    const timer = svc.deps.clock.setTimeout(
      () => {
        if (run.status === "running") {
          timeCap.hit = true;
          run.controller.abort();
        }
      },
      Math.max(0, ms - (svc.deps.clock.now() - run.startedAt)),
    );
    timeCap.cancel = () => timer.cancel();
  }
  return {
    runId: run.id,
    projectId: run.projectId,
    host: svc.deps.host,
    clock: svc.deps.clock,
    ids: svc.deps.ids,
    bus: svc.deps.bus,
    recoveryService: svc.recoveryService,
    config: opts.config,
    stateDir: opts.stateDir,
    channelFor: opts.channelFor,
    ledger: opts.ledger,
    leases: new LeaseManager(),
    idem: opts.idem,
    cost,
    signal: run.controller.signal,
    startedAt: run.startedAt,
    leaseWaitMs: s.leaseWaitSeconds * 1000,
    skillBudgetTokens: s.skillBudgetTokens,
    maxNestedDispatches: s.maxNestedDispatches,
    maxReplans: s.maxReplans,
    maxRunHours: s.maxRunHours,
    maxWorkerTurnsCeiling: s.maxWorkerTurnsCeiling,
    budgetProfile: profile,
    planGate: s.planGate,
    onGraphChange: opts.onGraphChange,
    recovery: recoveryState(s),
    ask: opts.ask ?? svc.askUser(run.id, "orchestrator"),
    askTimed: svc.askTimed(run.id, run.controller.signal, "orchestrator"),
    approve: (call, preview) => svc.gate(run.id, grants)(call, preview),
    timeCap,
  };
}
