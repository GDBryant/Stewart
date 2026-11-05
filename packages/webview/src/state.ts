import type { RunEvent } from "@stewart/protocol";
import type { Bridge, ConfigReply, Inbound } from "./bridge.js";

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  /** Collapsed activity rows: tool calls, tasks, approvals. */
  activity: { kind: string; text: string }[];
}

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

export interface State {
  items: ChatItem[];
  busyRunId?: string;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  config?: ConfigReply;
  channelTest: Record<string, { ok: boolean; models?: string[]; error?: string }>;
  view: "chat" | "settings";
}

type Listener = () => void;

/** Minimal observable store; one instance per webview. */
export class Store {
  state: State = { items: [], approvals: [], questions: [], channelTest: {}, view: "chat" };
  private listeners = new Set<Listener>();
  private itemSeq = 0;

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
    if (!text.trim() || this.state.busyRunId) return;
    this.patch({ items: [...this.state.items, { id: `u${++this.itemSeq}`, role: "user", text, activity: [] }] });
    this.bridge.post({ type: "chat.send", text });
  }
  cancel(): void {
    if (this.state.busyRunId) this.bridge.post({ type: "chat.cancel", runId: this.state.busyRunId });
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
    this.requestConfig();
  }
  testChannel(channelId: string): void {
    this.bridge.post({ type: "channel.test", channelId });
  }
  setSecret(ref: string, value: string): void {
    this.bridge.post({ type: "secret.set", ref, value });
  }
  deleteSecret(ref: string): void {
    this.bridge.post({ type: "secret.delete", ref });
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
  assignAgentToAll(agentId: string): void {
    this.bridge.post({ type: "roles.assignAgent", agentId });
    this.requestConfig();
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
    if (m.type === "config") return this.patch({ config: { files: m.files, summary: m.summary, errors: m.errors } });
    if (m.type === "channel.test.result")
      return this.patch({ channelTest: { ...this.state.channelTest, [m.channelId]: { ok: m.ok, models: m.models, error: m.error } } });
    if (m.type === "error")
      return this.patch({
        items: [...this.state.items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: `error: ${m.message}`, activity: [] }],
      });
    if (m.type !== "event") return;
    const ev = m.ev;
    switch (ev.kind) {
      case "run.started":
        return this.patch({ busyRunId: ev.runId });
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
      case "run.finished": {
        const items = this.state.items.map((i) => (i.id === ev.runId ? { ...i, streaming: false } : i));
        const last = items[items.length - 1];
        const extra: ChatItem[] =
          ev.status !== "done" && (!last || last.id !== ev.runId)
            ? [...items, { id: `sys${++this.itemSeq}`, role: "system" as const, text: ev.error ?? ev.status, activity: [] }]
            : ev.status !== "done" && ev.error && last
              ? items.map((i, idx) => (idx === items.length - 1 ? { ...i, streaming: false, text: i.text || `(${ev.error})` } : i))
              : items;
        return this.patch({ items: extra, busyRunId: undefined });
      }
      default:
        return;
    }
  }
}
