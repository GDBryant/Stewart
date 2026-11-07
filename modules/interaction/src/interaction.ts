import type { Clock, IdGen } from "@stewart/kernel";
import type { RunEvent } from "@stewart/protocol";

/** User's answer to an approval prompt; structurally identical to `GrantDecision` in `@stewart/permissions` (declared here because permissions sits above this layer). */
export type PromptGrant = "once" | "chat" | "always" | "deny";

export interface InteractionDeps {
  ids: IdGen;
  clock: Clock;
  bus: { emit(ev: RunEvent): void };
}

/**
 * The one owner of user-facing prompts: approval cards and `ask_user` cards.
 * Callers register prompts; the app layer resolves them from `chat.approve` /
 * `chat.answer`. Cards never resolve themselves — a timed-out or aborted prompt
 * is withdrawn (`question.withdrawn`) and resolves `undefined`.
 */
export class Interaction {
  private approvals = new Map<string, (d: PromptGrant) => void>();
  private answers = new Map<string, (a: string) => void>();

  constructor(private deps: InteractionDeps) {}

  /** Resolve a pending approval card; false when unknown or already resolved. */
  resolveApproval(approvalId: string, decision: PromptGrant): boolean {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return false;
    this.approvals.delete(approvalId);
    resolve(decision);
    return true;
  }

  /** Resolve a pending question card; false when unknown or already resolved. */
  resolveAnswer(questionId: string, answer: string): boolean {
    const resolve = this.answers.get(questionId);
    if (!resolve) return false;
    this.answers.delete(questionId);
    resolve(answer);
    return true;
  }

  /** Emit an `approval.request` card; resolves with the user's grant decision. */
  approval(runId: string, tool: string, args: unknown, category: string): Promise<PromptGrant> {
    const approvalId = this.deps.ids.next("appr");
    return new Promise<PromptGrant>((resolve) => {
      this.approvals.set(approvalId, resolve);
      this.deps.bus.emit({ kind: "approval.request", runId, approvalId, tool, args, category });
    });
  }

  /** Emit an `ask_user` card; resolves with the answer text. */
  ask(runId: string, question: string, options?: string[], roleId?: string): Promise<string> {
    const questionId = this.deps.ids.next("q");
    return new Promise<string>((resolve) => {
      this.answers.set(questionId, resolve);
      this.deps.bus.emit({ kind: "ask_user", runId, questionId, question, options, roleId });
    });
  }

  /** ask with a timeout and abort escape; resolves undefined and withdraws the card. */
  askTimed(runId: string, question: string, options: string[] | undefined, timeoutMs: number, signal: AbortSignal, roleId?: string): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const questionId = this.deps.ids.next("q");
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const settle = (v: string | undefined) => {
        if (settled) return;
        settled = true;
        this.answers.delete(questionId);
        timer?.cancel();
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const withdraw = () => {
        if (settled) return;
        this.deps.bus.emit({ kind: "question.withdrawn", runId, questionId, roleId });
        settle(undefined);
      };
      const onAbort = () => withdraw();
      const timer = timeoutMs > 0 ? this.deps.clock.setTimeout(withdraw, timeoutMs) : undefined;
      this.answers.set(questionId, (a) => settle(a));
      signal.addEventListener("abort", onAbort, { once: true });
      this.deps.bus.emit({ kind: "ask_user", runId, questionId, question, options, roleId });
    });
  }
}
