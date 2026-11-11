import type { ManagedChannel } from "@stewart/channels";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { RunLedger } from "@stewart/ledger";
import { CostLimit } from "@stewart/ledger";
import { LeaseManager } from "@stewart/scheduling";
import type { IdempotencyLog } from "@stewart/run-state";
import { DEFAULT_BUDGET_PROFILES, effectiveRunCapMs, type BudgetProfile } from "@stewart/budget";
import { recoveryState, type RunRuntime } from "@stewart/run-contract";
import type { Run, RunHost } from "./types.js";

/** Per-run inputs to buildRunRuntime, passed as one named object. */
export interface RuntimeOpts {
  config: EffectiveConfig;
  channelFor(channelId: string): ManagedChannel;
  ledger: RunLedger;
  stateDir: string;
  idem: IdempotencyLog;
  profile?: BudgetProfile;
  onGraphChange?: RunRuntime["onGraphChange"];
}

/** Arms the run time cap; the timer aborts a still-running run and flags `hit`. */
function startTimeCap(svc: RunHost, run: Run, ms: number): NonNullable<RunRuntime["timeCap"]> {
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
  return timeCap;
}

/** Service-wired fields: host, clock, bus and the run's own signal and prompt routing. */
function hostFields(svc: RunHost, run: Run) {
  return {
    host: svc.deps.host,
    clock: svc.deps.clock,
    ids: svc.deps.ids,
    bus: svc.deps.bus,
    recoveryService: svc.recoveryService,
    features: svc.deps.features,
    signal: run.controller.signal,
    prompt: svc.prompt(run.id, run.controller.signal, "orchestrator"),
    approve: svc.permissions.gate(run.id, run.controller.signal),
  };
}

/** Fields copied from the effective settings; `profile` is the resolved budget profile. */
function settingsFields(s: EffectiveConfig["settings"], profile: BudgetProfile) {
  return {
    leaseWaitMs: s.leaseWaitSeconds * 1000,
    skillBudgetTokens: s.skillBudgetTokens,
    maxNestedDispatches: s.maxNestedDispatches,
    maxReplans: s.maxReplans,
    maxRunHours: s.maxRunHours,
    maxWorkerTurnsCeiling: s.maxWorkerTurnsCeiling,
    budgetProfile: profile,
    planGate: s.planGate,
    recovery: recoveryState(s),
  };
}

/** Single construction point for the per-run orchestration runtime (resume and fresh runs). */
export function buildRunRuntime(svc: RunHost, run: Run, opts: RuntimeOpts): RunRuntime {
  const s = opts.config.settings;
  const cost = new CostLimit(s.costLimit.perRunUsd, s.costLimit.onLimit, opts.ledger.cost(run.id).costUsd);
  const profile = opts.profile ?? DEFAULT_BUDGET_PROFILES.normal;
  const timeCap = startTimeCap(svc, run, effectiveRunCapMs(s.maxRunHours, profile));
  return {
    runId: run.id,
    projectId: run.projectId,
    ...hostFields(svc, run),
    config: opts.config,
    stateDir: opts.stateDir,
    channelFor: opts.channelFor,
    ledger: opts.ledger,
    leases: new LeaseManager(),
    idem: opts.idem,
    cost,
    startedAt: run.startedAt,
    ...settingsFields(s, profile),
    onGraphChange: opts.onGraphChange,
    timeCap,
  };
}
