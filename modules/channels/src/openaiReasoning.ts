import { capsFor } from "@stewart/models";
import type { ChannelConfig, ChatRequest } from "./types.js";

/** The channel's configured reasoning request field (`none` = send nothing). */
export type ReasoningField = "none" | "reasoning_effort" | "enable_thinking";

export function reasoningField(cfg: ChannelConfig): ReasoningField {
  const f = cfg.reasoning;
  return f === "reasoning_effort" || f === "enable_thinking" ? f : "none";
}

/** True when the channel names a reasoning field and the probe has not found it ineffective on this model. */
export function reasoningRouting(cfg: ChannelConfig, model: string): boolean {
  return reasoningField(cfg) !== "none" && capsFor(cfg, model).reasoningControl !== false;
}

/** Extra request-body fields for the request's `think`/`effort`; empty when the field is `none`, the probe said unsupported, or nothing was asked. `think === false` is the hard off-switch. */
export function reasoningBody(cfg: ChannelConfig, req: Pick<ChatRequest, "model" | "think" | "effort">): Record<string, unknown> {
  if (!reasoningRouting(cfg, req.model)) return {};
  if (reasoningField(cfg) === "reasoning_effort") {
    if (req.think === false) return { reasoning_effort: "none" };
    if (req.effort) return { reasoning_effort: req.effort === "max" ? "high" : req.effort };
    return {};
  }
  if (req.think === false) return { chat_template_kwargs: { enable_thinking: false } };
  if (req.think === true || req.effort === "high" || req.effort === "max") return { chat_template_kwargs: { enable_thinking: true } };
  return {};
}

/** Reasoning tokens a non-streaming completion reports (top-level or nested), or 0. */
export function reasoningTokensOf(j: unknown): number {
  const u = (j as { usage?: { reasoning_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } } | undefined)?.usage;
  const n = u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens;
  return typeof n === "number" ? n : 0;
}

export type ProbePost = (body: Record<string, unknown>) => Promise<{ status: number; json?: unknown }>;

const PROBE_MESSAGES = [{ role: "user", content: "What is 17 * 23? Think it through, then answer with the number only." }];

/**
 * Sends the same trivial request without and with the reasoning-off field and compares `reasoning_tokens`:
 * true when the field cut them, false when it did not (or was rejected), undefined when the model reasons not at all
 * or the baseline failed (nothing to control / unknown). Never throws.
 */
export async function probeReasoningControl(cfg: ChannelConfig, model: string, post: ProbePost): Promise<boolean | undefined> {
  try {
    const base = await post({ model, stream: false, max_tokens: 512, messages: PROBE_MESSAGES });
    if (base.status !== 200) return undefined;
    const before = reasoningTokensOf(base.json);
    if (before <= 0) return undefined;
    const off = await post({ model, stream: false, max_tokens: 512, messages: PROBE_MESSAGES, ...reasoningBody({ ...cfg, modelCaps: {} }, { model, think: false }) });
    if (off.status !== 200) return false;
    return reasoningTokensOf(off.json) < before;
  } catch {
    return undefined;
  }
}

export type ReasoningSuggest = "reasoning_effort" | "enable_thinking" | "none";

/**
 * For a channel with no reasoning field: tries each candidate field (`reasoning_effort`, then `enable_thinking`) and returns the first
 * that cut reasoning tokens, `none` when the model reasons but neither did, undefined when it does not reason or the baseline failed.
 */
export async function suggestReasoningField(cfg: ChannelConfig, model: string, post: ProbePost): Promise<ReasoningSuggest | undefined> {
  let reasons = false;
  for (const field of ["reasoning_effort", "enable_thinking"] as const) {
    const r = await probeReasoningControl({ ...cfg, reasoning: field }, model, post);
    if (r === true) return field;
    if (r === undefined) return reasons ? "none" : undefined; // baseline failed or model does not reason: a second candidate would repeat it
    reasons = true;
  }
  return reasons ? "none" : undefined;
}
