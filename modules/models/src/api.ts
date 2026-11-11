// Public surface of @stewart/models. Only this file is importable from outside.
export { DEFAULT_CAPS, isCosting, capsFor, userCaps } from "./caps.js";
export type { CapsSource, ModelCaps, ModelPerf, ToolsMode } from "./caps.js";
export { mergeProbeCaps, profileFromChannel, resolveModelProfile } from "./profile.js";
export type { ModelProfile, PriceMap, ChannelLike } from "./profile.js";
export type { ProbeLoop, ProbeRequest, ProbeResult } from "./probe.js";
