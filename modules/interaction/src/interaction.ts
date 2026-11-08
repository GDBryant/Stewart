import type { Clock, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

/** User's answer to an approval prompt; structurally identical to `GrantDecision` in `@stewart/permissions` (declared here because permissions sits above this layer). */
export type PromptGrant = "once" | "chat" | "always" | "deny";

export type PromptTopic = "ask_user" | "continue" | "plan_gate" | "cost_limit" | "fallback" | "resume";

export interface PromptTag {
  runId: string;
  roleId?: string;
  taskId?: string;
}

export type Prompt<A> =
  | { kind: "approval"; tool: string; args: unknown; category: string; decode: (g: PromptGrant) => A }
  | { kind: "question"; topic: PromptTopic; question: string; options?: string[]; timeoutMs?: number; decode: (answer: string) => A };

export type PromptOutcome<A> = { kind: "answered"; value: A } | { kind: "withdrawn"; reason: "timeout" | "cancel" };

export interface PromptView {
  id: string;
  kind: "approval" | "question";
  topic?: PromptTopic;
  runId: string;
  roleId?: string;
  taskId?: string;
  shown: boolean;
  text: string;
}

export interface InteractionDeps {
  ids: IdGen;
  clock: Clock;
  bus: { emit(ev: RunEvent): void };
}

export function approvalPrompt(tool: string, args: unknown, category: string): Prompt<PromptGrant> {
  return { kind: "approval", tool, args, category, decode: (g) => g };
}

export function questionPrompt(topic: PromptTopic, question: string, options?: string[], timeoutMs?: number): Prompt<string> {
  return { kind: "question", topic, question, options, timeoutMs, decode: (a) => a };
}

interface Entry {
  id: string;
  prompt: Prompt<unknown>;
  tag: PromptTag;
  resolve: (o: PromptOutcome<unknown>) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: { cancel(): void };
}

/**
 * The one owner of user-facing prompts: a FIFO queue of approval cards and
 * question cards. One prompt is shown at a time; the rest queue silently until
 * shown. Cards never resolve themselves — the app layer resolves them from
 * `chat.approve` / `chat.answer`; timeouts and aborts withdraw them.
 */
export class Interaction {
  private queue: Entry[] = [];
  private shown: Entry | null = null;

  constructor(private deps: InteractionDeps) {}

  /** Enqueue a prompt; resolves `answered` with the decoded reply or `withdrawn`. Never rejects. */
  ask<A>(prompt: Prompt<A>, tag: PromptTag, signal?: AbortSignal): Promise<PromptOutcome<A>> {
    if (signal?.aborted) return Promise.resolve({ kind: "withdrawn", reason: "cancel" });
    const id = this.deps.ids.next(prompt.kind === "approval" ? "appr" : "q");
    const entry: Entry = { id, prompt: prompt as Prompt<unknown>, tag, resolve: undefined as never, signal };
    const p = new Promise<PromptOutcome<A>>((resolve) => {
      entry.resolve = resolve as Entry["resolve"];
    });
    if (signal) {
      entry.onAbort = () => {
        if (this.shown === entry) this.settleShown({ kind: "withdrawn", reason: "cancel" });
        else this.withdraw(entry.id, "cancel");
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    this.queue.push(entry);
    if (!this.shown) this.advance();
    return p;
  }

  /** Withdraw a pending or shown prompt; false when unknown. */
  withdraw(promptId: string, reason: "timeout" | "cancel"): boolean {
    if (this.shown?.id === promptId) {
      this.settleShown({ kind: "withdrawn", reason });
      return true;
    }
    const i = this.queue.findIndex((e) => e.id === promptId);
    if (i < 0) return false;
    const [e] = this.queue.splice(i, 1);
    e.onAbort && e.signal?.removeEventListener("abort", e.onAbort);
    e.resolve({ kind: "withdrawn", reason });
    return true;
  }

  /** Resolve the shown approval card; false when unknown, queued, or already resolved. */
  resolveApproval(approvalId: string, decision: PromptGrant): boolean {
    const e = this.shown;
    if (!e || e.id !== approvalId || e.prompt.kind !== "approval") return false;
    this.settleShown({ kind: "answered", value: (e.prompt as Prompt<unknown> & { kind: "approval" }).decode(decision) });
    return true;
  }

  /** Resolve the shown question card; false when unknown, queued, or already resolved. */
  resolveAnswer(questionId: string, answer: string): boolean {
    const e = this.shown;
    if (!e || e.id !== questionId || e.prompt.kind !== "question") return false;
    this.settleShown({ kind: "answered", value: e.prompt.decode(answer) });
    return true;
  }

  /** Shown prompt first, then queued prompts in FIFO order. */
  pending(): PromptView[] {
    const view = (e: Entry, shown: boolean): PromptView => ({
      id: e.id,
      kind: e.prompt.kind,
      topic: e.prompt.kind === "question" ? e.prompt.topic : undefined,
      runId: e.tag.runId,
      roleId: e.tag.roleId,
      taskId: e.tag.taskId,
      shown,
      text: e.prompt.kind === "approval" ? `Approve ${e.prompt.tool}?` : e.prompt.question,
    });
    return [...(this.shown ? [view(this.shown, true)] : []), ...this.queue.map((e) => view(e, false))];
  }

  private show(e: Entry): void {
    this.shown = e;
    if (e.prompt.kind === "approval") {
      this.deps.bus.emit({ kind: "approval.request", runId: e.tag.runId, approvalId: e.id, tool: e.prompt.tool, args: e.prompt.args, category: e.prompt.category });
    } else {
      if (e.prompt.timeoutMs && e.prompt.timeoutMs > 0) {
        e.timer = this.deps.clock.setTimeout(() => this.withdraw(e.id, "timeout"), e.prompt.timeoutMs);
      }
      this.deps.bus.emit({ kind: "ask_user", runId: e.tag.runId, questionId: e.id, question: e.prompt.question, options: e.prompt.options, roleId: e.tag.roleId });
    }
  }

  private settleShown(outcome: PromptOutcome<unknown>): void {
    const e = this.shown;
    if (!e) return;
    this.shown = null;
    e.timer?.cancel();
    if (e.onAbort) e.signal?.removeEventListener("abort", e.onAbort);
    if (e.prompt.kind === "question" && outcome.kind === "withdrawn") {
      this.deps.bus.emit({ kind: "question.withdrawn", runId: e.tag.runId, questionId: e.id, roleId: e.tag.roleId });
    }
    e.resolve(outcome);
    this.advance();
  }

  private advance(): void {
    if (this.shown) return;
    const next = this.queue.shift();
    if (next) this.show(next);
  }
}
