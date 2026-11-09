import { blendedCost, costTier, lookupModelInfo, type CostTier } from "@stewart/catalog";
import { DEFAULT_CAPS, type ModelCaps, type ModelPerf, type ToolsMode } from "./caps.js";

type AgentPrice = { price?: { inPerMTok: number; outPerMTok: number } };
export interface ChannelLike {
  id?: string;
  type: string;
  modelCaps?: Record<string, Partial<ModelCaps>>;
}

export type PriceMap = Record<string, { inPerMTok: number; outPerMTok: number; contextTokens?: number }>;

export interface ModelProfile {
  channelId: string;
  channelType: string;
  model: string;
  /** User `modelCaps` (probe results are merged into config before this). Absent field = unknown. */
  caps: Partial<ModelCaps>;
  /** `caps.tools` ?? DEFAULT_CAPS.tools. */
  toolsMode: ToolsMode;
  perf?: ModelPerf;
  /** `agent.price` > live price list > catalog. Unknown stays undefined, never 0. */
  price?: { inPerMTok: number; outPerMTok: number; source: "agent" | "live" | "catalog" };
  costBlended?: number;
  costTier?: CostTier;
  /** Usable context window in tokens: `numCtx` (server-side actual) > `contextTokens` > catalog. Unknown stays undefined. */
  contextTokens?: number;
}

/** Merge probe-discovered caps under user `modelCaps`: probe fills gaps, user wins. */
export function mergeProbeCaps(user: Partial<ModelCaps> | undefined, probe: Partial<ModelCaps>): Partial<ModelCaps> {
  return { ...probe, ...(user ?? {}) };
}

/** Single place that merges model facts. `live` is a channel price list keyed by model id. */
export function resolveModelProfile(
  config: { channels: (ChannelLike & { id: string })[] },
  ref: { channel: string; model: string; agent?: AgentPrice },
  live?: PriceMap,
): ModelProfile {
  return profileFromChannel(config.channels.find((c) => c.id === ref.channel), ref, live);
}

/** Same as `resolveModelProfile` when only the channel config is at hand (run paths). */
function resolvePrice(ref: { channel: string; model: string; agent?: AgentPrice }, live: PriceMap | undefined, channelType: string): ModelProfile["price"] {
  if (ref.agent?.price) return { ...ref.agent.price, source: "agent" };
  if (live?.[ref.model]) return { inPerMTok: live[ref.model].inPerMTok, outPerMTok: live[ref.model].outPerMTok, source: "live" };
  const info = channelType ? lookupModelInfo(channelType, ref.model) : undefined;
  if (info?.inPerMTok !== undefined) return { inPerMTok: info.inPerMTok, outPerMTok: info.outPerMTok ?? info.inPerMTok, source: "catalog" };
  return undefined;
}

export function profileFromChannel(
  ch: ChannelLike | undefined,
  ref: { channel: string; model: string; agent?: AgentPrice },
  live?: PriceMap,
): ModelProfile {
  const caps: Partial<ModelCaps> = ch?.modelCaps?.[ref.model] ?? {};
  const channelType = ch?.type ?? "";
  const price = resolvePrice(ref, live, channelType);
  const costBlended = blendedCost(price);
  const contextTokens = caps.numCtx ?? caps.contextTokens ?? (channelType ? lookupModelInfo(channelType, ref.model)?.contextTokens : undefined);
  return {
    channelId: ref.channel,
    channelType,
    model: ref.model,
    caps,
    toolsMode: (caps.tools ?? DEFAULT_CAPS.tools) as ToolsMode,
    perf: caps.perf,
    price,
    costBlended,
    costTier: costTier(costBlended),
    contextTokens,
  };
}
