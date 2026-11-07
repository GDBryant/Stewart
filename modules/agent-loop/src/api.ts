// Public surface of @stewart/agent-loop. Only this file is importable from outside.
export { ToolLoop } from "./toolLoop.js";
export { RunCancelledError } from "./loopTypes.js";
export type { ApprovalDecision, ApprovalGate, LoopListener, LoopResult } from "./loopTypes.js";
export { createAgentSession } from "./session.js";
export type { SessionSpec, AgentSession } from "./session.js";
export { classifyFault, successfulOutcome, detectStuck, actionsSoFar, countToolCalls } from "./faults.js";
export type { FaultKind } from "./faults.js";
export { recoveryState } from "./runtime.js";
export type {
  RecoveryState, TaskResult, RoleTaskDeps, OrchestrationRuntime, RunRuntime, RecoveryBrain, RecoveryContext, RunTaskOnce, Recovery,
} from "./runtime.js";
