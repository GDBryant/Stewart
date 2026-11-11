import { questionPrompt } from "@stewart/interaction";
import type { RoleDef } from "@stewart/config";
import type { EffectiveConfig } from "@stewart/roles-skills";
import type { ManagedChannel } from "@stewart/channels";
import { TaskGraph, type TaskRecord } from "@stewart/scheduling";
import { resolveRole, runRoleTask } from "@stewart/orchestration";
import type { RunRuntime, TaskResult } from "@stewart/run-contract";
import { loadProjectContext } from "@stewart/context";
import { DIRECT_TASK_ID, chatRoleDef, timeCapMessage } from "./consts.js";
import type { ExecCtx, PlanCtx, Refusal, RunOutcome, RunPlan, RunStrategy } from "./strategy.js";
import type { Run, RunHost } from "./types.js";

export interface ResumeRequest {
  config: EffectiveConfig;
  channelFor(channelId: string): ManagedChannel;
  /** When true, interrupted tasks trigger a Resume/Cancel prompt before replay. */
  confirmResume?: boolean;
}

export interface ResumeResult {
  ok: boolean;
  reason?: string;
  run?: Run;
}

type PersistedRun = { id?: string; projectId?: string; text?: string; status?: string; startedAt?: number; costUsd?: number; tasks?: TaskRecord[]; agentId?: string };

type ResumeState = { graph?: TaskGraph; interrupted: TaskRecord[]; text: string };

const REPLAY_UNAVAILABLE = "resume unavailable: task graph replay is not implemented; starting over may repeat writes";

/** Resume strategy: replays a journaled task graph; interrupted tasks re-dispatch under their original ids. */
export function resumeStrategy(runId: string): RunStrategy<ResumeRequest> {
  const state: ResumeState = { interrupted: [], text: "" };
  return {
    plan: (svc, projectId, req, ctx) => planResume({ runId, state, svc, projectId, req, ctx }),
    execute: (c) => executeResume(state, c),
  };
}

/** Shared inputs for the resume load step; one object instead of a long parameter list. */
interface ResumeLoad {
  runId: string;
  state: ResumeState;
  svc: RunHost;
  req: ResumeRequest;
}

/** Plan-step inputs: the load inputs plus the project and plan context. */
interface PlanResumeCtx extends ResumeLoad {
  projectId: string;
  ctx: PlanCtx;
}

/** Replay inputs for one interrupted task; one object instead of a long parameter list. */
interface ReplayCtx {
  svc: RunHost;
  run: Run;
  rt: RunRuntime;
  req: ResumeRequest;
  ctx: PlanCtx;
  graph: TaskGraph;
  text: string;
}

async function loadResumeGraph(
  c: ResumeLoad,
  live: Run | undefined,
  persisted: { tasks?: unknown; text?: string; startedAt?: number; agentId?: string } | undefined,
): Promise<RunPlan | Refusal | null> {
  const taskRecords = live?.tasks ?? persisted?.tasks;
  if (!Array.isArray(taskRecords) || taskRecords.length === 0) {
    return { ok: false, reason: REPLAY_UNAVAILABLE };
  }
  const graph = TaskGraph.fromJSON(taskRecords);
  c.state.graph = graph;
  const interrupted = graph.all().filter((t) => t.status !== "done");
  c.state.interrupted = interrupted;
  markInterrupted(c.svc, c.runId, interrupted);
  if (!(await confirmedToResume(c, interrupted))) {
    return { ok: false, reason: "resume declined by user" };
  }
  c.state.text = live?.messages.find((m) => m.role === "user")?.content ?? persisted?.text ?? "";
  return null;
}

/** True when no confirmation is required, or the user picked Resume. */
async function confirmedToResume(c: ResumeLoad, interrupted: TaskRecord[]): Promise<boolean> {
  if (!c.req.confirmResume || interrupted.length === 0) return true;
  return confirmInterrupted(c.svc, c.runId, interrupted.length);
}

function resumeRunRecord(c: PlanResumeCtx, live: Run | undefined, persisted: { startedAt?: number; agentId?: string } | undefined): Run {
  const { runId, projectId, state, svc, ctx } = c;
  return {
    id: runId,
    projectId,
    status: "running",
    controller: new AbortController(),
    startedAt: live?.startedAt ?? persisted?.startedAt ?? svc.deps.clock.now(),
    messages: [{ role: "user", content: state.text }],
    costUsd: ctx.ledger.cost(runId).costUsd,
    tasks: state.graph!.toJSON(),
    agentId: live?.agentId ?? persisted?.agentId,
  };
}

async function planResume(c: PlanResumeCtx): Promise<RunPlan | Refusal> {
  const { runId, state, svc, req, ctx } = c;
  const live = svc.get(runId);
  if (live && live.status !== "interrupted") return { ok: false, reason: `run is ${live.status}` };
  const loaded = await loadPersistedRun(svc, runId, ctx.stateDir, live);
  if (!loaded.ok) return loaded;
  const { persisted } = loaded;
  const early = await loadResumeGraph(c, live, persisted);
  if (early) return early;
  const run = resumeRunRecord(c, live, persisted);
  return { run, title: state.text, config: req.config, channelFor: req.channelFor };
}

async function executeResume(state: ResumeState, c: ExecCtx<ResumeRequest>): Promise<RunOutcome> {
  const { run, rt } = c;
  const graph = state.graph!;
  const timeCap = rt.timeCap;
  const rc: ReplayCtx = { ...c, graph, text: state.text };
  for (const t of state.interrupted) {
    if (timeCap?.hit) break;
    await replayTask(rc, t);
  }
  run.tasks = graph.toJSON();
  if (timeCap?.hit) {
    return { status: "interrupted", event: "stopped", error: timeCapMessage(timeCap.ms) };
  }
  const anyFailed = graph.all().some((t) => t.status !== "done");
  return anyFailed ? { status: "failed", event: "failed" } : { status: "done", event: "done" };
}

async function loadPersistedRun(
  svc: RunHost,
  runId: string,
  stateDir: string,
  live: Run | undefined,
): Promise<{ ok: true; persisted?: PersistedRun } | Refusal> {
  const jPath = svc.journalPath(runId, stateDir);
  const hasJournal = await svc.deps.host.files.exists(jPath);
  if (!live && !hasJournal) {
    return { ok: false, reason: "run not found" };
  }
  let persisted: PersistedRun | undefined;
  if (hasJournal) {
    try {
      persisted = JSON.parse((await svc.deps.host.files.read(jPath)).content);
    } catch {
      return { ok: false, reason: REPLAY_UNAVAILABLE };
    }
  }
  return { ok: true, persisted };
}

function markInterrupted(svc: RunHost, runId: string, interrupted: TaskRecord[]): void {
  for (const t of interrupted) {
    t.status = "failed";
    t.error = "interrupted";
    svc.deps.bus.emit({ kind: "task.failed", runId, taskId: t.id, roleId: t.roleId, error: "failed: interrupted" });
  }
}

async function confirmInterrupted(svc: RunHost, runId: string, count: number): Promise<boolean> {
  const o = await svc.prompt(runId, new AbortController().signal, "orchestrator")(
    questionPrompt("resume", `Resume ${count} interrupted task(s)?`, ["Resume", "Cancel"]),
  );
  return o.kind === "answered" && o.value.startsWith("Resume");
}

async function replayTask(c: ReplayCtx, t: TaskRecord): Promise<void> {
  const { svc, run, rt, ctx, graph } = c;
  const role = resolveRole(rt, t.roleId) ?? (t.id === DIRECT_TASK_ID ? chatRoleDef() : undefined);
  if (!role) {
    t.status = "failed";
    t.summary = `no enabled role for '${t.roleId}'`;
    return;
  }
  t.status = "running";
  run.tasks = graph.toJSON();
  await svc.journal(run, ctx.stateDir);
  svc.deps.bus.emit({ kind: "task.started", runId: run.id, taskId: t.id, roleId: role.id });
  const res = t.id === DIRECT_TASK_ID
    ? await replayDirect(c, t, role)
    : await rt.recoveryService.runTask(rt, t, { role }, { depth: 0, brain: rt.recoveryService.brain(rt) });
  rt.leases.release(t.id);
  t.filesTouched = res.filesTouched;
  t.status = res.status === "done" ? "done" : "failed";
  t.summary = res.summary;
  run.tasks = graph.toJSON();
  await svc.journal(run, ctx.stateDir);
  emitReplayResult(c, t, role.id, res);
}

/** Direct run: lean replay (original request only; executed tool calls are skipped via the idempotency log). */
async function replayDirect(c: ReplayCtx, t: TaskRecord, role: RoleDef): Promise<TaskResult> {
  const { svc, run, rt, req, text } = c;
  return runRoleTask(
    rt,
    { ...t, task: `${text}\n\n(Resumed after interruption: continue; already-executed tool calls are skipped.)` },
    {
      role,
      agent: run.agentId ? req.config.agents.find((a) => a.id === run.agentId) : undefined,
      prompt: [await loadProjectContext(svc.deps.host)].filter(Boolean).join("") || undefined,
    },
  );
}

function emitReplayResult(c: ReplayCtx, t: TaskRecord, roleId: string, res: TaskResult): void {
  const runId = c.run.id;
  c.svc.deps.bus.emit(
    res.status === "done"
      ? { kind: "task.done", runId, taskId: t.id, roleId, summary: res.summary.slice(0, 400) }
      : { kind: "task.failed", runId, taskId: t.id, roleId, error: res.summary.slice(0, 400) },
  );
}
