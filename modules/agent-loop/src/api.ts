// Public surface of @stewart/agent-loop. Only this file is importable from outside.
export { ToolLoop } from "./toolLoop.js";
export { RunCancelledError } from "./loopTypes.js";
export type { LoopListener, LoopResult } from "./loopTypes.js";
export { createAgentSession } from "./session.js";
export type { SessionSpec, AgentSession } from "./session.js";
export { classifyFault, successfulOutcome, detectStuck, actionsSoFar, countToolCalls } from "./faults.js";
export { createProbeLoop } from "./probe.js";
