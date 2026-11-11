import type { ManagedChannel } from "@stewart/channels";
import { DEFAULT_LIMITS, type LoopLimits } from "@stewart/budget";
import type { ToolsMode } from "@stewart/models";
import type { ChatMessage, IdempotencyHooks, ToolCall } from "@stewart/kernel";
import type { Clock } from "@stewart/kernel";
import { parseToolCalls, buildToolsBlock, type ParseError, type SchemaMap } from "@stewart/toolcall-format";
import { compactIfOver, measureMessages, pruneStale, summarizeMiddle } from "@stewart/compaction";
import type { ApprovalGate } from "@stewart/permissions";
import { RunCancelledError, type LoopListener, type LoopResult } from "./loopTypes.js";
import { NOT_ANSWERED_CANCELLED, outcomeMessage, ToolRegistry } from "@stewart/tools";
import { CallExecutor } from "./callExecutor.js";
import { streamTurn, type StreamOutcome, type TurnState } from "./toolStream.js";

export class ToolLoop {
  private readonly executor: CallExecutor;

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
  ) {
    this.executor = new CallExecutor(registry, approval, limits, clock, terminalTools, idempotency);
  }

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
        const s = await streamTurn(
          { channel: this.channel, registry: this.registry, toolsMode: this.toolsMode, modelCallTimeoutMs: this.limits.modelCallTimeoutMs ?? 0 },
          model,
          this.outbound(base, produced),
          listener,
          signal,
          turn,
        );
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
    const batch = await this.executor.executeCalls(parsed.calls, produced, listener, inFlight, signal, executed);
    if (batch.terminal) return { completed: true, executed: batch.executed };
    if (parsed.errors.length > 0) produced.push({ role: "user", content: this.parseFeedback(parsed.errors) });
    return { completed: false, executed: batch.executed };
  }

  private outbound(base: ChatMessage[], produced: ChatMessage[]): ChatMessage[] {
    const system = this.systemPrompt();
    return system ? [{ role: "system", content: system }, ...base, ...produced] : [...base, ...produced];
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
}
