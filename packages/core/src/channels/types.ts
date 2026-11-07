import type { Fetcher } from "../ports.js";
import type { DebugSink } from "../debug/debug.js";

import type { ToolCall, ChatMessage } from "@stewart/kernel";

/** Measured model behaviour from the opt-in bench suite (`bench.ts`). Absent field = unknown, never zero. */
export interface ModelPerf {
  ttftMs?: number;
  tokPerSec?: number;
  /** 0..1: share of 3 trials that produced a valid tool call on the configured tools path. */
  toolReliability?: number;
  jsonOk?: boolean;
  editOk?: boolean;
  benchedAt: number;
  benchVersion: number;
}

export type ModelCaps = {
  tools: "native" | "shim" | "none";
  vision: boolean;
  reasoning: boolean;
  imageGen: boolean;
  contextTokens: number;
  numCtx?: number;
  perf?: ModelPerf;
};

export const DEFAULT_CAPS: ModelCaps = { tools: "shim", vision: false, reasoning: false, imageGen: false, contextTokens: 32768 };

export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_calls"; calls: ToolCall[] }
  | { kind: "done"; usage?: { in: number; out: number }; costUsd?: number; truncated?: boolean };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: { name: string; description: string; schema: unknown }[];
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
};

export interface ChannelConfig {
  id: string;
  type: string;
  enabled: boolean;
  baseUrl?: string;
  secretRef?: string;
  extraModels?: string[];
  maxParallel: number;
  modelCaps?: Record<string, Partial<ModelCaps>>;
  [k: string]: unknown;
}

export interface ChannelAdapter {
  readonly type: string;
  /** Probe: list models + detect caps for one model. Throws on unreachable. */
  listModels(cfg: ChannelConfig, secret: string | undefined): Promise<string[]>;
  probeCaps(cfg: ChannelConfig, secret: string | undefined, model: string): Promise<Partial<ModelCaps>>;
  /** Stream a chat request; yields ChatEvents until done. */
  chat(cfg: ChannelConfig, secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent>;
  /** Optional: live per-model pricing in USD per million tokens (e.g. OpenRouter /models). Undefined when the channel reports none. */
  priceList?(cfg: ChannelConfig, secret: string | undefined): Promise<Record<string, { inPerMTok: number; outPerMTok: number }> | undefined>;
  /** Optional: generate an image; channels without it fall back to diagram-as-code. */
  generateImage?(cfg: ChannelConfig, secret: string | undefined, model: string, prompt: string): Promise<{ base64: string }>;
}

export type ChannelDeps = { fetcher: Fetcher; stallTimeoutMs?: number; debug?: DebugSink };

export class ChannelError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, readonly code?: string) {
    super(message);
    this.name = "ChannelError";
  }
}
