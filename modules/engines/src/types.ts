import type { ChatMessage, Json } from "@stewart/kernel";
import type { AgentDef } from "@stewart/config";
import type { ManagedChannel, SpawnFn } from "@stewart/channels";
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
  | { kind: "finished"; reason: "stop" | "turn_limit" | "cancelled" | "loop_guard" | "error"; error?: string };

export interface EngineTurn {
  sessionId: string;
  /** Prior turns plus the new user message last; the engine appends assistant/tool messages it produces. */
  transcript: ChatMessage[];
  system: string;
  agent: AgentDef;
  channel: ManagedChannel;
  /** The role this turn serves; engines pass it in approve meta. */
  roleId: string;
  /** Tools the loop executes; used only when `caps.ownTools` is false (claude-code runs its own). */
  tools: ToolRegistry;
  /** Session tools the host owns (delegate, plan_write...): merged for the native loop, served over MCP for claude-code. */
  hostTools?: ToolRegistry;
  /** Approval gate from @stewart/permissions. */
  approve: ApproveFn;
  /** Engine-private state, persisted by the session per chat. */
  state: Record<string, unknown>;
  /** Project root (absolute). */
  cwd: string;
  signal: AbortSignal;
  maxTurns: number;
  /** Called before each model request; used only when `caps.ownContext` is false (claude-code manages its own). */
  beforeModelTurn?: () => Promise<void>;
}

/** One function-task request: no tools, a schema-constrained JSON object out. */
export interface CompleteRequest {
  channel: ManagedChannel;
  agent: AgentDef;
  /** Role prompt: what the function does. */
  system: string;
  /** The single input the function works on. */
  input: string;
  /** JSON Schema (object) the reply must satisfy. */
  schema: Json;
  signal: AbortSignal;
}

export type CompleteResult =
  | { ok: true; value: Json; usage?: { in: number; out: number }; costUsd?: number }
  | { ok: false; error: string };

/** Injectable seams for the claude-code engine (tests). */
export interface ClaudeCodeDeps {
  spawn?: SpawnFn;
  env?: Record<string, string | undefined>;
}

export interface Engine {
  readonly id: "native-loop" | "claude-code";
  /** `ownTools`: the engine runs its own tools (claude-code). `ownContext`: it manages its own context window. */
  readonly caps: { ownTools: boolean; ownContext: boolean };
  run(turn: EngineTurn): AsyncIterable<EngineEvent>;
  /** Function tasks: one request, no tools, schema-constrained JSON object. */
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
