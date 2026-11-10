// Public surface of @stewart/code-health. Only this file is importable from outside.
export {
  bandFor, batchInventory, mergeReports, aggregate, renderReport, isHealthCheckRequest, isSourceFile,
} from "./types.js";
export type { Band, FileHealth, Finding, HealthReport, InventoryEntry, Aggregate, ProjectCheck } from "./types.js";
export { scanMetrics, summarizeMetrics, renderMetricsSummary, renderMetrics } from "./metrics.js";
export type { FunctionMetric, Suppression, FileMetrics, MetricsSummary } from "./metrics.js";
