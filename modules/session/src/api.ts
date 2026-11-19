// Public surface of @stewart/session. Only this file is importable from outside.
export { SessionService } from "./session.js";
export { ChatHistoryStore, storedMediaType, imgBytesToB64 } from "./history.js";
export type { StoredImage, StoredMessage, StoredChat, SessionSummary } from "./history.js";
export type { SessionDeps, SendRequest } from "./session.js";
