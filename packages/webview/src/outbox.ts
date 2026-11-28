import type { Outbound } from "./bridge.js";
import type { OutboxItem, State } from "./stateTypes.js";

export const OUTBOX_CAP = 20;
const SEND_TIMEOUT_MS = 3000;

export interface OutboxDeps {
  getState(): State;
  patch(p: Partial<State>): void;
  post(m: Outbound): void;
  nextItemSeq(): number;
  appendUser(text: string, images?: string[]): void;
}

export class Outbox {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly d: OutboxDeps) {}

  private get items(): OutboxItem[] {
    return this.d.getState().outbox;
  }

  private set(items: OutboxItem[]): void {
    this.d.patch({ outbox: items });
  }

  enqueue(text: string, images: string[]): void {
    if (this.items.length >= OUTBOX_CAP) {
      this.d.patch({ attachError: "Too many queued follow-ups." });
      return;
    }
    const item: OutboxItem = {
      id: `q${this.d.nextItemSeq()}`,
      sessionId: this.d.getState().sessionId,
      text,
      ...(images.length ? { images } : {}),
      createdAt: Date.now(),
      status: "pending",
    };
    this.d.patch({ outbox: [...this.items, item], pendingImages: [], draft: "", attachError: undefined });
    this.pump();
  }

  pump(): void {
    const s = this.d.getState();
    const head = s.outbox[0];
    if (!head || head.status !== "pending" || s.busyRunId || s.outboxSending) return;
    this.set([{ ...head, status: "sending" }, ...s.outbox.slice(1)]);
    this.timer = setTimeout(() => this.timeout(head.id), SEND_TIMEOUT_MS);
    this.d.post({
      type: "chat.send",
      text: head.text,
      ...(head.images ? { images: head.images } : {}),
      ...(head.sessionId ? { sessionId: head.sessionId } : {}),
    });
  }

  result(m: { ok?: boolean; runId?: string; sessionId?: string; error?: string }): void {
    const head = this.items[0];
    if (!head || head.status !== "sending") return;
    clearTimeout(this.timer);
    if (!m.ok) return this.fail(head, m.error ?? "send failed");
    this.d.appendUser(head.text, head.images);
    this.d.patch({ outbox: this.items.slice(1), outboxSending: m.runId ? true : undefined });
    if (!m.runId) this.pump();
  }

  runStarted(): void {
    if (this.d.getState().outboxSending) this.d.patch({ outboxSending: undefined });
  }

  edit(id: string): void {
    const s = this.d.getState();
    if (s.draft) return;
    const it = s.outbox.find((x) => x.id === id);
    if (!it || it.status === "sending") return;
    this.d.patch({ outbox: s.outbox.filter((x) => x.id !== id), draft: it.text, pendingImages: it.images ?? [] });
    this.pump();
  }

  remove(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.status === "sending") return;
    this.set(this.items.filter((x) => x.id !== id));
    this.pump();
  }

  retry(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.status !== "failed") return;
    this.set(this.items.map((x) => (x.id === id ? { ...x, status: "pending" as const, error: undefined } : x)));
    this.pump();
  }

  clear(): void {
    clearTimeout(this.timer);
    this.d.patch({ outbox: [], outboxSending: undefined });
  }

  private timeout(id: string): void {
    const head = this.items[0];
    if (!head || head.id !== id || head.status !== "sending") return;
    this.fail(head, "No confirmation; retry can duplicate if the send still lands.");
  }

  private fail(head: OutboxItem, error: string): void {
    this.set([{ ...head, status: "failed", error }, ...this.items.slice(1)]);
  }
}
