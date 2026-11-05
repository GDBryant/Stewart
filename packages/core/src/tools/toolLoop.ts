import type { ManagedChannel } from "../channels/registry.js";
import type { ChatMessage, ToolCall } from "../channels/types.js";
import type { Clock } from "../ports.js";
import { parseToolCalls, type SchemaMap } from "./shimParser.js";
import {
  NOT_ANSWERED_CANCELLED, outcomeMessage, ToolRegistry,
  type ToolOutcome, type ToolPreview,
} from "./types.js";

export type ApprovalDecision = { kind: "approved" } | { kind: "rejected"; reason: string };
export type ApprovalGate = (call: ToolCall, preview: ToolPreview | null) => Promise<ApprovalDecision>;

export interface LoopListener {
  onText?(text: string): void;
  onReasoning?(text: string): void;
  onToolRequested?(call: ToolCall): void;
  onToolOutcome?(call: ToolCall, outcome: ToolOutcome): void;
  onCompacted?(beforeTokens: number, afterTokens: number): void;
  onCompactionFailed?(message: string): void;
}

export interface LoopLimits {
  maxModelTurns: number;
  toolTimeoutMs: number;
  maxToolOutputChars: number;
  maxContextChars: number;
  maxTruncationRetries: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxModelTurns: 10,
  toolTimeoutMs: 60_000,
  maxToolOutputChars: 20_000,
  maxContextChars: 400_000,
  maxTruncationRetries: 1,
};

export class RunCancelledError extends Error {
  constructor(
    readonly base: ChatMessage[],
    readonly produced: ChatMessage[],
    cause?: unknown,
  ) {
    super("cancelled", { cause });
    this.name = "RunCancelledError";
  }
  get transcript(): ChatMessage[] {
    return [...this.base, ...this.produced];
  }
}

export type LoopResult =
  | { kind: "completed"; messages: ChatMessage[]; base: ChatMessage[] }
  | { kind: "turn_limit"; messages: ChatMessage[]; base: ChatMessage[] }
  | { kind: "failed"; messages: ChatMessage[]; base: ChatMessage[]; message: string; code?: string };

export type ToolsMode = "native" | "shim" | "none";

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
  ) {}

  private get schemaMap(): SchemaMap {
    return Object.fromEntries(this.registry.tools.map((t) => [t.spec.name, t.spec.parameters]));
  }

  async run(model: string, history: ChatMessage[], listener: LoopListener, signal: AbortSignal): Promise<LoopResult> {
    const produced: ChatMessage[] = [];
    const base = history;
    let turns = 0;
    let text = "";
    let turnOpen = false;
    const inFlight = { id: null as string | null, awaitsUser: false };
    try {
      while (true) {
        if (turns >= this.limits.maxModelTurns) return { kind: "turn_limit", messages: produced, base };
        const size = [...base, ...produced].reduce(
          (n, m) => n + ("content" in m ? m.content.length : 0) +
            ("toolCalls" in m && m.toolCalls ? m.toolCalls.reduce((k, c) => k + JSON.stringify(c.arguments).length, 0) : 0),
          0,
        );
        if (size > this.limits.maxContextChars) {
          return { kind: "failed", messages: produced, base, message: "context size limit exceeded", code: "context_limit" };
        }
        turns++;
        text = "";
        turnOpen = true;
        let calls: ToolCall[] = [];
        const outbound: ChatMessage[] = this.rolePrompt
          ? [{ role: "system", content: this.rolePrompt }, ...base, ...produced]
          : [...base, ...produced];
        let sawDone = false;
        let postDone = false;
        let failed: Error | null = null;
        try {
          for await (const ev of this.channel.chat({
            model,
            messages: outbound,
            tools: this.toolsMode === "native" ? this.registry.specs.map((s) => ({ name: s.name, description: s.description, schema: s.parameters })) : undefined,
            signal,
          })) {
            if (sawDone) postDone = true;
            else if (ev.kind === "text") {
              text += ev.text;
              listener.onText?.(ev.text);
            } else if (ev.kind === "reasoning") {
              listener.onReasoning?.(ev.text);
            } else if (ev.kind === "tool_calls") {
              calls = ev.calls;
            } else if (ev.kind === "done") {
              sawDone = true;
            }
          }
        } catch (e) {
          if (signal.aborted) throw e;
          failed = e instanceof Error ? e : new Error(String(e));
        }
        if (postDone) {
          return { kind: "failed", messages: produced, base, message: "provider emitted events after completion", code: "protocol_error" };
        }
        if (failed) return { kind: "failed", messages: produced, base, message: failed.message };
        if (!sawDone) {
          return { kind: "failed", messages: produced, base, message: "stream ended before completion", code: "incomplete_stream" };
        }
        turnOpen = false;
        if (this.toolsMode === "shim") {
          const parsed = parseToolCalls(text, this.schemaMap);
          if (parsed.reasoning) listener.onReasoning?.(parsed.reasoning);
          if (parsed.calls.length > 0 && parsed.clean !== text) {
            // only strip the call blocks when calls parsed; leftover text is kept
            text = parsed.clean || text;
          }
          calls = parsed.calls;
        }
        produced.push({ role: "assistant", content: text, toolCalls: calls.length > 0 ? calls : undefined });
        if (calls.length === 0) return { kind: "completed", messages: produced, base };
        const seen = new Set<string>();
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          listener.onToolRequested?.(call);
          const outcome = await this.executeCall(call, seen, listener, inFlight, signal);
          produced.push({ role: "tool", toolCallId: call.id, content: outcomeMessage(outcome) });
          if (this.terminalTools.has(call.name) && outcome.kind === "success") {
            for (const rest of calls.slice(i + 1)) {
              produced.push({ role: "tool", toolCallId: rest.id, content: `Not executed: '${call.name}' ended the turn` });
            }
            return { kind: "completed", messages: produced, base };
          }
        }
      }
    } catch (e) {
      this.closeOpenToolCalls(produced, inFlight);
      if (turnOpen && text.trim() !== "") produced.push({ role: "assistant", content: text });
      if (signal.aborted) throw new RunCancelledError(base, produced, e);
      throw e;
    }
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
  ): Promise<ToolOutcome> {
    if (seen.has(call.id)) return this.finishOutcome(call, { kind: "invalid", reason: "duplicate tool call id" }, listener);
    seen.add(call.id);
    const tool = this.registry.find(call.name);
    if (!tool) return this.finishOutcome(call, { kind: "invalid", reason: `unknown tool '${call.name}'` }, listener);
    const invalid = this.registry.validate(call);
    if (invalid != null) return this.finishOutcome(call, { kind: "invalid", reason: invalid }, listener);
    let preview: ToolPreview | null = null;
    if (tool.requiresApproval) {
      try {
        preview = (await tool.preview?.(call.arguments)) ?? null;
      } catch (e) {
        if (signal.aborted) throw e;
        return this.finishOutcome(call, { kind: "failure", message: e instanceof Error ? e.message : "preview failed" }, listener);
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
        return this.finishOutcome(call, { kind: "rejected", reason: decision.reason }, listener);
      }
    }
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
      const s = out.length > this.limits.maxToolOutputChars
        ? `${out.slice(0, this.limits.maxToolOutputChars)}\n[output truncated]`
        : out;
      return this.finishOutcome(call, { kind: "success", content: s }, listener);
    } catch (e) {
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
}
