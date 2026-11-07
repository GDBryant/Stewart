import DATA from "./catalog.data.json" with { type: "json" };

/** Bundled pricing/limits snapshot; user-set agent.price always wins over this. */
export const CATALOG_UPDATED: string = DATA.updated;

export interface ModelInfo {
  inPerMTok?: number;
  outPerMTok?: number;
  contextTokens?: number;
  rpm?: number;
  tpm?: number;
  family?: string;
  tier?: string;
}

interface Entry extends ModelInfo {
  match: string;
}

const ENTRIES: { re: RegExp; info: ModelInfo }[] = (DATA.entries as Entry[]).map((e) => {
  const { match, ...info } = e;
  return { re: new RegExp(match, "i"), info };
});

/**
 * Bundled-catalog lookup. `model` is normalised (lowercase, provider/ prefix
 * stripped) then matched against entry regexes, first match wins. Local
 * channels are always free: ollama returns a zero-price record.
 */
export function lookupModelInfo(channelType: string, model: string): ModelInfo | undefined {
  if (channelType === "ollama") return { inPerMTok: 0, outPerMTok: 0 };
  const name = model.toLowerCase().split("/").pop() ?? model.toLowerCase();
  return ENTRIES.find((e) => e.re.test(name))?.info;
}

/** 3:1 in:out blend, the usual chat traffic mix. */
export function blendedCost(info: { inPerMTok?: number; outPerMTok?: number } | undefined): number | undefined {
  if (!info) return undefined;
  const i = info.inPerMTok;
  if (i === undefined) return undefined;
  const o = info.outPerMTok ?? i;
  return (3 * i + o) / 4;
}

export type CostTier = "free" | "low" | "mid" | "high";

/** Blended $/MTok bounds: 0 → free, below low → low, below mid → mid, else high. */
export const COST_TIER_BOUNDS = { low: 0.5, mid: 5 } as const;

export function costTier(blended: number | undefined): CostTier | undefined {
  if (blended === undefined) return undefined;
  if (blended === 0) return "free";
  if (blended < COST_TIER_BOUNDS.low) return "low";
  if (blended < COST_TIER_BOUNDS.mid) return "mid";
  return "high";
}
