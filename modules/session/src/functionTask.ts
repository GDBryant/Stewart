import type { RoleDef } from "@stewart/config";
import type { Json } from "@stewart/kernel";
import { runFunction } from "@stewart/engines";
import { eligibleChain } from "@stewart/roles-skills";
import { recordUsage } from "./usage.js";
import type { ChildDeps } from "./childTypes.js";

const REPLY_CAP = 8000;

/**
 * A delegated `kind: function` task: one schema-constrained request per qualified agent, in chain order,
 * until a reply validates. No tools and no transcript; the reply is the JSON object.
 */
export async function runFunctionTask(d: ChildDeps, role: RoleDef, task: string, schema: Json): Promise<string> {
  const taskId = d.ids.next("task");
  const base = { runId: d.runId, taskId, roleId: role.id };
  const cfg = d.config();
  const chain = eligibleChain(role, cfg.roles, cfg.agents, cfg.channels);
  d.bus.emit({ kind: "task.created", ...base, title: task.slice(0, 80), dependsOn: [] });
  d.bus.emit({ kind: "task.started", ...base, agentId: chain[0]?.id ?? d.agent.id });
  const system = role.prompt ?? "";
  let error = `no qualified function agent for role ${role.id}: run Qualify in settings`;
  let reply = "";
  let prev: string | undefined;
  for (const agent of chain) {
    if (prev) d.bus.emit({ kind: "run.escalated", ...base, from: prev, to: agent.id, reason: error });
    const res = await runFunction({ channel: d.channelFor(agent.channel), agent, system, input: task, schema, signal: d.parent.controller.signal });
    if (res.ok) {
      const ctx = { ...d, role, taskId, agent };
      if (res.usage) await recordUsage({ inTokens: res.usage.in, outTokens: res.usage.out, costUsd: res.costUsd }, ctx);
      reply = JSON.stringify(res.value);
      error = "";
      break;
    }
    error = res.error;
    prev = agent.id;
    if (d.parent.controller.signal.aborted) break;
  }
  d.bus.emit({ kind: "check.result", ...base, passed: !error, evidence: [error || "schema ok"] });
  if (error) {
    d.bus.emit({ kind: "task.failed", ...base, error });
    return `status: failed\ncheck: ${error}`;
  }
  d.bus.emit({ kind: "task.done", ...base, summary: reply.slice(0, 80) });
  return `status: done\n${reply.slice(0, REPLY_CAP)}`;
}
