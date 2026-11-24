import type { AgentDef, Effort, RoleDef } from "@stewart/config";
import { divertTarget, type EffectiveConfig } from "@stewart/roles-skills";

/** The capability-aware divert decision: the agent to switch to after a loop-guard trip, with the effort its run should use. */
export interface DivertDecision {
  next: AgentDef;
  effort?: Effort;
}

/**
 * One loop-guard divert per run: when the tripping agent tripped the loop guard, pick the strongest
 * reasoning-capable eligible agent (or the user-configured one) to switch to. `triedIds` are the agent ids
 * already attempted this run (the tripping one included); `run` carries the per-run `divertUsed` flag so the
 * divert fires at most once. Returns undefined for any non-loop-guard failure, once the divert is spent, or when `onLoopGuard.enabled` is false, so
 * the caller keeps the static chain (no regression). Caps come from `divertTarget` via the probe-merged config.
 */
export function maybeDivert(opts: {
  cfg: EffectiveConfig;
  role: RoleDef;
  current: AgentDef;
  triedIds: string[];
  reason: string;
  run: { divertUsed?: boolean };
}): DivertDecision | undefined {
  const { cfg, role, current, triedIds, reason, run } = opts;
  if (reason !== "loop_guard" || run.divertUsed) return undefined;
  const esc = cfg.settings.escalation?.onLoopGuard;
  if (esc?.enabled === false) return undefined;
  const next = divertTarget({ candidates: cfg.agents, current, channels: cfg.channels, role, explicit: esc?.agent, tried: triedIds });
  if (!next) return undefined;
  run.divertUsed = true;
  return { next, ...(esc?.effort ? { effort: esc.effort } : {}) };
}
