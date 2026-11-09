import { questionPrompt } from "@stewart/interaction";
import type { Config } from "@stewart/roles-skills";
import type { ManagedChannel } from "@stewart/channels";
import { TaskGraph, type TaskRecord } from "@stewart/scheduling";
import { resolveRole, runRoleTask } from "@stewart/orchestration";
import type { RunRuntime } from "@stewart/agent-loop";
import { loadProjectContext } from "@stewart/context";
import { DIRECT_TASK_ID, chatRoleDef, timeCapMessage } from "./consts.js";
import type { PlanCtx, Refusal, RunOutcome, RunPlan, RunStrategy } from "./strategy.js";
import type { Run, RunHost } from "./types.js";

export interface ResumeRequest {
  config: Config;
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

/** Resume strategy: replays a journaled task graph; interrupted tasks re-dispatch under their original ids. */
export function resumeStrategy(runId: string): RunStrategy<ResumeRequest> {
  const state: ResumeState = { interrupted: [], text: "" };
  return {
    plan: (svc, projectId, req, ctx) => planResume(runId, state, svc, projectId, req, ctx),
    execute: (svc, run, rt, req, ctx) => executeResume(state, svc, run, rt, req, ctx),
  };
}

async function planResume(
  runId: string,
  state: ResumeState,
  svc: RunHost,
  projectId: string,
  req: ResumeRequest,
  ctx: PlanCtx,
): Promise<RunPlan | Refusal> {
  const live = svc.get(runId);
  if (live && live.status !== "interrupted") return { ok: false, reason: `run is ${live.status}` };
  const loaded = await loadPersistedRun(svc, runId, ctx.stateDir, live);
  if (!loaded.ok) return loaded;
  const { persisted } = loaded;
  const taskRecords = live?.tasks ?? persisted?.tasks;
  if (!Array.isArray(taskRecords) || taskRecords.length === 0) {
    return { ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" };
  }
  const graph = TaskGraph.fromJSON(taskRecords);
  state.graph = graph;
  const interrupted = graph.all().filter((t) => t.status !== "done");
  state.interrupted = interrupted;
  markInterrupted(svc, runId, interrupted);
  if (req.confirmResume && interrupted.length > 0) {
    if (!(await confirmInterrupted(svc, runId, interrupted.length))) {
      return { ok: false, reason: "resume declined by user" };
    }
  }
  state.text = live?.messages.find((m) => m.role === "user")?.content ?? persisted?.text ?? "";
  const run: Run = {
    id: runId,
    projectId,
    status: "running",
    controller: new AbortController(),
    startedAt: live?.startedAt ?? persisted?.startedAt ?? svc.deps.clock.now(),
    messages: [{ role: "user", content: state.text }],
    costUsd: ctx.ledger.cost(runId).costUsd,
    tasks: graph.toJSON(),
    agentId: live?.agentId ?? persisted?.agentId,
  };
  return { run, title: state.text, config: req.config, channelFor: req.channelFor };
}

async function executeResume(
  state: ResumeState,
  svc: RunHost,
  run: Run,
  rt: RunRuntime,
  req: ResumeRequest,
  ctx: PlanCtx,
): Promise<RunOutcome> {
  const graph = state.graph!;
  const timeCap = rt.timeCap;
  for (const t of state.interrupted) {
    if (timeCap?.hit) break;
    await replayTask(svc, run, rt, req, ctx, graph, t, state.text);
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
      return { ok: false, reason: "resume unavailable: task graph replay is not implemented; starting over may repeat writes" };
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

async function replayTask(
  svc: RunHost,
  run: Run,
  rt: RunRuntime,
  req: ResumeRequest,
  ctx: PlanCtx,
  graph: TaskGraph,
  t: TaskRecord,
  text: string,
): Promise<void> {
  const isDirect = t.id === DIRECT_TASK_ID;
  const role = resolveRole(rt, t.roleId) ?? (isDirect ? chatRoleDef() : undefined);
  if (!role) {
    t.status = "failed";
    t.summary = `no enabled role for '${t.roleId}'`;
    return;
  }
  t.status = "running";
  run.tasks = graph.toJSON();
  await svc.journal(run, ctx.stateDir);
  svc.deps.bus.emit({ kind: "task.started", runId: run.id, taskId: t.id, roleId: role.id });
  // Direct run: lean replay (original request only; executed tool calls are skipped via the idempotency log).
  const res = isDirect
    ? await runRoleTask(
        rt,
        { ...t, task: `${text}\n\n(Resumed after interruption: continue; already-executed tool calls are skipped.)` },
        {
          role,
          agent: run.agentId ? req.config.agents.find((a) => a.id === run.agentId) : undefined,
          prompt: [await loadProjectContext(svc.deps.host)].filter(Boolean).join("") || undefined,
        },
      )
    : await rt.recoveryService.runTask(rt, t, { role }, { depth: 0, brain: rt.recoveryService.brain(rt) });
  rt.leases.release(t.id);
  t.filesTouched = res.filesTouched;
  t.status = res.status === "done" ? "done" : "failed";
  t.summary = res.summary;
  run.tasks = graph.toJSON();
  await svc.journal(run, ctx.stateDir);
  svc.deps.bus.emit(
    res.status === "done"
      ? { kind: "task.done", runId: run.id, taskId: t.id, roleId: role.id, summary: res.summary.slice(0, 400) }
      : { kind: "task.failed", runId: run.id, taskId: t.id, roleId: role.id, error: res.summary.slice(0, 400) },
  );
}
