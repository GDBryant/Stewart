import type { AgentDef } from "@stewart/config";
import type { RunEvent } from "@stewart/protocol";
import { costOfCall, type RunLedger } from "@stewart/ledger";

/** What recording a child's usage needs from the run: shared accrual, the cap and the bus. */
export interface UsageCtx {
  bus: { emit(ev: RunEvent): void };
  runId: string;
  taskId: string;
  role: { id: string };
  agent: AgentDef;
  ledger: RunLedger;
  parent: { controller: AbortController; accrued: number; costCapped: boolean };
  costCapUsd: number;
}

/** Ledger one child request, add it to the run's accrued cost, and abort the run past the cap. */
export async function recordUsage(ev: { inTokens: number; outTokens: number; costUsd?: number }, c: UsageCtx): Promise<void> {
  const cost = ev.costUsd ?? costOfCall(c.agent, { in: ev.inTokens, out: ev.outTokens }, undefined);
  c.parent.accrued += cost;
  await c.ledger.record({ runId: c.runId, roleId: c.role.id, agentId: c.agent.id, model: c.agent.model, billing: c.agent.billing ?? "reported", inTokens: ev.inTokens, outTokens: ev.outTokens, costUsd: cost });
  if (c.costCapUsd > 0 && c.parent.accrued > c.costCapUsd) {
    c.parent.costCapped = true;
    c.bus.emit({ kind: "cost.limit_reached", runId: c.runId, roleId: c.role.id, taskId: c.taskId, capUsd: c.costCapUsd, accruedUsd: c.parent.accrued });
    c.parent.controller.abort();
  }
}
