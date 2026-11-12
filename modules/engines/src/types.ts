import type { ChatMessage } from "@stewart/kernel";
import type { AgentDef } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import type { ApproveFn } from "@stewart/permissions";
import type { ToolRegistry } from "@stewart/tools";

/** One write-tool call outcome (same shape as @stewart/tasks WriteRecord, declared here to keep engines off tasks). */
export interface WriteRecord {
  path: string;
  ok: boolean;
  message?: string;
}

export type EngineEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool.request"; callId: string; tool: string; args: unknown; category: string }
  | { kind: "tool.outcome"; callId: string; ok: boolean; summary: string }
  | { kind: "write"; record: WriteRecord }
  | { kind: "usage"; inTokens: number; outTokens: number; costUsd?: number }
  | { kind: "finished"; reason: "stop" | "turn_limit" | "cancelled" | "error"; error?: string };

export interface EngineTurn {
  sessionId: string;
  /** Prior turns plus the new user message last; the engine appends assistant/tool messages it produces. */
  transcript: ChatMessage[];
  system: string;
  agent: AgentDef;
  channel: ManagedChannel;
  /** Tools the native loop executes. */
  tools: ToolRegistry;
  /** Approval gate from @stewart/permissions. */
  approve: ApproveFn;
  /** Engine-private state, persisted by the session per chat. */
  state: Record<string, unknown>;
  /** Project root (absolute). */
  cwd: string;
  signal: AbortSignal;
  maxTurns: number;
}

export interface Engine {
  readonly id: "native-loop" | "claude-code";
  run(turn: EngineTurn): AsyncIterable<EngineEvent>;
}
