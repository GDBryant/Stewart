// Public surface of @stewart/tools. Only this file is importable from outside.
export {
  ToolRegistry, outcomeMessage, validateArgs, UNCERTAIN_PREFIX, NOT_ANSWERED_CANCELLED,
} from "./types.js";
export type { Tool, ToolProvider, ToolOutcome } from "./types.js";
export { projectTools } from "./builtins.js";
export type { ProjectToolsDeps } from "./builtins.js";
export { applyUnifiedPatch } from "./fsWrite.js";
export type { ImageGenerator } from "./media.js";
export { ProjectPaths, MAX_FIND_RESULTS, MAX_SEARCH_RESULTS, MAX_FILE_BYTES, MAX_COMMAND_OUTPUT } from "./projectPaths.js";
export { roleRegistry, checkInvestigatorCommand } from "./roleRegistry.js";
