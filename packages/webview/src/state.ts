import type { RunEvent } from "@stewart/protocol";
import type { Bridge, ConfigReply, Inbound, SessionSummary, StoredMessage } from "./bridge.js";

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
  probeResults: Record<string, { ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; error?: string }>;
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
  recommendBusy?: boolean;
  recommendation?: {
    assignments: { role: string; channel: string; model: string; reason?: string; score?: number; warnings?: string[]; source?: "rules" | "ai" }[];
    researcher?: { channel: string; model: string };
    unfilled?: { role: string; reason: string }[];
    dropped?: string[];
  };
  recommendError?: string;
}

type Listener = () => void;

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
  };
  private listeners = new Set<Listener>();
  private itemSeq = 0;
  private insertSeq = 0;

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
    });
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
  probeModel(channelId: string, model: string, force = false): void {
    this.bridge.post({ type: "channel.probe", channelId, model, force });
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
  setWizardOpen(wizardOpen: boolean): void {
    this.patch({ wizardOpen });
  }
  recommend(opts?: { mode?: "rules" | "ai"; evaluator?: { channel: string; model: string } }): void {
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

  private onInbound(m: Inbound): void {
    if (m.type === "config") return this.patch({ config: { files: m.files, summary: m.summary, errors: m.errors, secrets: m.secrets }, lastError: undefined });
    if (m.type === "channel.test.result")
      return this.patch({ channelTest: { ...this.state.channelTest, [m.channelId]: { ok: m.ok, models: m.models, error: m.error } } });
    if (m.type === "channel.probe.result")
      return this.patch({
        probeResults: {
          ...this.state.probeResults,
          [`${m.channelId}:${m.model}`]: { ok: m.ok, caps: m.caps, probedAt: m.probedAt, cached: m.cached, error: m.error },
        },
      });
    if (m.type === "history.sessions") return this.patch({ sessions: m.sessions });
    if (m.type === "history.messages") {
      const items = m.messages.map((msg: StoredMessage): ChatItem => ({
        id: `h${++this.itemSeq}`,
        role: msg.role === "tool" ? "system" : msg.role,
        text: msg.role === "tool" ? `⚙ ${msg.content}` : msg.content,
        images: msg.images,
        activity: (msg.toolCalls ?? []).map((tc) => ({ kind: "tool", text: tc.name })),
      }));
      return this.patch({
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
    if (m.type === "v1.draft") {
      if (m.applied) {
        this.requestConfig();
        return this.patch({
          v1Draft: undefined,
          items: [...this.state.items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: "v1 settings imported.", activity: [] }],
        });
      }
      return this.patch({ v1Draft: { files: m.files, warnings: m.warnings, xml: m.xml } });
    }
    if (m.type === "insertText") return this.patch({ composerInsert: { text: m.text, seq: ++this.insertSeq } });
    if (m.type === "setup.recommend.result") {
      if (m.ok)
        return this.patch({
          recommendBusy: false,
          recommendation: { assignments: m.assignments ?? [], researcher: m.researcher, unfilled: m.unfilled, dropped: m.dropped },
          recommendError: undefined,
        });
      return this.patch({ recommendBusy: false, recommendation: undefined, recommendError: m.error ?? "recommendation failed" });
    }
    if (m.type === "error")
      return this.patch({
        lastError: m.message,
        items: [...this.state.items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: `error: ${m.message}`, activity: [] }],
      });
    if (m.type !== "event") return;
    const ev = m.ev;
    switch (ev.kind) {
      case "run.started":
        return this.patch({ busyRunId: ev.runId, lastRunId: ev.runId, tasks: [], cost: undefined, plan: undefined });
      case "task.created":
        return this.patch({
          tasks: [...this.state.tasks, { taskId: ev.taskId ?? "", roleId: ev.roleId ?? "", title: ev.title, status: "pending" }],
        });
      case "task.started":
        return this.patch({ tasks: this.state.tasks.map((t) => (t.taskId === ev.taskId ? { ...t, status: "running", agentId: ev.agentId ?? t.agentId, startedAt: Date.now() } : t)) });
      case "task.blocked":
        return this.patch({
          tasks: this.state.tasks.map((t) => (t.taskId === ev.taskId ? { ...t, status: "waiting", waitingOn: ev.waitingOn } : t)),
        });
      case "task.done":
        return this.patch({
          tasks: this.state.tasks.map((t) => (t.taskId === ev.taskId ? { ...t, status: "done", summary: ev.summary } : t)),
        });
      case "task.failed":
        return this.patch({
          tasks: this.state.tasks.map((t) => (t.taskId === ev.taskId ? { ...t, status: "failed", summary: ev.error } : t)),
        });
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
      case "cost.replaced": {
        const it = this.assistantFor(ev.runId);
        it.activity = [...it.activity, { kind: "tool-ok", text: `replaced ${ev.roleId} → ${ev.agentId}` }];
        return this.changed();
      }
      case "text_delta": {
        const it = this.assistantFor(ev.runId);
        it.text += ev.text;
        return this.changed();
      }
      case "reasoning_delta": {
        const it = this.assistantFor(ev.runId);
        it.reasoning = (it.reasoning ?? "") + ev.text;
        return this.changed();
      }
      case "tool.request": {
        const it = this.assistantFor(ev.runId);
        it.activity = [...it.activity, { kind: "tool", text: ev.tool }];
        return this.changed();
      }
      case "tool.outcome": {
        const it = this.assistantFor(ev.runId);
        it.activity = [...it.activity, { kind: ev.ok ? "tool-ok" : "tool-fail", text: ev.summary }];
        return this.changed();
      }
      case "ask_user":
        return this.patch({ questions: [...this.state.questions, { questionId: ev.questionId, runId: ev.runId, question: ev.question, options: ev.options }] });
      case "approval.request":
        return this.patch({ approvals: [...this.state.approvals, { approvalId: ev.approvalId, runId: ev.runId, tool: ev.tool, args: ev.args, category: ev.category }] });
      case "run.reverted":
        return this.patch({
          revertedRuns: [...this.state.revertedRuns, ev.runId],
          items: [
            ...this.state.items,
            { id: `sys${++this.itemSeq}`, role: "system" as const, text: `Reverted: ${ev.filesRestored.join(", ")}`, activity: [] },
          ],
        });
      case "run.finished": {
        const items = this.state.items.map((i) => (i.id === ev.runId ? { ...i, streaming: false } : i));
        const last = items[items.length - 1];
        const extra: ChatItem[] =
          ev.status !== "done" && (!last || last.id !== ev.runId)
            ? [...items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: ev.error ?? ev.status, activity: [] }]
            : ev.status !== "done" && ev.error && last
              ? items.map((i, idx) => (idx === items.length - 1 ? { ...i, streaming: false, text: i.text || `(${ev.error})` } : i))
              : items;
        return this.patch({ items: extra, busyRunId: undefined, lastRunId: ev.runId });
      }
      default:
        return;
    }
  }
}
