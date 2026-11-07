// Public surface of @stewart/compaction. Only this file is importable from outside.
export {
  measureMessages, compactIfOver, pruneStale, splitForSummary, renderForSummary, summarizeMiddle, SUMMARY_INSTRUCTIONS,
} from "./compaction.js";
export type { SummarySplit } from "./compaction.js";
