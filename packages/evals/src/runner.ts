import { join } from "node:path";
import { Core } from "@stewart/core";
import type { RunEvent } from "@stewart/protocol";
import { dirStore } from "./configStore.js";
import { checkCtx } from "./kit.js";
import { nodeHost } from "./nodeHost.js";
import type { EvalTask, TaskKind } from "./tasks.js";
import { createWorkspace, removeWorkspace, type Workspace } from "./workspace.js";

export const PROJECT_ID = "eval";
const DEFAULT_ANSWER = "Proceed with your best judgment.";

export interface TurnResult {
  runId: string;
  status: string;
  error?: string;
  reply: string;
  costUsd: number;
  durationMs: number;
}

export interface TaskResult {
  id: string;
  kind: TaskKind;
  pass: boolean;
  evidence: string;
  statusAgrees: boolean;
  turns: TurnResult[];
  durationMs: number;
  costUsd: number;
  workspace?: string;
}

export interface RunOpts {
  config: string;
  disableLead: boolean;
  keep: "never" | "failed" | "always";
  log?: (line: string) => void;
}

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Collects core events, auto-answers approval and question cards, and resolves run.finished waits. */
export class EventLog {
  readonly events: RunEvent[] = [];
  private waiters = new Map<string, () => void>();
  dispatch: Dispatch = async () => undefined;

  push(ev: RunEvent): void {
    this.events.push(ev);
    if (ev.kind === "approval.request") void this.dispatch("chat.approve", { projectId: PROJECT_ID, approvalId: ev.approvalId, grant: "once" }).catch(() => {});
    if (ev.kind === "ask_user") void this.dispatch("chat.answer", { projectId: PROJECT_ID, questionId: ev.questionId, answer: ev.options?.[0] ?? DEFAULT_ANSWER }).catch(() => {});
    if (ev.kind === "run.finished" && !ev.taskId) this.waiters.get(ev.runId)?.();
  }

  finished(runId: string): Extract<RunEvent, { kind: "run.finished" }> | undefined {
    return this.events.find((e): e is Extract<RunEvent, { kind: "run.finished" }> => e.kind === "run.finished" && e.runId === runId && !e.taskId);
  }

  wait(runId: string, timeoutMs: number): Promise<boolean> {
    if (this.finished(runId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.set(runId, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  text(runId: string): string {
    return this.events.flatMap((e) => (e.kind === "text_delta" && e.runId === runId ? [e.text] : [])).join("");
  }

  cost(runId: string): number {
    return this.events.reduce((sum, e) => (e.kind === "cost.summary" && e.runId === runId ? Math.max(sum, e.accruedUsd) : sum), 0);
  }
}

async function finalReply(dispatch: Dispatch, sessionId: string, fallback: string): Promise<string> {
  const r = (await dispatch("history.load", { projectId: PROJECT_ID, sessionId }).catch(() => null)) as { messages?: { role: string; content: string }[] } | null;
  const last = (r?.messages ?? []).filter((m) => m.role === "assistant" && m.content.trim()).pop();
  return last?.content ?? fallback;
}

interface TurnCtx {
  log: EventLog;
  dispatch: Dispatch;
  sessionId: string;
  timeoutMs: number;
}

export async function runTurn(t: TurnCtx, text: string): Promise<TurnResult> {
  const started = Date.now();
  let runId = "";
  try {
    runId = ((await t.dispatch("chat.send", { projectId: PROJECT_ID, text, sessionId: t.sessionId })) as { runId: string }).runId;
  } catch (e) {
    return { runId, status: "error", error: e instanceof Error ? e.message : String(e), reply: "", costUsd: 0, durationMs: Date.now() - started };
  }
  const done = await t.log.wait(runId, t.timeoutMs);
  if (!done) {
    await t.dispatch("chat.cancel", { projectId: PROJECT_ID, runId }).catch(() => {});
    await t.log.wait(runId, 10_000);
  }
  const fin = t.log.finished(runId);
  const reply = await finalReply(t.dispatch, t.sessionId, t.log.text(runId));
  const status = done ? (fin?.status ?? "unknown") : "timeout";
  return { runId, status, error: fin?.error, reply, costUsd: t.log.cost(runId), durationMs: Date.now() - started };
}

export async function startCore(ws: Workspace, opts: RunOpts): Promise<{ log: EventLog; dispatch: Dispatch }> {
  const log = new EventLog();
  const core = new Core({
    defaults: {},
    userConfig: dirStore(ws.config),
    projectConfig: () => dirStore(join(ws.repo, ".stewart")),
    emitEvent: (ev) => log.push(ev),
  });
  log.dispatch = (method, params) => core.dispatch(method, params);
  await core.attachProject(PROJECT_ID, nodeHost({ root: ws.repo, stateDir: ws.state, log: opts.log }));
  return { log, dispatch: log.dispatch };
}

function shouldKeep(keep: RunOpts["keep"], pass: boolean): boolean {
  return keep === "always" || (keep === "failed" && !pass);
}

export async function runTask(task: EvalTask, opts: RunOpts, deps: { startCore?: typeof startCore } = {}): Promise<TaskResult> {
  const started = Date.now();
  const ws = await createWorkspace(task.id, opts.config, opts.disableLead);
  const { log, dispatch } = await (deps.startCore ?? startCore)(ws, opts);
  const ctx: TurnCtx = { log, dispatch, sessionId: `eval-${task.id}`, timeoutMs: (task.timeoutMin ?? 15) * 60_000 };
  const turns: TurnResult[] = [];
  for (const text of task.turns) turns.push(await runTurn(ctx, text));
  const verdict = await task.check(checkCtx(ws.repo, turns.map((t) => t.reply))).catch((e: unknown) => ({ pass: false, evidence: `check threw: ${e}` }));
  const keep = shouldKeep(opts.keep, verdict.pass);
  if (!keep) await removeWorkspace(ws);
  const allDone = turns.every((t) => t.status === "done");
  return {
    id: task.id,
    kind: task.kind,
    pass: verdict.pass,
    evidence: verdict.evidence,
    statusAgrees: allDone === verdict.pass,
    turns,
    durationMs: Date.now() - started,
    costUsd: turns.reduce((s, t) => s + t.costUsd, 0),
    workspace: keep ? ws.dir : undefined,
  };
}
