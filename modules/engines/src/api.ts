// Public surface of @stewart/engines. Only this file is importable from outside.
export { nativeLoop } from "./nativeLoop.js";
export { claudeCodeEngine } from "./claudeCode.js";
export type { ClaudeCodeDeps, CompleteRequest, CompleteResult } from "./types.js";
export { engineFor } from "./engineFor.js";
export type { Engine, EngineEvent, EngineTurn, WriteRecord } from "./types.js";
export { startMcp, mcpConfigArg } from "./mcp.js";
export type { McpHandle } from "./mcp.js";
export { runFunction } from "./functionRun.js";
export type { FunctionRequest, FunctionResult } from "./functionRun.js";
