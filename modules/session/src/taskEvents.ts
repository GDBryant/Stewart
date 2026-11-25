import type { AgentDef, RoleDef } from "@stewart/config";
import type { RunLedger } from "@stewart/ledger";
import { costOfCall } from "@stewart/ledger";
import type { RunEvent } from "@stewart/protocol";
import { agentContext, type EffectiveConfig } from "@stewart/roles-skills";
import type { EngineEvent, WriteRecord } from "@stewart/engines";
import { isReadTool, type RunState, type TaskState } from "./turnState.js";

/** The slice of a running task the engine-event handlers touch. */
export interface EventCtx {
  spec: {
    runId: string;
    role: RoleDef;
    taskId?: string;
    run: RunState;
    onWrite?: (w: WriteRecord) => void;
    onStep?: () => void | Promise<void>;
  };
  deps: {
    bus: { emit(ev: RunEvent): void };
    ledger: RunLedger;
    config: () => EffectiveConfig;
    costCapUsd: number;
    host: { log(msg: string): void };
  };
  ts: TaskState;
}

export const evBase = (spec: EventCtx["spec"]) => ({ runId: spec.runId, roleId: spec.role.id, ...(spec.taskId ? { taskId: spec.taskId } : {}) });

async function onUsage(ev: Extract<EngineEvent, { kind: "usage" }>, c: EventCtx, agent: AgentDef): Promise<void> {
  const { spec, deps } = c;
  const cost = ev.costUsd ?? costOfCall(agent, { in: ev.inTokens, out: ev.outTokens }, undefined);
  spec.run.accrued += cost;
  await deps.ledger.record({ runId: spec.runId, roleId: spec.role.id, agentId: agent.id, model: agent.model, billing: agent.billing ?? "reported", inTokens: ev.inTokens, outTokens: ev.outTokens, costUsd: cost });
  if (deps.costCapUsd > 0 && spec.run.accrued > deps.costCapUsd) {
    spec.run.costCapped = true;
    deps.bus.emit({ kind: "cost.limit_reached", ...evBase(spec), capUsd: deps.costCapUsd, accruedUsd: spec.run.accrued });
    spec.run.controller.abort();
  }
}

function onEngineContext(ev: Extract<EngineEvent, { kind: "engine.context" }>, c: EventCtx, agent: AgentDef): void {
  const { spec, deps } = c;
  const windowTokens = ev.windowTokens ?? agentContext(agent, deps.config().channels);
  spec.run.engineContext = { inputTokens: ev.inputTokens, windowTokens };
  deps.bus.emit({
    kind: "engine.context",
    ...evBase(spec),
    engineSessionId: ev.engineSessionId,
    inputTokens: ev.inputTokens,
    windowTokens,
    compacted: ev.compacted,
    turnCount: ev.turnCount,
  });
  void spec.onStep?.();
}

function onTool(ev: Extract<EngineEvent, { kind: "tool.request" | "tool.outcome" }>, c: EventCtx): void {
  const { spec, deps, ts } = c;
  if (ev.kind === "tool.request") {
    ts.tried.push({ callId: ev.callId, name: ev.tool, args: JSON.stringify(ev.args ?? {}) });
    deps.bus.emit({ kind: "tool.request", ...evBase(spec), callId: ev.callId, tool: ev.tool, args: ev.args, category: ev.category });
    return;
  }
  const t = ts.tried.find((x) => x.callId === ev.callId);
  if (t) t.ok = ev.ok;
  if (t?.ok && isReadTool(t.name)) ts.reads++;
  deps.bus.emit({ kind: "tool.outcome", ...evBase(spec), callId: ev.callId, ok: ev.ok, summary: ev.summary });
  void spec.onStep?.();
}

function onText(ev: Extract<EngineEvent, { kind: "text" | "reasoning" }>, c: EventCtx): void {
  c.deps.bus.emit({ kind: ev.kind === "text" ? "text_delta" : "reasoning_delta", ...evBase(c.spec), seq: c.spec.run.seq++, text: ev.text });
}

function onNotice(ev: Extract<EngineEvent, { kind: "diag" | "policy.notice" }>, c: EventCtx): void {
  if (ev.kind === "diag") c.deps.host.log(`${ev.tag}: ${ev.detail}`);
  else c.deps.bus.emit({ ...ev, ...evBase(c.spec) });
}

export async function onEvent(ev: EngineEvent, c: EventCtx, agent: AgentDef): Promise<void> {
  const { spec, deps, ts } = c;
  if (ev.kind === "text" || ev.kind === "reasoning") return onText(ev, c);
  if (ev.kind === "tool.request" || ev.kind === "tool.outcome") return onTool(ev, c);
  if (ev.kind === "write") {
    ts.writes.push(ev.record);
    return void spec.onWrite?.(ev.record);
  }
  if (ev.kind === "diag" || ev.kind === "policy.notice") return onNotice(ev, c);
  if (ev.kind === "usage") return await onUsage(ev, c, agent);
  if (ev.kind === "engine.context") return onEngineContext(ev, c, agent);
  ts.reason = ev.reason;
  ts.error = ev.error;
  return void spec.onStep?.();
}
