// Public surface of @stewart/kernel. Only this file is importable from outside.
export type { Json, ToolCall, ChatMessage, ToolSpec } from "./wire.js";
export type {
  VersionedEdit, ProcessHandle, HostPort, Clock, IdGen, FetchResponse, Fetcher,
} from "./ports.js";
export { systemClock, counterIds, nodeFetch } from "./ports.js";
