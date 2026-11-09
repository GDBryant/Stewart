import type { RunEvent } from "@stewart/protocol";
import type { Bridge, ConfigReply, Inbound, SessionSummary, SetupProbeSnapshot, StoredMessage } from "./bridge.js";

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  images?: string[];
  /** Collapsed activity rows: tool calls, tasks, approvals. */
  activity: { kind: string; text: string }[];
}

export interface V1Draft {
  files: Record<string, string>;
  warnings: string[];
  xml?: string;
}

export const MAX_PENDING_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PendingApproval {
  approvalId: string;
  runId: string;
  tool: string;
  args: unknown;
  category: string;
}

export interface PendingQuestion {
  questionId: string;
  runId: string;
  question: string;
  options?: string[];
}

export interface TaskRow {
  taskId: string;
  roleId: string;
  title: string;
  status: "pending" | "running" | "waiting" | "done" | "failed";
  summary?: string;
  waitingOn?: string;
  agentId?: string;
  /** Epoch ms when the task last entered running; drives the active-task timer. */
  startedAt?: number;
}

export interface CostState {
  capUsd: number;
  accruedUsd: number;
  overshootUsd: number;
  byRole: Record<string, number>;
  byAgent: Record<string, { costUsd: number; inTokens: number; outTokens: number }>;
  parked: string[];
  freeFinished: string[];
  suggestions: { role: string; agent: string; reason: string }[];
}

export interface PlanState {
  milestoneCount: number;
  verdict?: "approve" | "revise";
  reasons: string[];
  approved: boolean;
}

export interface State {
  items: ChatItem[];
  tasks: TaskRow[];
  cost?: CostState;
  plan?: PlanState;
  busyRunId?: string;
  lastRunId?: string;
  revertedRuns: string[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  config?: ConfigReply;
  channelTest: Record<string, { ok: boolean; models?: string[]; error?: string }>;
  probeResults: Record<string, { ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; catalog?: import("./bridge.js").CatalogInfo; error?: string }>;
  wizardOpen?: boolean;
  view: "chat" | "settings";
  sessionId?: string;
  sessions: SessionSummary[];
  historyOpen: boolean;
  pendingImages: string[];
  attachError?: string;
  v1Draft?: V1Draft;
  /** Host pushed text into the composer (e.g. "Add selection to chat"). */
  composerInsert?: { text: string; seq: number };
  /** Last {type:"error"} message; shown in Settings since it may carry no chat context. */
  lastError?: string;
  /** User profile override for the next run; "auto" = server-side classifier. */
  profileChoice: "auto" | "quick" | "normal" | "deep";
  /** Profile the current/last run used, from run.started. */
  runProfile?: string;
  recommendBusy?: boolean;
  /** Server-owned setup quick-probe queue snapshot (queued/running/green/orange/red/skipped). */
  smoke?: SetupProbeSnapshot;
  setupPhase?: string;
  setupSaved?: boolean;
  setupError?: string;
  recommendation?: {
    assignments: { role: string; channel: string; model: string; reason?: string; score?: number; warnings?: string[]; source?: "rules" | "ai" }[];
    researcher?: { channel: string; model: string };
    unfilled?: { role: string; reason: string }[];
    dropped?: string[];
  };
  recommendError?: string;
}

type Listener = () => void;
type Reply = Exclude<Inbound, { type: "event" }>;
type ReplyHandlers = { [K in Reply["type"]]: (m: Extract<Reply, { type: K }>) => void };
type EventHandlers = { [K in RunEvent["kind"]]?: (ev: Extract<RunEvent, { kind: K }>) => void };

/** Minimal observable store; one instance per webview. */
export class Store {
  state: State = {
    items: [],
    tasks: [],
    revertedRuns: [],
    approvals: [],
    questions: [],
    channelTest: {},
    probeResults: {},
    view: "chat",
    sessions: [],
    historyOpen: false,
    pendingImages: [],
    profileChoice: "auto",
  };
  private listeners = new Set<Listener>();
  private itemSeq = 0;
  private insertSeq = 0;

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
    "v1.draft": (m) => this.onV1Draft(m),
    insertText: (m) => this.patch({ composerInsert: { text: m.text, seq: ++this.insertSeq } }),
    ready: () => {},
    "setup.probe.result": (m) => {
      const { type: _t, ...snap } = m;
      this.patch({ smoke: snap });
    },
    "setup.session.result": (m) => this.patch({ setupPhase: m.phase }),
    "setup.review.result": (m) => this.onReviewResult(m),
    "setup.approve.result": (m) => this.patch({ setupSaved: m.ok, setupError: m.error }),
    "setup.undo.result": (m) => this.patch({ setupSaved: false, setupError: m.error }),
    "setup.recommend.result": (m) => this.onRecommendResult(m),
    error: (m) => this.onErrorReply(m),
  };

  private eventHandlers: EventHandlers = {
    "run.started": (ev) => this.patch({ busyRunId: ev.runId, lastRunId: ev.runId, tasks: [], cost: undefined, plan: undefined, runProfile: ev.profile }),
    "task.created": (ev) => this.onTaskEvent(ev),
    "task.started": (ev) => this.onTaskEvent(ev),
    "task.blocked": (ev) => this.onTaskEvent(ev),
    "task.done": (ev) => this.onTaskEvent(ev),
    "task.failed": (ev) => this.onTaskEvent(ev),
    "plan.created": (ev) => this.onPlanEvent(ev),
    "plan.validated": (ev) => this.onPlanEvent(ev),
    "plan.approved": (ev) => this.onPlanEvent(ev),
    "cost.limit_reached": (ev) => this.onCostEvent(ev),
    "cost.limit_raised": (ev) => this.onCostEvent(ev),
    "cost.summary": (ev) => this.onCostEvent(ev),
    "cost.replaced": (ev) => this.addActivity(ev.runId, "tool-ok", `replaced ${ev.roleId} → ${ev.agentId}`),
    compaction: (ev) => this.onCompaction(ev),
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
    ask_user: (ev) => this.patch({ questions: [...this.state.questions, { questionId: ev.questionId, runId: ev.runId, question: ev.question, options: ev.options }] }),
    "question.withdrawn": (ev) => this.patch({ questions: this.state.questions.filter((q) => q.questionId !== ev.questionId) }),
    "approval.request": (ev) => this.patch({ approvals: [...this.state.approvals, { approvalId: ev.approvalId, runId: ev.runId, tool: ev.tool, args: ev.args, category: ev.category }] }),
    "run.reverted": (ev) =>
      this.patch({
        revertedRuns: [...this.state.revertedRuns, ev.runId],
        items: [
          ...this.state.items,
          { id: `sys${++this.itemSeq}`, role: "system" as const, text: `Reverted: ${ev.filesRestored.join(", ")}`, activity: [] },
        ],
      }),
    "setup.event": (ev) => this.onSetupEvent(ev),
    "run.finished": (ev) => this.onRunFinished(ev),
  };

  constructor(private bridge: Bridge) {
    bridge.onMessage((m) => this.onInbound(m));
    bridge.post({ type: "ready" });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }
  private patch(p: Partial<State>): void {
    this.state = { ...this.state, ...p };
    this.changed();
  }

  send(text: string): void {
    const images = this.state.pendingImages;
    if ((!text.trim() && !images.length) || this.state.busyRunId) return;
    const sessionId = this.state.sessionId ?? `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.patch({
      items: [
        ...this.state.items,
        { id: `u${++this.itemSeq}`, role: "user", text, images: images.length ? images : undefined, activity: [] },
      ],
      pendingImages: [],
      attachError: undefined,
      sessionId,
    });
    this.bridge.post({
      type: "chat.send",
      text,
      images: images.length ? images : undefined,
      sessionId,
      ...(this.state.profileChoice !== "auto" ? { profile: this.state.profileChoice } : {}),
    });
  }

  setProfileChoice(profileChoice: State["profileChoice"]): void {
    this.patch({ profileChoice });
  }
  rejectAttachment(reason: string): void {
    this.patch({ attachError: reason });
  }
  addImage(dataUri: string): void {
    if (this.state.pendingImages.length >= MAX_PENDING_IMAGES) {
      return this.patch({ attachError: `at most ${MAX_PENDING_IMAGES} images per message` });
    }
    const comma = dataUri.indexOf(",");
    const approx = Math.max(0, (dataUri.length - comma - 1) * 0.75);
    if (approx > MAX_IMAGE_BYTES) {
      return this.patch({ attachError: "image exceeds the 5 MB limit" });
    }
    this.patch({ pendingImages: [...this.state.pendingImages, dataUri], attachError: undefined });
  }
  removeImage(index: number): void {
    this.patch({ pendingImages: this.state.pendingImages.filter((_, i) => i !== index) });
  }
  insertIntoEditor(text: string): void {
    if (text.trim()) this.bridge.post({ type: "editor.insert", text });
  }
  toggleHistory(): void {
    const historyOpen = !this.state.historyOpen;
    this.patch({ historyOpen });
    if (historyOpen) this.bridge.post({ type: "history.list" });
  }
  openSession(sessionId: string): void {
    this.bridge.post({ type: "history.load", sessionId });
  }
  deleteSession(sessionId: string): void {
    this.bridge.post({ type: "history.delete", sessionId });
    if (this.state.sessionId === sessionId) this.patch({ sessionId: undefined });
    this.bridge.post({ type: "history.list" });
  }
  newSession(): void {
    if (this.state.busyRunId) return;
    this.patch({ sessionId: undefined, items: [], historyOpen: false });
  }
  requestV1Import(): void {
    this.bridge.post({ type: "v1.import" });
  }
  applyV1Draft(): void {
    const xml = this.state.v1Draft?.xml;
    if (xml) this.bridge.post({ type: "config.importV1", xml, apply: true });
  }
  dismissV1Draft(): void {
    this.patch({ v1Draft: undefined });
  }
  cancel(): void {
    if (this.state.busyRunId) this.bridge.post({ type: "chat.cancel", runId: this.state.busyRunId });
  }
  revert(runId?: string): void {
    const id = runId ?? this.state.lastRunId;
    if (id && !this.state.busyRunId) this.bridge.post({ type: "chat.revert", runId: id });
  }
  answer(questionId: string, answer: string): void {
    this.bridge.post({ type: "chat.answer", questionId, answer });
    this.patch({ questions: this.state.questions.filter((q) => q.questionId !== questionId) });
  }
  approve(approvalId: string, grant: "once" | "chat" | "always" | "deny"): void {
    this.bridge.post({ type: "chat.approve", approvalId, grant });
    this.patch({ approvals: this.state.approvals.filter((a) => a.approvalId !== approvalId) });
  }
  requestConfig(): void {
    this.bridge.post({ type: "config.get" });
  }
  saveFile(file: string, yaml: string, layer?: "user" | "project"): void {
    this.bridge.post({ type: "config.set", file, yaml, layer });
  }
  testChannel(channelId: string): void {
    this.bridge.post({ type: "channel.test", channelId });
  }
  probeModel(channelId: string, model: string, force = false, bench = false): void {
    this.bridge.post({ type: "channel.probe", channelId, model, force, ...(bench ? { bench: true } : {}) });
  }
  setSecret(ref: string, value: string): void {
    this.bridge.post({ type: "secret.set", ref, value });
    this.requestConfig();
  }
  deleteSecret(ref: string): void {
    this.bridge.post({ type: "secret.delete", ref });
    this.requestConfig();
  }
  saveSkill(id: string, body: string, description?: string): void {
    this.bridge.post({ type: "skills.save", id, body, description });
    this.requestConfig();
  }
  resetSkill(id: string): void {
    this.bridge.post({ type: "skills.reset", id });
    this.requestConfig();
  }
  openSkill(id: string): void {
    this.bridge.post({ type: "skills.open", id });
  }
  resetRole(roleId?: string): void {
    this.bridge.post({ type: "roles.reset", roleId });
    this.requestConfig();
  }
  assignAgentToAll(agentId: string, wizard?: boolean): void {
    this.bridge.post(wizard !== undefined ? { type: "roles.assignAgent", agentId, wizard } : { type: "roles.assignAgent", agentId });
    this.requestConfig();
  }
  /** Stage the rendered file set, then review → auto-approve (result arrives as setup.approve.result). */
  setupApply(files: Record<string, string>): void {
    this.patch({ setupSaved: undefined, setupError: undefined });
    this.bridge.post({ type: "setup.session.update", patch: { files } });
    this.bridge.post({ type: "setup.review" });
  }

  setupUndo(): void {
    this.bridge.post({ type: "setup.undo" });
  }

  setWizardOpen(wizardOpen: boolean): void {
    this.patch({ wizardOpen });
    if (wizardOpen) {
      this.patch({ setupSaved: undefined, setupError: undefined });
      this.bridge.post({ type: "setup.session.start" });
    } else {
      this.bridge.post({ type: "setup.session.cancel" });
    }
  }
  startProbe(candidates: { channel: string; model: string }[], evaluator?: { channel: string; model: string }): void {
    this.bridge.post(evaluator ? { type: "setup.probe.start", candidates, evaluator } : { type: "setup.probe.start", candidates });
  }
  cancelProbe(): void {
    this.bridge.post({ type: "setup.probe.cancel" });
  }
  retryProbe(): void {
    this.bridge.post({ type: "setup.probe.retry" });
  }
  recommend(opts?: { mode?: "rules" | "ai"; evaluator?: { channel: string; model: string }; evaluatorAny?: boolean; context?: { priorities?: { speed?: number; cost?: number; quality?: number }; typicalWork?: string }; bench?: boolean }): void {
    if (this.state.recommendBusy) return;
    this.bridge.post(opts ? { type: "setup.recommend", ...opts } : { type: "setup.recommend" });
    this.patch({ recommendBusy: true, recommendError: undefined });
  }
  dismissRecommendation(): void {
    this.patch({ recommendation: undefined });
  }
  setView(view: State["view"]): void {
    this.patch({ view });
    if (view === "settings") this.requestConfig();
  }

  private assistantFor(runId: string): ChatItem {
    const items = this.state.items;
    const last = items[items.length - 1];
    if (last && last.role === "assistant" && last.streaming && last.id === runId) return last;
    const it: ChatItem = { id: runId, role: "assistant", text: "", streaming: true, activity: [] };
    this.state.items = [...items, it];
    return it;
  }

  private patchTask(taskId: string | undefined, update: (t: TaskRow) => Partial<TaskRow>): void {
    this.patch({ tasks: this.state.tasks.map((t) => (t.taskId === taskId ? { ...t, ...update(t) } : t)) });
  }

  private mutateAssistant(runId: string, fn: (it: ChatItem) => void): void {
    fn(this.assistantFor(runId));
    this.changed();
  }

  private addActivity(runId: string, kind: string, text: string): void {
    this.mutateAssistant(runId, (it) => {
      it.activity = [...it.activity, { kind, text }];
    });
  }

  private onInbound(m: Inbound): void {
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

  private onReviewResult(m: Extract<Reply, { type: "setup.review.result" }>): void {
    if (m.token) this.bridge.post({ type: "setup.approve", token: m.token });
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
      items: [...this.state.items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: `error: ${m.message}`, activity: [] }],
    });
  }

  private onHistoryMessages(m: { sessionId: string; messages: StoredMessage[] }): void {
    const items = m.messages.map((msg: StoredMessage): ChatItem => ({
      id: `h${++this.itemSeq}`,
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
      plan: undefined,
      busyRunId: undefined,
    });
  }

  private onV1Draft(m: { files: Record<string, string>; warnings: string[]; xml?: string; applied?: boolean }): void {
    if (m.applied) {
      this.requestConfig();
      return this.patch({
        v1Draft: undefined,
        items: [...this.state.items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: "v1 settings imported.", activity: [] }],
      });
    }
    this.patch({ v1Draft: { files: m.files, warnings: m.warnings, xml: m.xml } });
  }

  private onEvent(ev: RunEvent): void {
    this.dispatch(this.eventHandlers, ev.kind, ev);
  }

  private onCompaction(ev: Extract<RunEvent, { kind: "compaction" }>): void {
    this.addActivity(ev.runId, "tool-ok", `context compacted: -${ev.droppedTokens} tokens${ev.pruned ? `, ${ev.pruned} pruned` : ""}${ev.summarized ? ", summarized" : ""}`);
  }

  private onSetupEvent(ev: Extract<RunEvent, { kind: "setup.event" }>): void {
    const e = (ev as { event?: { kind?: string; snapshot?: SetupProbeSnapshot } }).event;
    if (e?.kind === "probe.state" && e.snapshot) this.patch({ smoke: e.snapshot });
  }

  private onTaskEvent(ev: Extract<RunEvent, { kind: `task.${string}` }>): void {
    switch (ev.kind) {
      case "task.created":
        return this.patch({
          tasks: [...this.state.tasks, { taskId: ev.taskId ?? "", roleId: ev.roleId ?? "", title: ev.title, status: "pending" }],
        });
      case "task.started":
        return this.patchTask(ev.taskId, (t) => ({ status: "running", agentId: ev.agentId ?? t.agentId, startedAt: Date.now() }));
      case "task.blocked":
        return this.patchTask(ev.taskId, () => ({ status: "waiting", waitingOn: ev.waitingOn }));
      case "task.done":
        return this.patchTask(ev.taskId, () => ({ status: "done", summary: ev.summary }));
      case "task.failed":
        return this.patchTask(ev.taskId, () => ({ status: "failed", summary: ev.error }));
    }
  }

  private onPlanEvent(ev: Extract<RunEvent, { kind: `plan.${string}` }>): void {
    switch (ev.kind) {
      case "plan.created":
        return this.patch({ plan: { milestoneCount: ev.milestoneCount, reasons: [], approved: false } });
      case "plan.validated":
        return this.patch({
          plan: { milestoneCount: this.state.plan?.milestoneCount ?? 0, verdict: ev.verdict, reasons: ev.reasons, approved: false },
        });
      case "plan.approved":
        return this.patch({
          plan: {
            milestoneCount: ev.milestoneCount,
            verdict: "approve",
            reasons: this.state.plan?.reasons ?? [],
            approved: true,
          },
        });
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
        ? [...items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: ev.error ?? ev.status, activity: [] }]
        : ev.status !== "done" && ev.error && last
          ? items.map((i, idx) => (idx === items.length - 1 ? { ...i, streaming: false, text: i.text || `(${ev.error})` } : i))
          : items;
    this.patch({ items: extra, busyRunId: undefined, lastRunId: ev.runId });
  }
}
