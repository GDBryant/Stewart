import type { AgentDef, RoleDef } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ApproveFn, Permissions } from "@stewart/permissions";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { RunLedger } from "@stewart/ledger";
import { costOfCall } from "@stewart/ledger";
import type { RunEvent } from "@stewart/protocol";
import { eligibleChain, type EffectiveConfig } from "@stewart/roles-skills";
import { engineFor as defaultEngineFor, type Engine, type EngineEvent, type WriteRecord } from "@stewart/engines";
import { evidenceText, failureText, runCheck, type Baseline, type ChangeTracker, type Check, type CheckInput, type CheckResult, type Evidence } from "@stewart/tasks";
import { ToolRegistry, decide, roleIsReadOnly, type ProjectPaths } from "@stewart/tools";
import { err, isReadTool, lastReply, newTaskState, type Contract, type ContractCommand, type FinishReason, type RunState, type TaskState } from "./turnState.js";
import { handoverText } from "./handover.js";

export type { Contract, ContractCommand } from "./turnState.js";

export interface TaskSpec {
  runId: string;
  /** Child task id; undefined = the lead turn. */
  taskId?: string;
  /** Engine session id (child: `${sessionId}/${taskId}`). */
  sessionId: string;
  role: RoleDef;
  /** Handover "Goal:" text. */
  goal: string;
  /** Transcript ending with the user message; mutated in place across attempts. */
  transcript: ChatMessage[];
  /** Re-evaluated per attempt (plan notes can appear mid-run). */
  system: () => Promise<string>;
  tools: ToolRegistry;
  hostTools?: ToolRegistry;
  approve: ApproveFn;
  engineState: Record<string, unknown>;
  /** Read at verify time (set_check may have added to it). */
  contract: () => Contract;
  needs?: { cites?: boolean; needsRead?: boolean; schema?: "health"; mustChange?: boolean };
  /** Reuse an existing baseline instead of calling tracker.begin (plan milestone tasks). */
  baseline?: Baseline;
  /** After the whole chain failed: ask the user once (lead only). */
  interactive: boolean;
  /** Shared per-run state: controller/signal, event seq, accrued cost, costCapped. */
  run: RunState;
  beforeModelTurn?: (agent: AgentDef) => Promise<void>;
  onWrite?: (w: WriteRecord) => void;
  onStep?: () => void | Promise<void>;
}


export interface TaskDeps {
  host: HostPort;
  bus: { emit(ev: RunEvent): void };
  permissions: Permissions;
  /** Required only for `interactive` tasks (the lead). */
  interaction?: Interaction;
  channelFor: (id: string) => ManagedChannel;
  config: () => EffectiveConfig;
  engineFor?: (channelType: string) => Engine;
  ledger: RunLedger;
  tracker: ChangeTracker;
  paths: ProjectPaths;
  costCapUsd: number;
}

export interface TaskResult {
  status: "done" | "failed" | "cancelled";
  reason: FinishReason;
  error?: string;
  /** Last verify result (absent when no attempt reached verify). */
  check?: CheckResult;
  /** tracker.diff(baseline) at the end; undefined when tracking is unavailable. */
  changed: string[] | undefined;
  baseline: Baseline;
  reply: string;
  agentId?: string;
  /** The contract used at the last verify (or current one if no verify ran). */
  contract: Contract;
}

interface Verify {
  res: CheckResult;
  input: CheckInput;
  contract: Contract;
}

interface Loop {
  last: Verify | undefined;
  prev: AgentDef | undefined;
  agent: AgentDef | undefined;
}

interface Ctx {
  spec: TaskSpec;
  deps: TaskDeps;
  ts: TaskState;
  st: Loop;
}

const evBase = (spec: TaskSpec) => ({ runId: spec.runId, roleId: spec.role.id, ...(spec.taskId ? { taskId: spec.taskId } : {}) });

function inputFor(spec: TaskSpec, ts: TaskState, changed: string[] | undefined): CheckInput {
  return { reply: lastReply(spec.transcript), writes: ts.writes, changed, reads: ts.reads };
}

async function gateCommand(c: Ctx, cmd: ContractCommand, n: number): Promise<Evidence | undefined> {
  const { spec, deps } = c;
  if (cmd.approved) return undefined;
  const gate = deps.permissions.gate(spec.runId, spec.run.controller.signal);
  const call = { id: `check-${spec.taskId ?? "lead"}-${n}`, name: "verify_command", arguments: { command: cmd.argv } };
  const d = await gate(call, { kind: "command", command: cmd.argv.join(" "), cwd: "." }, { roleId: spec.role.id, ...(spec.taskId ? { taskId: spec.taskId } : {}) });
  return d.kind === "approved" ? undefined : { code: "command_denied", ok: false, detail: `check command not approved: ${cmd.argv.join(" ")}` };
}

function pathRuleFor(role: RoleDef): ((p: string) => string | null) | undefined {
  const deny = (p: string) => {
    const d = decide(role, { kind: "write", path: p });
    return d.allow ? null : d.reason;
  };
  return roleIsReadOnly(role) || role.writePaths.length ? deny : undefined;
}

async function verify(c: Ctx, baseline: Baseline): Promise<Verify> {
  const { spec, deps, ts } = c;
  const contract = spec.contract();
  const changed = await deps.tracker.diff(baseline);
  const input = inputFor(spec, ts, changed);
  const cmds = contract.commands.filter((x) => !x.whenChanged || changed === undefined || changed.length > 0);
  const denied: Evidence[] = [];
  const approved: string[][] = [];
  for (const [i, x] of cmds.entries()) {
    const d = await gateCommand(c, x, i);
    if (d) denied.push(d);
    else approved.push(x.argv);
  }
  const check: Check = { files: contract.files, commands: approved.length ? approved : undefined, pathRule: pathRuleFor(spec.role), ...spec.needs };
  const ran = await runCheck({ check, input, host: deps.host, cwd: deps.paths.base });
  const res = { passed: ran.passed && !denied.length, evidence: [...denied, ...ran.evidence] };
  deps.bus.emit({ kind: "check.result", ...evBase(spec), passed: res.passed, evidence: evidenceText(res.evidence) });
  return { res, input, contract };
}

async function onUsage(ev: Extract<EngineEvent, { kind: "usage" }>, c: Ctx, agent: AgentDef): Promise<void> {
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

function onTool(ev: Extract<EngineEvent, { kind: "tool.request" | "tool.outcome" }>, c: Ctx): void {
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

async function onEvent(ev: EngineEvent, c: Ctx, agent: AgentDef): Promise<void> {
  const { spec, deps, ts } = c;
  if (ev.kind === "text" || ev.kind === "reasoning")
    return deps.bus.emit({ kind: ev.kind === "text" ? "text_delta" : "reasoning_delta", ...evBase(spec), seq: spec.run.seq++, text: ev.text });
  if (ev.kind === "tool.request" || ev.kind === "tool.outcome") return onTool(ev, c);
  if (ev.kind === "write") {
    ts.writes.push(ev.record);
    return void spec.onWrite?.(ev.record);
  }
  if (ev.kind === "usage") return await onUsage(ev, c, agent);
  ts.reason = ev.reason;
  ts.error = ev.error;
  return void spec.onStep?.();
}

async function attempt(c: Ctx, agent: AgentDef): Promise<void> {
  const { spec, deps, ts } = c;
  const channel = deps.channelFor(agent.channel);
  const engine = (deps.engineFor ?? defaultEngineFor)(channel.cfg.type);
  const turn = {
    sessionId: spec.sessionId,
    transcript: spec.transcript,
    system: await spec.system(),
    agent,
    channel,
    roleId: spec.role.id,
    tools: spec.tools,
    hostTools: spec.hostTools,
    approve: spec.approve,
    state: spec.engineState,
    cwd: deps.paths.base,
    signal: spec.run.controller.signal,
    maxTurns: spec.role.turnBudget === "unlimited" ? 200 : spec.role.turnBudget,
    ...(spec.beforeModelTurn ? { beforeModelTurn: () => spec.beforeModelTurn!(agent) } : {}),
  };
  try {
    for await (const ev of engine.run(turn)) await onEvent(ev, c, agent);
  } catch (e) {
    ts.reason = "error";
    ts.error = err(e);
  }
}

function escalate(c: Ctx, next: AgentDef): void {
  const { spec, deps, ts } = c;
  spec.transcript.push({ role: "user", content: handoverText(c.st.prev!.id, spec.goal, ts.tried, ts.error ?? "unknown") });
  const reason = ts.reason === "stop" || !ts.reason ? "check_failed" : ts.reason;
  deps.bus.emit({ kind: "run.escalated", runId: spec.runId, ...(spec.taskId ? { taskId: spec.taskId } : {}), roleId: spec.role.id, from: c.st.prev!.id, to: next.id, reason });
}

function result(c: Ctx, baseline: Baseline, status: TaskResult["status"]): TaskResult {
  const { spec, ts } = c;
  return {
    status,
    reason: ts.reason,
    error: ts.error,
    check: c.st.last?.res,
    changed: c.st.last?.input.changed,
    baseline,
    reply: lastReply(spec.transcript),
    agentId: c.st.agent?.id,
    contract: c.st.last?.contract ?? spec.contract(),
  };
}

async function askAndRetry(c: Ctx, baseline: Baseline): Promise<boolean> {
  const { spec, deps, ts } = c;
  const agent = c.st.agent!;
  const evidence = ts.error ?? "failed";
  const question = `All agents for this task failed. ${evidence}\nReply with guidance to retry once more on ${agent.id}, or stop.`;
  const o = await deps.interaction!.ask(questionPrompt("fallback", question, ["Stop"]), { runId: spec.runId, roleId: spec.role.id }, spec.run.controller.signal);
  if (o.kind !== "answered" || o.value === "Stop") return false;
  spec.transcript.push({ role: "user", content: o.value });
  ts.reason = "" as FinishReason;
  ts.error = undefined;
  await attempt(c, agent);
  if (ts.reason !== "stop") return true;
  c.st.last = await verify(c, baseline);
  if (!c.st.last.res.passed) {
    ts.reason = "error";
    ts.error = failureText(c.st.last.res);
  }
  return true;
}

/** One chain attempt; returns a terminal TaskResult or undefined to continue the chain. */
async function tryAgent(c: Ctx, baseline: Baseline, agent: AgentDef): Promise<TaskResult | undefined> {
  const { spec, ts } = c;
  if (c.st.prev) escalate(c, agent);
  ts.reason = "" as FinishReason;
  ts.error = undefined;
  await attempt(c, agent);
  c.st.agent = agent;
  if (ts.reason === "cancelled" || spec.run.costCapped) return result(c, baseline, "cancelled");
  if (ts.reason !== "stop") {
    if (!ts.error) ts.error = ts.reason;
    return undefined;
  }
  c.st.last = await verify(c, baseline);
  if (c.st.last.res.passed) return result(c, baseline, "done");
  ts.error = failureText(c.st.last.res);
  return undefined;
}

/**
 * The one task runner: eligible chain → engine attempt → verify → escalate (handover) → optional
 * interactive retry — shared by the lead turn (taskId undefined) and delegated children.
 */
export async function runTask(spec: TaskSpec, deps: TaskDeps): Promise<TaskResult> {
  const cfg = deps.config();
  const chain = eligibleChain(spec.role, cfg.roles, cfg.agents, cfg.channels);
  const baseline = spec.baseline ?? (await deps.tracker.begin(spec.taskId ? `task-${spec.taskId}` : `turn-${spec.runId}`));
  const c: Ctx = { spec, deps, ts: newTaskState(), st: { last: undefined, prev: undefined, agent: undefined } };
  if (!chain.length) {
    c.ts.reason = "error";
    c.ts.error = `no qualified agent for role ${spec.role.id}: run Qualify in settings`;
    return result(c, baseline, "failed");
  }
  for (const agent of chain) {
    const r = await tryAgent(c, baseline, agent);
    if (r) return r;
    c.st.prev = agent;
  }
  return finish(c, baseline);
}

/** Interactive retry (lead only) then the terminal status. */
async function finish(c: Ctx, baseline: Baseline): Promise<TaskResult> {
  const retried = c.spec.interactive && c.st.agent ? await askAndRetry(c, baseline) : false;
  if (retried && (c.ts.reason === "cancelled" || c.spec.run.costCapped)) return result(c, baseline, "cancelled");
  if (retried && c.ts.reason === "stop" && c.st.last?.res.passed) return result(c, baseline, "done");
  return result(c, baseline, "failed");
}
