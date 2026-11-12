// Public surface of @stewart/kernel. Only this file is importable from outside.
export type { Json, ToolCall, ChatMessage, ToolSpec } from "./wire.js";
export { stripImages } from "./wire.js";
export type {
  VersionedEdit, ProcessHandle, HostPort, SecretsPort, FilesPort, ProcessPort, EditorPort, ProblemsPort, WorkspacePort, LogPort, Clock, IdGen, FetchResponse, Fetcher,
} from "./ports.js";
export { systemClock, counterIds, nodeFetch } from "./ports.js";
// In-memory fakes for tests of every module (the HostPort and Fetcher seams).
export { fakeHost, fakeFetcher, streamOf, collect } from "./testing.js";
export { mediaTypeFor } from "./mime.js";
export { EventBus } from "./events.js";
export type { EventSink, EventSubscriber } from "./events.js";
export type { FaultKind } from "./faults.js";
export { StewartError, ok, err, isErr, fromThrowable } from "./result.js";
export type { Result } from "./result.js";
