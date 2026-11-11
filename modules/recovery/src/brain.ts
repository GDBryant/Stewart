import { RunCancelledError, createAgentSession } from "@stewart/agent-loop";
import { type RunRuntime, type RecoveryState, type RecoveryBrain } from "@stewart/run-contract";
import { ToolRegistry } from "@stewart/tools";
import { logRecovery } from "./consts.js";
import { parseRecoveryArgs, submitRecoveryTool, type RecoveryPlan } from "./plan.js";

export function recoveryBrain(rt: RunRuntime): RecoveryBrain | undefined {
  const orch = rt.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  const agent = rt.config.agents.find((a) => a.id === orch?.agent);
  if (!agent) return undefined;
  const channel = rt.channelFor(agent.channel);
  return channel.unhealthy ? undefined : { channel, agent };
}

/** Planner-route call with only `submit_recovery`; returns the validated plan or undefined. */
export async function recoveryCall(rt: RunRuntime, brain: RecoveryBrain, brief: string, R: RecoveryState): Promise<RecoveryPlan | undefined> {
  let plan: RecoveryPlan | undefined;
  const ceiling = rt.maxWorkerTurnsCeiling ?? 60;
  const tool = submitRecoveryTool((args) => {
    plan = parseRecoveryArgs(args, { maxSubTasks: R.maxSubTasks, ceiling });
    return `Recovery plan recorded with ${plan.subtasks.length} sub-task(s).`;
  });
  const session = createAgentSession(
    {
      agent: brain.agent,
      channel: brain.channel,
      registry: new ToolRegistry([tool]),
      approve: async () => ({ kind: "approved" }),
      prompt: "You split an oversized or stuck task into smaller sub-tasks. Reply only with submit_recovery.",
      terminal: new Set(["submit_recovery"]),
      limitsOverride: { maxModelTurns: 4 },
      meter: { ledger: rt.ledger, cost: rt.cost, runId: rt.runId, roleId: "recovery" },
    },
    rt.clock,
  );
  try {
    const result = await session.loop.run(brain.agent.model, [{ role: "user", content: brief }], session.listener, rt.signal);
    if (result.kind !== "completed") {
      logRecovery(rt, `layer 1: recovery call failed (${result.kind === "failed" ? result.message : result.kind})`);
      return undefined;
    }
  } catch (e) {
    return recoveryCallError(e, rt);
  }
  return plan;
}

function recoveryCallError(e: unknown, rt: RunRuntime): undefined {
  if (e instanceof RunCancelledError || rt.signal.aborted) throw e instanceof Error ? e : new Error("cancelled");
  logRecovery(rt, `layer 1: recovery call failed (${e instanceof Error ? e.message : e})`);
  return undefined;
}

/** Read the sub-task outputs in order and write them to `final_file` through the normal edit path. */
