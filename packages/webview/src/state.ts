import type { Bridge } from "./bridge.js";
import { StoreHandlers } from "./stateHandlers.js";
import { MAX_IMAGE_BYTES, MAX_PENDING_IMAGES } from "./stateTypes.js";
import type { ChatItem, State, TaskRow } from "./stateTypes.js";

export { MAX_IMAGE_BYTES, MAX_PENDING_IMAGES } from "./stateTypes.js";
export type {
  ChatItem,
  CostState,
  PendingApproval,
  PendingQuestion,
  State,
  TaskRow,
} from "./stateTypes.js";

type Listener = () => void;

/** Minimal observable store; one instance per webview. */
export class Store {
  state: State = {
    items: [],
    tasks: [],
    approvals: [],
    questions: [],
    channelTest: {},
    probeResults: {},
    qualResults: {},
    view: "chat",
    sessions: [],
    historyOpen: false,
    pendingImages: [],
  };
  private listeners = new Set<Listener>();
  private itemSeq = 0;
  private insertSeq = 0;
  private readonly handlers = new StoreHandlers({
    getState: () => this.state,
    patch: (p) => this.patch(p),
    mutateAssistant: (runId, fn) => this.mutateAssistant(runId, fn),
    addActivity: (runId, kind, text) => this.addActivity(runId, kind, text),
    patchTask: (taskId, update) => this.patchTask(taskId, update),
    requestConfig: () => this.requestConfig(),
    post: (m) => this.bridge.post(m),
    nextItemSeq: () => ++this.itemSeq,
    nextInsertSeq: () => ++this.insertSeq,
  });

  constructor(private bridge: Bridge) {
    bridge.onMessage((m) => this.handlers.onInbound(m));
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
  cancel(): void {
    if (this.state.busyRunId) this.bridge.post({ type: "chat.cancel", runId: this.state.busyRunId });
  }
  resumePlan(): void {
    if (this.state.sessionId) this.bridge.post({ type: "chat.resume", sessionId: this.state.sessionId });
  }
  revert(checkpoint?: string): void {
    if (this.state.sessionId) this.bridge.post({ type: "chat.revert", sessionId: this.state.sessionId, checkpoint });
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
  qualifyModel(channel: string, model: string): void {
    this.bridge.post({ type: "setup.qualify", channel, model });
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
  /** Add a channel through the setup session (so cancel rolls it back and undo restores it); the key goes to the secret store. */
  addSetupChannel(channel: { id: string; type: string; baseUrl?: string; enabled?: boolean }, apiKey?: string): void {
    this.patch({ setupChannelError: undefined });
    this.bridge.post({ type: "setup.session.addChannel", channel, ...(apiKey ? { apiKey } : {}) });
  }
  removeSetupChannel(id: string): void {
    this.patch({ setupChannelError: undefined });
    this.bridge.post({ type: "setup.session.removeChannel", id });
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
}
