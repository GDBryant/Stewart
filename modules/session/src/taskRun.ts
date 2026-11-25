import type { AgentDef, Effort, RoleDef } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import type { ChatMessage, HostPort } from "@stewart/kernel";
import type { ApproveFn, Permissions } from "@stewart/permissions";
import type { Interaction } from "@stewart/interaction";
import { questionPrompt } from "@stewart/interaction";
import type { RunLedger } from "@stewart/ledger";
import type { RunEvent } from "@stewart/protocol";
import { eligibleChain, effectiveEffort, type EffectiveConfig } from "@stewart/roles-skills";
import { maybeDivert } from "./divert.js";
import { engineFor as defaultEngineFor, type Engine, type WriteRecord } from "@stewart/engines";
import { evidenceText, failureText, healthRepairInstruction, runCheck, type Baseline, type ChangeTracker, type Check, type CheckInput, type CheckResult, type Evidence } from "@stewart/tasks";
import { ToolRegistry, decide, roleIsReadOnly, type ProjectPaths } from "@stewart/tools";
import { abortRace, AbortedRun, err, lastReply, newTaskState, type Contract, type ContractCommand, type FinishReason, type RunState, type TaskState } from "./turnState.js";
import { evBase, onEvent } from "./taskEvents.js";
import { handoverText } from "./handover.js";
import { cliPolicyGate, policyFailed } from "./policyGate.js";
import { mergeWrites } from "./changedMerge.js";

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
  /** Turn budget overriding `role.turnBudget` (lead: settings.runTurnLimit). */
  maxTurns?: number;
  /** Shared per-run state: controller/signal, event seq, accrued cost, costCapped. */
  run: RunState;
  beforeModelTurn?: (agent: AgentDef, ctx?: { measured?: { tokens: number; len: number } }) => Promise<boolean | void>;
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
  /** Agent ids already attempted in this chain; feeds the loop-guard divert's `tried` exclusion. */
  tried: Set<string>;
}

interface Ctx {
  spec: TaskSpec;
  deps: TaskDeps;
  ts: TaskState;
  st: Loop;
}

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
  if (spec.run.controller.signal.aborted) throw new AbortedRun();
  const contract = spec.contract();
  const changed = mergeWrites(await abortRace(deps.tracker.diff(baseline), spec.run), ts.writes, deps.paths);
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
  const ran = await abortRace(runCheck({ check, input, host: deps.host, cwd: deps.paths.base, signal: spec.run.controller.signal }), spec.run);
  const res = { passed: ran.passed && !denied.length, evidence: [...denied, ...ran.evidence] };
  deps.bus.emit({ kind: "check.result", ...evBase(spec), passed: res.passed, evidence: evidenceText(res.evidence) });
  return { res, input, contract };
}

/** Turn budgets at or above this run until the model finishes (no cap, no budget notes). */
export const UNBOUNDED_TURNS = 1000;

/** Model-turn budget for one attempt: 1 for a repair, else spec/role budget ("unlimited" = 200). */
export function turnsFor(spec: Pick<TaskSpec, "maxTurns" | "role">, repair: boolean): number {
  if (repair) return 1;
  const budget = spec.maxTurns ?? (spec.role.turnBudget === "unlimited" ? 200 : spec.role.turnBudget);
  return budget >= UNBOUNDED_TURNS ? Number.POSITIVE_INFINITY : budget;
}

async function attempt(c: Ctx, agent: AgentDef, repair = false, effort?: Effort): Promise<void> {
  const { spec, deps, ts } = c;
  const channel = deps.channelFor(agent.channel);
  const engine = (deps.engineFor ?? defaultEngineFor)(channel.cfg.type);
  ts.maxTurns = turnsFor(spec, repair);
  const turn = {
    sessionId: spec.sessionId,
    transcript: spec.transcript,
    system: await spec.system(),
    agent,
    channel,
    roleId: spec.role.id,
    tools: repair ? new ToolRegistry([]) : spec.tools,
    hostTools: repair ? undefined : spec.hostTools,
    approve: spec.approve,
    state: spec.engineState,
    cwd: deps.paths.base,
    signal: spec.run.controller.signal,
    maxTurns: ts.maxTurns,
    ...(spec.role.think !== undefined ? { think: spec.role.think } : {}),
    effort: effort ?? effectiveEffort(spec.role, agent),
    ...(spec.beforeModelTurn ? { beforeModelTurn: (ctx?: { measured?: { tokens: number; len: number } }) => spec.beforeModelTurn!(agent, ctx) } : {}),
  };
  const refused = await cliPolicyGate(c, channel);
  if (refused) {
    ts.reason = "error";
    ts.error = refused;
    return;
  }
  try {
    for await (const ev of engine.run(turn)) await onEvent(ev, c, agent);
  } catch (e) {
    ts.reason = "error";
    ts.error = err(e);
  }
}

function escalate(c: Ctx, next: AgentDef, divert = false): void {
  const { spec, deps, ts } = c;
  spec.transcript.push({ role: "user", content: handoverText(c.st.prev!.id, spec.goal, ts.tried, ts.error ?? "unknown") });
  const reason = divert ? "loop_guard_divert" : ts.reason === "stop" || !ts.reason ? "check_failed" : ts.reason;
  deps.bus.emit({ kind: "run.escalated", runId: spec.runId, ...(spec.taskId ? { taskId: spec.taskId } : {}), roleId: spec.role.id, from: c.st.prev!.id, to: next.id, reason });
}

function formatRepairable(res: CheckResult): boolean {
  const failed = res.evidence.filter((e) => !e.ok);
  return failed.length > 0 && failed.every((e) => e.code === "health_invalid" && !e.detail.includes("missing file") && !e.detail.includes("scope not covered"));
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

function canRepair(spec: TaskSpec, ts: TaskState, last: Verify | undefined): boolean {
  return !ts.repairAttempted && spec.needs?.schema === "health" && last !== undefined && formatRepairable(last.res);
}

async function repairResult(c: Ctx, baseline: Baseline): Promise<"done" | "cancelled" | false> {
  const { spec, ts } = c;
  if (ts.reason === "cancelled" || spec.run.costCapped) return "cancelled";
  if (ts.reason !== "stop") {
    if (!ts.error) ts.error = ts.reason;
    return false;
  }
  c.st.last = await verify(c, baseline);
  if (c.st.last.res.passed) return "done";
  ts.error = failureText(c.st.last.res);
  return false;
}

async function repairHealth(c: Ctx, baseline: Baseline, agent: AgentDef): Promise<"done" | "cancelled" | false> {
  const { spec, deps, ts } = c;
  if (!canRepair(spec, ts, c.st.last)) return false;
  ts.repairAttempted = true;
  deps.bus.emit({ kind: "task.repair", ...evBase(spec), reason: "health report format" });
  spec.transcript.push({ role: "user", content: healthRepairInstruction(ts.error ?? "invalid report") });
  ts.reason = "" as FinishReason;
  ts.error = undefined;
  await attempt(c, agent, true);
  return await repairResult(c, baseline);
}

/** The fallback question: a turn-limit stop offers Continue; other failures only guidance or Stop. */
function retryPrompt(c: Ctx): { question: string; options: string[] } {
  const { ts } = c;
  const agent = c.st.agent!;
  if (ts.reason === "turn_limit") {
    return { question: `Ran out of turns (${ts.maxTurns}) on ${agent.id}. Continue with a fresh budget, reply with guidance, or stop.`, options: ["Continue", "Stop"] };
  }
  return { question: `All agents for this task failed. ${ts.error ?? "failed"}\nReply with guidance to retry once more on ${agent.id}, or stop.`, options: ["Stop"] };
}

const CONTINUE_TEXT = "Continue the task from where you stopped. If you identified the change, apply it and verify it; otherwise finish the investigation first.";

async function askAndRetry(c: Ctx, baseline: Baseline): Promise<boolean> {
  const { spec, deps, ts } = c;
  const agent = c.st.agent!;
  const p = retryPrompt(c);
  const o = await deps.interaction!.ask(questionPrompt("fallback", p.question, p.options), { runId: spec.runId, roleId: spec.role.id }, spec.run.controller.signal);
  if (o.kind !== "answered" || o.value === "Stop") return false;
  spec.transcript.push({ role: "user", content: o.value === "Continue" ? CONTINUE_TEXT : o.value });
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

/** One pending chain entry: the agent to attempt, the effort its attempt uses (the divert override, when it applies),
 * and whether this is the loop-guard divert (its handover is labeled `loop_guard_divert`). */
interface Pending {
  agent: AgentDef;
  effort?: Effort;
  divert?: boolean;
}

/** One chain attempt; returns a terminal TaskResult or undefined to continue the chain (with the loop-guard flag, if that tripped). */
async function tryAgent(c: Ctx, baseline: Baseline, p: Pending): Promise<{ r?: TaskResult; loop?: boolean }> {
  const { spec, ts } = c;
  if (c.st.prev) escalate(c, p.agent, p.divert);
  ts.reason = "" as FinishReason;
  ts.error = undefined;
  await attempt(c, p.agent, false, p.effort);
  c.st.agent = p.agent;
  if (ts.reason === "cancelled" || spec.run.costCapped) return { r: result(c, baseline, "cancelled") };
  if (ts.reason !== "stop") {
    if (!ts.error) ts.error = ts.reason;
    return ts.reason === "loop_guard" ? { loop: true } : {};
  }
  c.st.last = await verify(c, baseline);
  if (c.st.last.res.passed) return { r: result(c, baseline, "done") };
  ts.error = failureText(c.st.last.res);
  const repaired = await repairHealth(c, baseline, p.agent);
  if (repaired === "done" || repaired === "cancelled") return { r: result(c, baseline, repaired) };
  return {};
}

/** Try each agent in turn; a business-policy failure skips the rest of the same channel (it would block the same content).
 * On a loop-guard trip the run diverts once to the strongest reasoning-capable eligible agent (see divert.ts); the
 * diverted attempt alone uses the divert's effort override, the rest of the chain keeps its effective effort. When the
 * divert target is already in the remaining chain it is pulled to the front (tried now, once) with the override. */
async function runChain(c: Ctx, baseline: Baseline, chain: AgentDef[]): Promise<TaskResult | undefined> {
  const rest: Pending[] = chain.map((agent) => ({ agent }));
  while (rest.length) {
    const p = rest.shift()!;
    if (policyFailed(c.ts.error) && c.st.prev?.channel === p.agent.channel) continue;
    c.st.tried.add(p.agent.id);
    const { r, loop } = await tryAgent(c, baseline, p);
    c.st.prev = p.agent;
    if (r) return r;
    if (loop) divertPending(c, rest, p);
  }
  return undefined;
}

/** The loop-guard divert: pull the strongest eligible agent to the front of the pending chain (at most once per run). */
function divertPending(c: Ctx, rest: Pending[], p: Pending): void {
  const d = maybeDivert({ cfg: c.deps.config(), role: c.spec.role, current: p.agent, triedIds: [...c.st.tried], reason: c.ts.reason, run: c.spec.run });
  if (!d) return;
  const i = rest.findIndex((x) => x.agent.id === d.next.id);
  if (i >= 0) rest.splice(i, 1); // the target is already pending; try it now, once
  rest.unshift({ agent: d.next, effort: d.effort, divert: true });
}

/**
 * The one task runner: eligible chain → engine attempt → verify → escalate (handover) → optional
 * interactive retry — shared by the lead turn (taskId undefined) and delegated children.
 */
export async function runTask(spec: TaskSpec, deps: TaskDeps): Promise<TaskResult> {
  const cfg = deps.config();
  const chain = eligibleChain(spec.role, cfg.roles, cfg.agents, cfg.channels);
  const c: Ctx = { spec, deps, ts: newTaskState(), st: { last: undefined, prev: undefined, agent: undefined, tried: new Set() } };
  let baseline: Baseline;
  try {
    baseline = spec.baseline ?? (await abortRace(deps.tracker.begin(spec.taskId ? `task-${spec.taskId}` : `turn-${spec.runId}`), spec.run));
  } catch (e) {
    if (!(e instanceof AbortedRun)) throw e;
    c.ts.reason = "cancelled";
    return result(c, { id: "", kind: "unavailable", reason: "cancelled" }, "cancelled");
  }
  if (!chain.length) {
    c.ts.reason = "error";
    c.ts.error = `no qualified agent for role ${spec.role.id}: run Qualify in settings`;
    return result(c, baseline, "failed");
  }
  try {
    return (await runChain(c, baseline, chain)) ?? (await finish(c, baseline));
  } catch (e) {
    if (!(e instanceof AbortedRun)) throw e;
    c.ts.reason = "cancelled";
    return result(c, baseline, "cancelled");
  }
}

/** Interactive retry (lead only) then the terminal status. */
async function finish(c: Ctx, baseline: Baseline): Promise<TaskResult> {
  const retried = c.spec.interactive && c.st.agent ? await askAndRetry(c, baseline) : false;
  if (retried && (c.ts.reason === "cancelled" || c.spec.run.costCapped)) return result(c, baseline, "cancelled");
  if (retried && c.ts.reason === "stop" && c.st.last?.res.passed) return result(c, baseline, "done");
  return result(c, baseline, "failed");
}
