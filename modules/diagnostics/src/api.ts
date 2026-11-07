// Public surface of @stewart/diagnostics. Only this file is importable from outside.
export { NOOP_DEBUG_SINK, DEBUG_LINE_RE, formatDebugLine, redact, DebugLogger, eventEntry } from "./debug.js";
export type { DebugLevel, DebugDirection, DebugEntry, DebugSink } from "./debug.js";
