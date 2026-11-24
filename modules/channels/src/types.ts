import type { ChatMessage, Fetcher, ToolCall } from "@stewart/kernel";
import type { DebugSink } from "@stewart/diagnostics";
import type { ModelCaps } from "@stewart/models";
import { describeViolation, type Violation } from "@stewart/business-policy";

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
  /** false disables model reasoning where the provider supports it (Ollama `think`). */
  think?: boolean;
  /** Provider reasoning hint; a depth scale that rides on `think`. `think === false` stays the hard off-switch. */
  effort?: "low" | "medium" | "high" | "max";
  /** Floor for the Ollama context window (tokens); a retry after a `length` stop raises it. Capped by the model maximum. */
  minNumCtx?: number;
  /** JSON Schema the provider must constrain the reply to (provider support varies; callers may retry without). */
  responseSchema?: unknown;
  /** Called with the tool results the channel's business policy withheld from this request's copy. */
  onWithheld?: (withheld: Violation[]) => void;
  signal: AbortSignal;
};

/** A request blocked by the channel's business policy: nothing was sent. Not a channel failure. */
export class BusinessPolicyError extends Error {
  constructor(readonly channel: string, readonly violations: Violation[]) {
    super(`business_policy: blocked outgoing message to ${channel}: ${violations.map(describeViolation).join("; ")}`);
    this.name = "BusinessPolicyError";
  }
}

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
  /** Channel caps; claude-cli probes its CLI (args optional there), the rest report per-model. */
  probeCaps(cfg?: ChannelConfig, secret?: string | undefined, model?: string): Promise<Partial<ModelCaps>>;
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
