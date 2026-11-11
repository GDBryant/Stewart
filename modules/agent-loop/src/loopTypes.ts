import type { ChatMessage, ToolCall } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import type { ToolOutcome } from "@stewart/tools";


export interface LoopListener {
  onText?(text: string): void;
  onReasoning?(text: string): void;
  onToolRequested?(call: ToolCall): void;
  onToolOutcome?(call: ToolCall, outcome: ToolOutcome): void;
  onCompacted?(beforeTokens: number, afterTokens: number, detail?: { pruned: number; summarized: boolean }): void;
  onCompactionFailed?(message: string): void;
  /** One model call finished: usage + provider-reported cost (ledger input). */
  onUsage?(usage: { in: number; out: number } | undefined, costUsd: number | undefined): void | Promise<void>;
}

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
