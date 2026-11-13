import type { AgentDef, RoleDef } from "@stewart/config";
import type { Json } from "@stewart/kernel";
import { engineFor as defaultEngineFor, type CompleteResult } from "@stewart/engines";
import { eligibleChain } from "@stewart/roles-skills";
import { recordUsage } from "./usage.js";
import type { ChildDeps } from "./childTypes.js";

const REPLY_CAP = 8000;

type FnResult = Extract<CompleteResult, { ok: true }>;

async function recordReply(d: ChildDeps, ctx: { role: RoleDef; taskId: string; agent: AgentDef }, res: FnResult): Promise<string> {
  if (res.usage) await recordUsage({ inTokens: res.usage.in, outTokens: res.usage.out, costUsd: res.costUsd }, { ...d, ...ctx });
  return JSON.stringify(res.value);
}

/**
 * A delegated `kind: function` task: one schema-constrained request per qualified agent, in chain order,
 * until a reply validates. No tools and no transcript; the reply is the JSON object.
 */
interface FnCtx {
  role: RoleDef;
  taskId: string;
  task: string;
  schema: Json;
  prev?: string;
  error: string;
}

async function attempt(d: ChildDeps, base: { runId: string; taskId: string; roleId: string }, ctx: FnCtx, agent: AgentDef): Promise<string | undefined> {
  if (ctx.prev) d.bus.emit({ kind: "run.escalated", ...base, from: ctx.prev, to: agent.id, reason: ctx.error });
  const channel = d.channelFor(agent.channel);
  const res = await (d.engineFor ?? defaultEngineFor)(channel.cfg.type).complete({ channel, agent, system: ctx.role.prompt ?? "", input: ctx.task, schema: ctx.schema, signal: d.parent.controller.signal });
  if (!res.ok) {
    ctx.error = res.error;
    ctx.prev = agent.id;
    return undefined;
  }
  return await recordReply(d, { role: ctx.role, taskId: ctx.taskId, agent }, res);
}

export async function runFunctionTask(d: ChildDeps, role: RoleDef, task: string, schema: Json): Promise<string> {
  const taskId = d.ids.next("task");
  const base = { runId: d.runId, taskId, roleId: role.id };
  const cfg = d.config();
  const chain = eligibleChain(role, cfg.roles, cfg.agents, cfg.channels);
  d.bus.emit({ kind: "task.created", ...base, title: task.slice(0, 80) });
  d.bus.emit({ kind: "task.started", ...base, agentId: chain[0]?.id ?? (d.agent ? d.agent.id : "") });
  const ctx: FnCtx = { role, taskId, task, schema, error: `no qualified function agent for role ${role.id}: run Qualify in settings` };
  let reply = "";
  for (const agent of chain) {
    reply = (await attempt(d, base, ctx, agent)) ?? "";
    if (reply || d.parent.controller.signal.aborted) break;
  }
  const error = reply ? "" : ctx.error;
  d.bus.emit({ kind: "check.result", ...base, passed: !error, evidence: [error || "schema ok"] });
  if (error) {
    d.bus.emit({ kind: "task.failed", ...base, error });
    return `status: failed\ncheck: ${error}`;
  }
  d.bus.emit({ kind: "task.done", ...base, summary: reply.slice(0, 80) });
  return `status: done\n${reply.slice(0, REPLY_CAP)}`;
}
