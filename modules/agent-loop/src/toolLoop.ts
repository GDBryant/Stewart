import type { ChatEvent, ManagedChannel } from "@stewart/channels";
import { DEFAULT_LIMITS, type LoopLimits } from "@stewart/budget";
import type { ToolsMode } from "@stewart/models";
import type { ChatMessage, IdempotencyHooks, ToolCall } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import type { Clock } from "@stewart/kernel";
import { parseToolCalls, buildToolsBlock, ToolCallStreamFilter, type ParseError, type SchemaMap } from "@stewart/toolcall-format";
import { compactIfOver, measureMessages, pruneStale, summarizeMiddle } from "@stewart/compaction";
import { RunCancelledError, type ApprovalDecision, type ApprovalGate, type LoopListener, type LoopResult } from "./loopTypes.js";
import { NOT_ANSWERED_CANCELLED, outcomeMessage, ToolRegistry, type Tool, type ToolOutcome } from "@stewart/tools";

interface TurnState {
  text: string;
  open: boolean;
}

type DeltaHandlers = {
  [K in ChatEvent["kind"]]: (ev: Extract<ChatEvent, { kind: K }>) => void;
};

interface StreamOutcome {
  calls: ToolCall[];
  sawDone: boolean;
  sawTruncated: boolean;
  postDone: boolean;
  failed: Error | null;
  usage: { in: number; out: number } | undefined;
  costUsd: number | undefined;
  /** Text the stream filter held back (unfinished call block). */
  held?: string;
}

function rejected(): ApprovalDecision {
  return { kind: "rejected", reason: "denied" };
}

export class ToolLoop {
  constructor(
    private channel: ManagedChannel,
    private registry: ToolRegistry,
    private approval: ApprovalGate,
    private limits: LoopLimits = DEFAULT_LIMITS,
    private clock?: Clock,
    private rolePrompt?: string,
    private terminalTools: Set<string> = new Set(),
    private toolsMode: ToolsMode = "shim",
    private idempotency?: IdempotencyHooks,
    /** Summarize stage (R3.3): turns the middle of the transcript into a note; absent = off. */
    private summarize?: (middle: ChatMessage[]) => Promise<string>,
  ) {}

  private get schemaMap(): SchemaMap {
    return Object.fromEntries(this.registry.tools.map((t) => [t.spec.name, t.spec.parameters]));
  }

  /** Built fresh per request: role prompt plus, in shim mode, the `<tools>` block. Never stored in history. */
  private systemPrompt(): string | undefined {
    const toolsBlock = this.toolsMode === "shim" ? buildToolsBlock(this.registry.specs) : null;
    const joined = [this.rolePrompt, toolsBlock].filter((s): s is string => !!s).join("\n\n");
    return joined === "" ? undefined : joined;
  }

  async run(model: string, history: ChatMessage[], listener: LoopListener, signal: AbortSignal): Promise<LoopResult> {
    const produced: ChatMessage[] = [];
    const base = history;
    const turn: TurnState = { text: "", open: false };
    const inFlight = { id: null as string | null, awaitsUser: false };
    let turns = 0;
    let truncRetries = 0;
    let executed = 0;
    try {
      while (true) {
        if (turns >= this.limits.maxModelTurns) return { kind: "turn_limit", messages: produced, base };
        if (await this.prepareTurn(base, produced, listener)) {
          return { kind: "failed", messages: produced, base, message: "context size limit exceeded", code: "context_limit" };
        }
        turns++;
        turn.text = "";
        turn.open = true;
        const s = await this.streamTurn(model, this.outbound(base, produced), listener, signal, turn);
        const decision = await this.handleStreamOutcome(s, truncRetries, listener);
        if (decision.kind === "retry") {
          truncRetries++;
          turns--;
          turn.open = false;
          continue;
        }
        if (decision.kind === "failed") return { kind: "failed", messages: produced, base, message: decision.message, code: decision.code };
        const handled = await this.finishTurn(s, turn, produced, listener, inFlight, signal, executed);
        executed = handled.executed;
        if (handled.completed) return { kind: "completed", messages: produced, base };
      }
    } catch (e) {
      this.closeOpenToolCalls(produced, inFlight);
      if (turn.open && turn.text.trim() !== "") produced.push({ role: "assistant", content: turn.text });
      if (signal.aborted) throw new RunCancelledError(base, produced, e);
      throw e;
    }
  }

  private async prepareTurn(base: ChatMessage[], produced: ChatMessage[], listener: LoopListener): Promise<boolean> {
    const before = measureMessages([...base, ...produced]);
    let pruned = 0;
    let summarized = false;
    if (this.limits.prune && before > this.limits.maxContextChars * (this.limits.pruneAt ?? 0.6)) pruned = pruneStale(produced);
    if (this.summarize && measureMessages([...base, ...produced]) > this.limits.maxContextChars * (this.limits.summarizeAt ?? 0.8)) {
      summarized = await summarizeMiddle(produced, this.summarize);
    }
    if (pruned > 0 || summarized) {
      listener.onCompacted?.(Math.ceil(before / 4), Math.ceil(measureMessages([...base, ...produced]) / 4), { pruned, summarized });
    }
    return compactIfOver(base, produced, this.limits.maxContextChars, listener);
  }

  private async handleStreamOutcome(
    s: StreamOutcome,
    truncRetries: number,
    listener: LoopListener,
  ): Promise<{ kind: "retry" } | { kind: "failed"; message: string; code?: string } | { kind: "parse" }> {
    if (s.sawDone) await listener.onUsage?.(s.usage, s.costUsd);
    if (s.postDone) {
      return { kind: "failed", message: "provider emitted events after completion", code: "protocol_error" };
    }
    const isStallTruncated = s.failed !== null && (/TRUNCATED|stream stalled/i.test(s.failed.message) || (s.failed as { code?: string }).code === "truncated");
    if (s.sawTruncated || isStallTruncated) {
      if (truncRetries < this.limits.maxTruncationRetries) {
        return { kind: "retry" };
      }
      return { kind: "failed", message: s.failed?.message ?? "response truncated", code: "truncated" };
    }
    if (s.failed) return { kind: "failed", message: s.failed.message, code: (s.failed as { code?: string }).code };
    if (!s.sawDone) {
      return { kind: "failed", message: "stream ended before completion", code: "incomplete_stream" };
    }
    return { kind: "parse" };
  }

  private async finishTurn(
    s: StreamOutcome,
    turn: TurnState,
    produced: ChatMessage[],
    listener: LoopListener,
    inFlight: { id: string | null; awaitsUser: boolean },
    signal: AbortSignal,
    executed: number,
  ): Promise<{ completed: boolean; executed: number }> {
    turn.open = false;
    const parsed = this.parseCalls(turn.text, s.calls, listener);
    turn.text = parsed.text;
    // Held-back call-like text that was not a call: show it after all.
    if (s.held && parsed.calls.length === 0 && parsed.errors.length === 0) listener.onText?.(s.held);
    produced.push({ role: "assistant", content: turn.text, toolCalls: parsed.calls.length > 0 ? parsed.calls : undefined });
    if (parsed.calls.length === 0) {
      if (parsed.errors.length === 0) return { completed: true, executed };
      // Call-like text that failed: tell the model and retry, bounded by maxModelTurns.
      produced.push({ role: "user", content: this.parseFeedback(parsed.errors) });
      return { completed: false, executed };
    }
    const batch = await this.executeCalls(parsed.calls, produced, listener, inFlight, signal, executed);
    if (batch.terminal) return { completed: true, executed: batch.executed };
    if (parsed.errors.length > 0) produced.push({ role: "user", content: this.parseFeedback(parsed.errors) });
    return { completed: false, executed: batch.executed };
  }

  private outbound(base: ChatMessage[], produced: ChatMessage[]): ChatMessage[] {
    const system = this.systemPrompt();
    return system ? [{ role: "system", content: system }, ...base, ...produced] : [...base, ...produced];
  }

  /** Streams one model call; accumulates text into `turn.text` so a cancel can recover the partial reply. */
  private async streamTurn(
    model: string,
    outbound: ChatMessage[],
    listener: LoopListener,
    signal: AbortSignal,
    turn: TurnState,
  ): Promise<StreamOutcome> {
    const s: StreamOutcome = {
      calls: [],
      sawDone: false,
      sawTruncated: false,
      postDone: false,
      failed: null,
      usage: undefined,
      costUsd: undefined,
    };
    const filter = this.toolsMode === "shim" ? new ToolCallStreamFilter() : undefined;
    const call = this.armCallTimeout(signal, this.limits.modelCallTimeoutMs ?? 0);
    const onDelta = this.streamDeltas(s, turn, listener, filter);
    try {
      for await (const ev of this.channel.chat({
        model,
        messages: outbound,
        tools: this.toolsMode === "native" ? this.registry.specs.map((s) => ({ name: s.name, description: s.description, schema: s.parameters })) : undefined,
        signal: call.signal,
      })) {
        onDelta(ev);
      }
      s.held = filter?.flush() ?? "";
    } catch (e) {
      if (signal.aborted) throw e;
      if (call.timedOut()) {
        const err = new Error(`model call timed out after ${call.timeoutMs}ms`);
        (err as { code?: string }).code = "call_timeout";
        s.failed = err;
      } else {
        s.failed = e instanceof Error ? e : new Error(String(e));
      }
    } finally {
      call.done();
    }
    return s;
  }

  private armCallTimeout(
    signal: AbortSignal,
    timeoutMs: number,
  ): { signal: AbortSignal; timeoutMs: number; timedOut(): boolean; done(): void } {
    if (timeoutMs <= 0) return { signal, timeoutMs, timedOut: () => false, done: () => {} };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return {
      signal: ctl.signal,
      timeoutMs,
      timedOut: () => ctl.signal.aborted,
      done: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      },
    };
  }

  private streamDeltas(
    s: StreamOutcome,
    turn: TurnState,
    listener: LoopListener,
    filter: ToolCallStreamFilter | undefined,
  ): (ev: ChatEvent) => void {
    const handlers: DeltaHandlers = {
      text: (ev) => {
        turn.text += ev.text;
        const shown = filter ? filter.push(ev.text) : ev.text;
        if (shown) listener.onText?.(shown);
      },
      reasoning: (ev) => listener.onReasoning?.(ev.text),
      tool_calls: (ev) => {
        s.calls = ev.calls;
      },
      done: (ev) => {
        s.sawDone = true;
        s.sawTruncated = ev.truncated === true;
        s.usage = ev.usage;
        s.costUsd = ev.costUsd;
      },
    };
    return (ev) => {
      if (s.sawDone) s.postDone = true;
      else (handlers[ev.kind] as (e: ChatEvent) => void)(ev);
    };
  }

  /** Shim mode always parses text. Native mode parses only when the provider sent no native calls. */
  private parseCalls(text: string, calls: ToolCall[], listener: LoopListener): { text: string; calls: ToolCall[]; errors: ParseError[] } {
    if (this.toolsMode !== "shim" && calls.length > 0) return { text, calls, errors: [] };
    const parsed = parseToolCalls(text, this.schemaMap);
    if (this.toolsMode === "shim" && parsed.reasoning) listener.onReasoning?.(parsed.reasoning);
    if (parsed.calls.length > 0) {
      // only strip the call blocks when calls parsed; leftover text is kept
      if (parsed.clean !== text) text = parsed.clean || text;
      calls = parsed.calls;
    }
    return { text, calls, errors: parsed.errors };
  }

  /** Executes calls in parallel-capable batches; `terminal` means a terminal tool ended the turn. */
  private async executeCalls(
    calls: ToolCall[],
    produced: ChatMessage[],
    listener: LoopListener,
    inFlight: { id: string | null; awaitsUser: boolean },
    signal: AbortSignal,
    executed: number,
  ): Promise<{ executed: number; terminal: boolean }> {
    const seen = new Set<string>();
    let i = 0;
    while (i < calls.length) {
      const call = calls[i];
      listener.onToolRequested?.(call);
      const batch = [call];
      if (this.registry.find(call.name)?.parallel) {
        while (i + batch.length < calls.length && this.registry.find(calls[i + batch.length].name)?.parallel) {
          const next = calls[i + batch.length];
          listener.onToolRequested?.(next);
          batch.push(next);
        }
      }
      const seq = executed;
      executed += batch.length;
      const outcomes =
        batch.length === 1
          ? [await this.executeCall(call, seen, listener, inFlight, signal, seq)]
          : await Promise.all(batch.map((c, k) => this.executeCall(c, seen, listener, inFlight, signal, seq + k)));
      for (let k = 0; k < batch.length; k++) {
        const outcome = outcomes[k];
        produced.push({ role: "tool", toolCallId: batch[k].id, content: outcomeMessage(outcome) });
        if (outcome.kind === "success" && outcome.images?.length) {
          produced.push({ role: "user", content: `[image from ${batch[k].name}]`, images: outcome.images });
        }
      }
      const terminal = batch.findIndex((c, k) => this.terminalTools.has(c.name) && outcomes[k].kind === "success");
      if (terminal >= 0) {
        for (const rest of calls.slice(i + batch.length)) {
          produced.push({ role: "tool", toolCallId: rest.id, content: `Not executed: '${batch[terminal].name}' ended the turn` });
        }
        return { executed, terminal: true };
      }
      i += batch.length;
    }
    return { executed, terminal: false };
  }

  private parseFeedback(errors: ParseError[]): string {
    const known = this.registry.specs.map((s) => s.name).join(", ") || "none";
    return `Tool call not executed: ${errors.map((e) => e.message).join("; ")}. Known tools: ${known}. Emit a valid call (<tool_call>{"name": "NAME", "arguments": {...}}</tool_call>) or answer without one.`;
  }

  private closeOpenToolCalls(produced: ChatMessage[], inFlight: { id: string | null; awaitsUser: boolean }): void {
    let idx = -1;
    for (let i = produced.length - 1; i >= 0; i--) {
      const m = produced[i];
      if (m.role === "assistant" && "toolCalls" in m && m.toolCalls && m.toolCalls.length > 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const calls = (produced[idx] as { toolCalls: ToolCall[] }).toolCalls;
    const answered = new Set(
      produced.slice(idx + 1).filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId),
    );
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      let content: string;
      if (call.id === inFlight.id) {
        content = inFlight.awaitsUser
          ? NOT_ANSWERED_CANCELLED
          : outcomeMessage({ kind: "uncertain", reason: "cancelled; side effects unknown" });
      } else {
        content = "Not executed: cancelled by user";
      }
      produced.push({ role: "tool", toolCallId: call.id, content });
    }
  }

  private finishOutcome(call: ToolCall, outcome: ToolOutcome, listener: LoopListener): ToolOutcome {
    listener.onToolOutcome?.(call, outcome);
    return outcome;
  }

  private async executeCall(
    call: ToolCall,
    seen: Set<string>,
    listener: LoopListener,
    inFlight: { id: string | null; awaitsUser: boolean },
    signal: AbortSignal,
    index: number,
  ): Promise<ToolOutcome> {
    if (seen.has(call.id)) return this.finishOutcome(call, { kind: "invalid", reason: "duplicate tool call id" }, listener);
    seen.add(call.id);
    const resolved = this.resolveTool(call);
    if ("outcome" in resolved) return this.finishOutcome(call, resolved.outcome, listener);
    const key = this.idempotency?.key(call, index);
    const replayed = key ? this.idempotency!.lookup(key) : undefined;
    if (replayed !== undefined) return this.finishOutcome(call, { kind: "success", content: replayed }, listener);
    const gated = await this.gateCall(call, resolved.tool, signal);
    if ("outcome" in gated) return this.finishOutcome(call, gated.outcome, listener);
    return this.invokeTool(call, resolved.tool, gated.preview, key, listener, inFlight, signal);
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

  private async invokeTool(
    call: ToolCall,
    tool: Tool,
    preview: ToolPreview | null,
    key: string | undefined,
    listener: LoopListener,
    inFlight: { id: string | null; awaitsUser: boolean },
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    inFlight.id = call.id;
    inFlight.awaitsUser = tool.awaitsUser === true;
    const child = new AbortController();
    const onAbort = () => child.abort();
    if (signal.aborted) child.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    let timer: { cancel(): void } | undefined;
    try {
      const exec = tool.execute(call.arguments, preview, child.signal);
      const out = tool.awaitsUser
        ? await exec
        : await Promise.race([
            exec,
            new Promise<never>((_res, rej) => {
              timer = (this.clock ?? { setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } })
                .setTimeout(() => { child.abort(); rej(new Error("__tool_timeout__")); }, this.limits.toolTimeoutMs);
            }),
          ]);
      return await this.shapeResult(call, out, key, listener);
    } catch (e) {
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
    } finally {
      timer?.cancel();
      signal.removeEventListener("abort", onAbort);
    }
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
