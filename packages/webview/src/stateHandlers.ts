import type { RunEvent } from "@stewart/protocol";
import type { Inbound, Outbound, SetupProbeSnapshot, StoredMessage } from "./bridge.js";
import type { ChatItem, State, TaskRow } from "./stateTypes.js";

export interface HandlerHost {
  getState(): State;
  patch(p: Partial<State>): void;
  mutateAssistant(runId: string, fn: (it: ChatItem) => void): void;
  addActivity(runId: string, kind: string, text: string): void;
  patchTask(taskId: string | undefined, update: (t: TaskRow) => Partial<TaskRow>): void;
  requestConfig(): void;
  post(msg: Outbound): void;
  nextItemSeq(): number;
  nextInsertSeq(): number;
}

type Reply = Exclude<Inbound, { type: "event" }>;
type ReplyHandlers = { [K in Reply["type"]]: (m: Extract<Reply, { type: K }>) => void };
type EventHandlers = { [K in RunEvent["kind"]]?: (ev: Extract<RunEvent, { kind: K }>) => void };

/** Inbound reply/event dispatch for Store; all state access goes through the host. */
export class StoreHandlers {
  private replyHandlers: ReplyHandlers = {
    config: (m) => this.patch({ config: { files: m.files, summary: m.summary, errors: m.errors, secrets: m.secrets }, lastError: undefined }),
    "channel.test.result": (m) =>
      this.patch({ channelTest: { ...this.state.channelTest, [m.channelId]: { ok: m.ok, models: m.models, error: m.error } } }),
    "channel.probe.result": (m) =>
      this.patch({
        probeResults: {
          ...this.state.probeResults,
          [`${m.channelId}:${m.model}`]: { ok: m.ok, caps: m.caps, probedAt: m.probedAt, cached: m.cached, catalog: m.catalog, error: m.error },
        },
      }),
    "history.sessions": (m) => this.patch({ sessions: m.sessions }),
    "history.messages": (m) => this.onHistoryMessages(m),
    insertText: (m) => this.patch({ composerInsert: { text: m.text, seq: this.host.nextInsertSeq() } }),
    ready: () => {},
    "setup.probe.result": (m) => {
      const { type: _t, ...snap } = m;
      this.patch({ smoke: snap });
    },
    "setup.session.result": (m) => this.patch({ setupPhase: m.phase }),
    "setup.session.addChannel.result": (m) => this.onChannelResult(m),
    "setup.session.removeChannel.result": (m) => this.onChannelResult(m),
    "setup.review.result": (m) => this.onReviewResult(m),
    "setup.approve.result": (m) => this.patch({ setupSaved: m.ok, setupError: m.error }),
    "setup.undo.result": (m) => this.patch({ setupSaved: false, setupError: m.error }),
    "setup.qualify.result": (m) =>
      this.patch({ qualResults: { ...this.state.qualResults, [`${m.channel}:${m.model}`]: { agent: m.agent, function: m.function, error: m.error } } }),
    "setup.recommend.result": (m) => this.onRecommendResult(m),
    error: (m) => this.onErrorReply(m),
  };

  private eventHandlers: EventHandlers = {
    "run.started": (ev) => this.patch({ busyRunId: ev.runId, lastRunId: ev.runId, tasks: [], cost: undefined }),
    "task.created": (ev) => this.onTaskEvent(ev),
    "task.started": (ev) => this.onTaskEvent(ev),
    "task.done": (ev) => this.onTaskEvent(ev),
    "task.failed": (ev) => this.onTaskEvent(ev),
    "cost.limit_reached": (ev) => this.onCostEvent(ev),
    "cost.limit_raised": (ev) => this.onCostEvent(ev),
    "cost.summary": (ev) => this.onCostEvent(ev),
    "text_delta": (ev) =>
      this.mutateAssistant(ev.runId, (it) => {
        it.text += ev.text;
      }),
    "reasoning_delta": (ev) =>
      this.mutateAssistant(ev.runId, (it) => {
        it.reasoning = (it.reasoning ?? "") + ev.text;
      }),
    "tool.request": (ev) => this.addActivity(ev.runId, "tool", ev.tool),
    "tool.outcome": (ev) => this.addActivity(ev.runId, ev.ok ? "tool-ok" : "tool-fail", ev.summary),
    "check.result": (ev) => this.onCheckResult(ev),
    "run.escalated": (ev) => this.addActivity(ev.runId, "escalated", `${ev.from} → ${ev.to}: ${ev.reason}`),
    ask_user: (ev) => this.patch({ questions: [...this.state.questions, { questionId: ev.questionId, runId: ev.runId, question: ev.question, options: ev.options }] }),
    "question.withdrawn": (ev) => this.patch({ questions: this.state.questions.filter((q) => q.questionId !== ev.questionId) }),
    "approval.request": (ev) => this.patch({ approvals: [...this.state.approvals, { approvalId: ev.approvalId, runId: ev.runId, tool: ev.tool, args: ev.args, category: ev.category }] }),
    "plan.approved": () => this.patch({ plan: { active: true, milestones: [] } }),
    "milestone.started": (ev) => this.onMilestoneStarted(ev),
    "milestone.done": (ev) => this.onMilestoneSet(ev.milestoneId, "done"),
    "milestone.failed": (ev) => this.onMilestoneSet(ev.milestoneId, "failed"),
    "run.reverted": (ev) =>
      this.patch({
        items: [
          ...this.state.items,
          { id: `sys${this.host.nextItemSeq()}`, role: "system" as const, text: `Reverted: ${ev.filesRestored.join(", ")}`, activity: [] },
        ],
      }),
    "setup.event": (ev) => this.onSetupEvent(ev),
    "run.finished": (ev) => this.onRunFinished(ev),
  };

  constructor(private readonly host: HandlerHost) {}

  private get state(): State {
    return this.host.getState();
  }
  private patch(p: Partial<State>): void {
    this.host.patch(p);
  }
  private mutateAssistant(runId: string, fn: (it: ChatItem) => void): void {
    this.host.mutateAssistant(runId, fn);
  }
  private addActivity(runId: string, kind: string, text: string): void {
    this.host.addActivity(runId, kind, text);
  }
  private patchTask(taskId: string | undefined, update: (t: TaskRow) => Partial<TaskRow>): void {
    this.host.patchTask(taskId, update);
  }
  private requestConfig(): void {
    this.host.requestConfig();
  }

  onInbound(m: Inbound): void {
    if (m.type === "event") return this.onEvent(m.ev);
    this.onReply(m);
  }

  private dispatch<M extends string>(handlers: Partial<Record<M, (m: never) => void>>, type: M, msg: unknown): void {
    if (!Object.hasOwn(handlers, type)) return;
    (handlers[type] as ((m: unknown) => void) | undefined)?.(msg);
  }

  private onReply(m: Reply): void {
    this.dispatch(this.replyHandlers, m.type, m);
  }

  /** The session wrote channels.yaml (or refused): show any error and refresh the config so the channel list updates. */
  private onChannelResult(m: { ok: boolean; error?: string }): void {
    this.patch({ setupChannelError: m.ok ? undefined : (m.error ?? "could not change the channel") });
    this.host.post({ type: "config.get" });
  }

  private onReviewResult(m: Extract<Reply, { type: "setup.review.result" }>): void {
    if (m.token) this.host.post({ type: "setup.approve", token: m.token });
    else this.patch({ setupError: m.error ?? "review failed" });
  }

  private onRecommendResult(m: Extract<Reply, { type: "setup.recommend.result" }>): void {
    if (m.ok)
      return this.patch({
        recommendBusy: false,
        recommendation: { assignments: m.assignments ?? [], researcher: m.researcher, unfilled: m.unfilled, dropped: m.dropped },
        recommendError: undefined,
      });
    this.patch({ recommendBusy: false, recommendation: undefined, recommendError: m.error ?? "recommendation failed" });
  }

  private onErrorReply(m: Extract<Reply, { type: "error" }>): void {
    this.patch({
      lastError: m.message,
      items: [...this.state.items, { id: `sys${this.host.nextItemSeq()}`, role: "system" as const, text: `error: ${m.message}`, activity: [] }],
    });
  }

  private onHistoryMessages(m: { sessionId: string; messages: StoredMessage[]; plan?: { goal?: string; status?: string; active?: boolean; milestones?: { id: string; title: string; status: string; checkpoint?: string }[] } }): void {
    const items = m.messages.map((msg: StoredMessage): ChatItem => ({
      id: `h${this.host.nextItemSeq()}`,
      role: msg.role === "tool" ? "system" : msg.role,
      text: msg.role === "tool" ? `⚙ ${msg.content}` : msg.content,
      images: msg.images,
      activity: (msg.toolCalls ?? []).map((tc) => ({ kind: "tool", text: tc.name })),
    }));
    this.patch({
      items,
      sessionId: m.sessionId,
      historyOpen: false,
      view: "chat",
      tasks: [],
      cost: undefined,
      busyRunId: undefined,
      plan: m.plan
        ? {
            goal: m.plan.goal,
            active: m.plan.active ?? m.plan.status === "active",
            milestones: (m.plan.milestones ?? []).map((x) => ({ id: x.id, title: x.title, status: x.status === "done" ? "done" : x.status === "failed" ? "failed" : "pending", checkpoint: x.checkpoint })),
          }
        : undefined,
    });
  }


  private onEvent(ev: RunEvent): void {
    this.dispatch(this.eventHandlers, ev.kind, ev);
  }

  private onCheckResult(ev: Extract<RunEvent, { kind: "check.result" }>): void {
    if (ev.passed) return this.addActivity(ev.runId, "tool-ok", "check passed");
    this.patch({
      items: [...this.state.items, { id: `sys${this.host.nextItemSeq()}`, role: "system" as const, text: `Check failed: ${ev.evidence.join("; ")}`, activity: [] }],
    });
  }

  private onSetupEvent(ev: Extract<RunEvent, { kind: "setup.event" }>): void {
    const e = (ev as { event?: { kind?: string; snapshot?: SetupProbeSnapshot } }).event;
    if (e?.kind === "probe.state" && e.snapshot) this.patch({ smoke: e.snapshot });
  }

  private onMilestoneStarted(ev: Extract<RunEvent, { kind: "milestone.started" }>): void {
    const ms = this.state.plan?.milestones ?? [];
    const next = ms.some((m) => m.id === ev.milestoneId)
      ? ms.map((m) => (m.id === ev.milestoneId ? { ...m, status: "running" as const } : m))
      : [...ms, { id: ev.milestoneId, title: ev.title, status: "running" as const }];
    this.patch({ plan: { active: true, milestones: next } });
  }

  private onMilestoneSet(id: string, status: "done" | "failed"): void {
    const plan = this.state.plan;
    if (!plan) return;
    const milestones = plan.milestones.map((m) => (m.id === id ? { ...m, status } : m));
    this.patch({ plan: { ...plan, milestones, active: status === "failed" ? plan.active : milestones.some((m) => m.status !== "done") } });
  }

  private onTaskEvent(ev: Extract<RunEvent, { kind: `task.${string}` }>): void {
    switch (ev.kind) {
      case "task.created":
        return this.patch({
          tasks: [...this.state.tasks, { taskId: ev.taskId ?? "", roleId: ev.roleId ?? "", title: ev.title, status: "pending" }],
        });
      case "task.started":
        return this.patchTask(ev.taskId, (t) => ({ status: "running", agentId: ev.agentId ?? t.agentId, startedAt: Date.now() }));
      case "task.done":
        return this.patchTask(ev.taskId, () => ({ status: "done", summary: ev.summary }));
      case "task.failed":
        return this.patchTask(ev.taskId, () => ({ status: "failed", summary: ev.error }));
    }
  }

  private onCostEvent(ev: Extract<RunEvent, { kind: "cost.limit_reached" | "cost.limit_raised" | "cost.summary" }>): void {
    switch (ev.kind) {
      case "cost.limit_reached":
        return this.patch({
          cost: {
            ...(this.state.cost ?? {
              overshootUsd: 0,
              byRole: {},
              byAgent: {},
              parked: [],
              freeFinished: [],
              suggestions: [],
            }),
            capUsd: ev.capUsd,
            accruedUsd: ev.accruedUsd,
          },
        });
      case "cost.limit_raised":
        return this.patch({ cost: this.state.cost ? { ...this.state.cost, capUsd: ev.capUsd } : this.state.cost });
      case "cost.summary":
        return this.patch({
          cost: {
            capUsd: ev.capUsd,
            accruedUsd: ev.accruedUsd,
            overshootUsd: ev.overshootUsd,
            byRole: ev.byRole,
            byAgent: ev.byAgent,
            parked: ev.parked,
            freeFinished: ev.freeFinished,
            suggestions: ev.suggestions,
          },
        });
    }
  }

  private onRunFinished(ev: Extract<RunEvent, { kind: "run.finished" }>): void {
    const items = this.state.items.map((i) => (i.id === ev.runId ? { ...i, streaming: false } : i));
    const last = items[items.length - 1];
    const extra: ChatItem[] =
      ev.status !== "done" && (!last || last.id !== ev.runId)
        ? [...items, { id: `sys${this.host.nextItemSeq()}`, role: "system" as const, text: ev.error ?? ev.status, activity: [] }]
        : ev.status !== "done" && ev.error && last
          ? items.map((i, idx) => (idx === items.length - 1 ? { ...i, streaming: false, text: i.text || `(${ev.error})` } : i))
          : items;
    this.patch({ items: extra, busyRunId: undefined, lastRunId: ev.runId });
  }
}
