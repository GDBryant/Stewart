import type { Fetcher } from "../ports.js";

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ChatMessage =
  | { role: "system" | "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ModelCaps = {
  tools: "native" | "shim" | "none";
  vision: boolean;
  reasoning: boolean;
  imageGen: boolean;
  contextTokens: number;
  numCtx?: number;
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
  /** Optional: generate an image; channels without it fall back to diagram-as-code. */
  generateImage?(cfg: ChannelConfig, secret: string | undefined, model: string, prompt: string): Promise<{ base64: string }>;
}

export type ChannelDeps = { fetcher: Fetcher; stallTimeoutMs?: number };

export class ChannelError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, readonly code?: string) {
    super(message);
    this.name = "ChannelError";
  }
}
