// Public surface of @stewart/slash. Only this file is importable from outside.
export { parseSlash, slashPlainText } from "./parse.js";
export type { SlashParsed } from "./parse.js";
export { createRegistry } from "./registry.js";
export { runSlash } from "./run.js";
export { createSlashRegistry } from "./commands/index.js";
export { ensureInitFiles, INIT_INVESTIGATE, INIT_PROMPT, INIT_QUESTION, INIT_STOP } from "./commands/init.js";
export type { SlashCommand, SlashCommandInfo, SlashContext, SlashRegistry, SlashSessionPort } from "./types.js";
