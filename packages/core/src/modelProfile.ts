import type { AgentDef } from "./config/schema.js";
import type { Config } from "./config/loader.js";
import { DEFAULT_CAPS, type ChannelConfig, type ModelCaps, type ModelPerf } from "./channels/types.js";
import { blendedCost, costTier, lookupModelInfo, type CostTier } from "./catalog.js";
import type { ToolsMode } from "./tools/toolLoop.js";

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
  config: Pick<Config, "channels">,
  ref: { channel: string; model: string; agent?: Pick<AgentDef, "price"> },
  live?: PriceMap,
): ModelProfile {
  return profileFromChannel(config.channels.find((c) => c.id === ref.channel), ref, live);
}

/** Same as `resolveModelProfile` when only the channel config is at hand (run paths). */
export function profileFromChannel(
  ch: Pick<ChannelConfig, "type" | "modelCaps"> | undefined,
  ref: { channel: string; model: string; agent?: Pick<AgentDef, "price"> },
  live?: PriceMap,
): ModelProfile {
  const caps: Partial<ModelCaps> = ch?.modelCaps?.[ref.model] ?? {};
  const channelType = ch?.type ?? "";
  let price: ModelProfile["price"];
  if (ref.agent?.price) price = { ...ref.agent.price, source: "agent" };
  else if (live?.[ref.model]) price = { inPerMTok: live[ref.model].inPerMTok, outPerMTok: live[ref.model].outPerMTok, source: "live" };
  else {
    const info = channelType ? lookupModelInfo(channelType, ref.model) : undefined;
    if (info?.inPerMTok !== undefined) price = { inPerMTok: info.inPerMTok, outPerMTok: info.outPerMTok ?? info.inPerMTok, source: "catalog" };
  }
  const costBlended = blendedCost(price);
  const contextTokens =
    caps.numCtx ?? caps.contextTokens ?? (channelType ? lookupModelInfo(channelType, ref.model)?.contextTokens : undefined);
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
