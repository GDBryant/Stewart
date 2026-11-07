// Public surface of @stewart/toolcall-format. Only this file is importable from outside.
export { parseToolCalls, repairNativeCall, newCallId, ToolCallParseException, FAILURE_REASONS } from "./shimParser.js";
export type { ParseError, ParseResult, SchemaMap, RawCall } from "./shimParser.js";
export { buildToolsBlock, shimExampleCall } from "./shimPrompt.js";
export { ToolCallStreamFilter } from "./streamFilter.js";
