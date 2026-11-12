import type { ChatMessage, Clock, IdempotencyHooks, ToolCall } from "@stewart/kernel";
import type { LoopLimits } from "@stewart/budget";
import type { ApprovalDecision, ApprovalGate, ToolPreview } from "@stewart/permissions";
import type { LoopListener } from "./loopTypes.js";
import { NOT_ANSWERED_CANCELLED, outcomeMessage, ToolRegistry, type Tool, type ToolOutcome } from "@stewart/tools";

function rejected(): ApprovalDecision {
  return { kind: "rejected", reason: "denied" };
}

/** Shared per-run plumbing: who listens, which call is in flight, and the run's abort signal. */
export interface RunPlumbing {
  listener: LoopListener;
  inFlight: { id: string | null; awaitsUser: boolean };
  signal: AbortSignal;
}

/** Plumbing plus the call ids already seen in this executeCalls pass (duplicate-id guard). */
export interface CallContext extends RunPlumbing {
  seen: Set<string>;
}

/** What invokeTool needs beyond the call itself: the resolved tool, its approval preview, and the idempotency key. */
interface Invocation {
  tool: Tool;
  preview: ToolPreview | null;
  key: string | undefined;
}

/** Everything a CallExecutor needs from its owning ToolLoop. */
export interface CallExecutorDeps {
  registry: ToolRegistry;
  approval: ApprovalGate;
  limits: LoopLimits;
  clock: Clock | undefined;
  terminalTools: Set<string>;
  idempotency: IdempotencyHooks | undefined;
}

/** Resolve → gate → invoke → shape pipeline for one model-issued tool call, plus batching. */
export class CallExecutor {
  private readonly registry: ToolRegistry;
  private readonly approval: ApprovalGate;
  private readonly limits: LoopLimits;
  private readonly clock: Clock | undefined;
  private readonly terminalTools: Set<string>;
  private readonly idempotency: IdempotencyHooks | undefined;

  constructor(deps: CallExecutorDeps) {
    this.registry = deps.registry;
    this.approval = deps.approval;
    this.limits = deps.limits;
    this.clock = deps.clock;
    this.terminalTools = deps.terminalTools;
    this.idempotency = deps.idempotency;
  }

  /** Executes calls in parallel-capable batches; `terminal` means a terminal tool ended the turn. */
  async executeCalls(
    calls: ToolCall[],
    produced: ChatMessage[],
    run: RunPlumbing,
    executed: number,
  ): Promise<{ executed: number; terminal: boolean }> {
    const ctx: CallContext = { ...run, seen: new Set<string>() };
    let i = 0;
    while (i < calls.length) {
      const batch = this.parallelBatch(calls, i, run.listener);
      const seq = executed;
      executed += batch.length;
      const outcomes =
        batch.length === 1
          ? [await this.executeCall(batch[0], ctx, seq)]
          : await Promise.all(batch.map((c, k) => this.executeCall(c, ctx, seq + k)));
      for (let k = 0; k < batch.length; k++) {
        const outcome = outcomes[k];
        produced.push({ role: "tool", toolCallId: batch[k].id, content: outcomeMessage(outcome) });
        if (outcome.kind === "success" && outcome.images?.length) {
          produced.push({ role: "user", content: `[image from ${batch[k].name}]`, images: outcome.images });
        }
      }
      if (this.finishTerminalBatch(batch, outcomes, calls.slice(i + batch.length), produced)) return { executed, terminal: true };
      i += batch.length;
    }
    return { executed, terminal: false };
  }

  private parallelBatch(calls: ToolCall[], i: number, listener: LoopListener): ToolCall[] {
    const call = calls[i];
    listener.onToolRequested?.(call);
    const batch = [call];
    if (!this.registry.find(call.name)?.parallel) return batch;
    while (i + batch.length < calls.length && this.registry.find(calls[i + batch.length].name)?.parallel) {
      const next = calls[i + batch.length];
      listener.onToolRequested?.(next);
      batch.push(next);
    }
    return batch;
  }

  /** `rest` is every call after this batch; once a terminal tool succeeds, they are all marked not executed. */
  private finishTerminalBatch(batch: ToolCall[], outcomes: ToolOutcome[], rest: ToolCall[], produced: ChatMessage[]): boolean {
    const terminal = batch.findIndex((c, k) => this.terminalTools.has(c.name) && outcomes[k].kind === "success");
    if (terminal < 0) return false;
    for (const next of rest) {
      produced.push({ role: "tool", toolCallId: next.id, content: `Not executed: '${batch[terminal].name}' ended the turn` });
    }
    return true;
  }

  private finishOutcome(call: ToolCall, outcome: ToolOutcome, listener: LoopListener): ToolOutcome {
    listener.onToolOutcome?.(call, outcome);
    return outcome;
  }

  private async executeCall(call: ToolCall, ctx: CallContext, index: number): Promise<ToolOutcome> {
    const { listener, signal } = ctx;
    if (ctx.seen.has(call.id)) return this.finishOutcome(call, { kind: "invalid", reason: "duplicate tool call id" }, listener);
    ctx.seen.add(call.id);
    const resolved = this.resolveTool(call);
    if ("outcome" in resolved) return this.finishOutcome(call, resolved.outcome, listener);
    const key = this.idempotency?.key(call, index);
    const replayed = key ? this.idempotency!.lookup(key) : undefined;
    if (replayed !== undefined) return this.finishOutcome(call, { kind: "success", content: replayed }, listener);
    const gated = await this.gateCall(call, resolved.tool, signal);
    if ("outcome" in gated) return this.finishOutcome(call, gated.outcome, listener);
    return this.invokeTool(call, { tool: resolved.tool, preview: gated.preview, key }, ctx);
  }

  private resolveTool(call: ToolCall): { tool: Tool } | { outcome: ToolOutcome } {
    const tool = this.registry.find(call.name);
    if (!tool) return { outcome: { kind: "invalid", reason: `unknown tool '${call.name}'` } };
    const invalid = this.registry.validate(call);
    if (invalid != null) return { outcome: { kind: "invalid", reason: invalid } };
    return { tool };
  }

  private async gateCall(
    call: ToolCall,
    tool: Tool,
    signal: AbortSignal,
  ): Promise<{ preview: ToolPreview | null } | { outcome: ToolOutcome }> {
    if (!tool.requiresApproval) return { preview: null };
    let preview: ToolPreview | null;
    try {
      preview = (await tool.preview?.(call.arguments)) ?? null;
    } catch (e) {
      if (signal.aborted) throw e;
      return { outcome: { kind: "failure", message: e instanceof Error ? e.message : "preview failed" } };
    }
    const decision = signal.aborted
      ? rejected()
      : await Promise.race([
          this.approval(call, preview),
          new Promise<never>((_r, rej) => {
            if (signal.aborted) rej(new Error("cancelled"));
            else signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
          }),
        ]);
    if (decision.kind === "rejected") {
      return { outcome: { kind: "rejected", reason: decision.reason } };
    }
    return { preview };
  }

  private async invokeTool(call: ToolCall, job: Invocation, ctx: CallContext): Promise<ToolOutcome> {
    const { inFlight, listener, signal } = ctx;
    inFlight.id = call.id;
    inFlight.awaitsUser = job.tool.awaitsUser === true;
    const child = new AbortController();
    const onAbort = () => child.abort();
    if (signal.aborted) child.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    let timer: { cancel(): void } | undefined;
    try {
      const out = await this.execWithTimeout(call, job, child, (t) => {
        timer = t;
      });
      return await this.shapeResult(call, out, job.key, listener);
    } catch (e) {
      return this.invokeCatch(e, call, ctx, child);
    } finally {
      timer?.cancel();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async execWithTimeout(
    call: ToolCall,
    job: Invocation,
    child: AbortController,
    armTimer: (t: { cancel(): void }) => void,
  ): Promise<string | { text: string; images?: string[] }> {
    const exec = job.tool.execute(call.arguments, job.preview, child.signal);
    if (job.tool.awaitsUser || job.tool.noTimeout) return exec;
    return Promise.race([
      exec,
      new Promise<never>((_res, rej) => {
        armTimer(
          (this.clock ?? { setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } })
            .setTimeout(() => { child.abort(); rej(new Error("__tool_timeout__")); }, this.limits.toolTimeoutMs),
        );
      }),
    ]);
  }

  private invokeCatch(e: unknown, call: ToolCall, ctx: CallContext, child: AbortController): ToolOutcome {
    const { inFlight, listener, signal } = ctx;
    if (e instanceof Error && e.name === "LeaseCycleError") throw e;
    if (e instanceof Error && e.message === "__tool_timeout__") {
      return this.finishOutcome(call, { kind: "uncertain", reason: "timed out; side effects unknown" }, listener);
    }
    if (signal.aborted || child.signal.aborted) {
      const outcome: ToolOutcome = inFlight.awaitsUser
        ? { kind: "failure", message: NOT_ANSWERED_CANCELLED }
        : { kind: "uncertain", reason: "cancelled; side effects unknown" };
      listener.onToolOutcome?.(call, outcome);
      throw new Error("cancelled");
    }
    return this.finishOutcome(call, { kind: "failure", message: e instanceof Error ? e.message : "tool failed" }, listener);
  }

  private async shapeResult(
    call: ToolCall,
    out: string | { text: string; images?: string[] },
    key: string | undefined,
    listener: LoopListener,
  ): Promise<ToolOutcome> {
    const raw = typeof out === "string" ? out : out.text;
    const cap = this.limits.maxToolOutputChars;
    const s = raw.length > cap
      ? `${raw.slice(0, Math.ceil(cap * 0.7))}\n[output truncated: ${raw.length - cap} chars omitted]\n${raw.slice(-Math.floor(cap * 0.3))}`
      : raw;
    if (key) await this.idempotency!.record(key, s);
    return this.finishOutcome(
      call,
      { kind: "success", content: s, images: typeof out === "string" ? undefined : out.images },
      listener,
    );
  }
}
