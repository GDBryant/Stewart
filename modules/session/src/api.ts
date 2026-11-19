// Public surface of @stewart/session. Only this file is importable from outside.
export { SessionService } from "./session.js";
export { ChatHistoryStore, storedMediaType, imgBytesToB64 } from "./history.js";
export type { StoredImage, StoredMessage, StoredChat, SessionSummary } from "./history.js";
export type { SessionDeps, SendRequest } from "./session.js";
export { parseSlash, slashPlainText, runSlash, SLASH_COMMANDS, ensureInitFiles, INIT_QUESTION, INIT_INVESTIGATE, INIT_STOP, INIT_PROMPT } from "./slash.js";
export type { SlashDeps, SlashParsed, SlashCommand } from "./slash.js";
