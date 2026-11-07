// Public surface of @stewart/channels. Only this file is importable from outside.
export { ChannelError } from "./types.js";
export type { ChatEvent, ChatRequest, ChannelConfig, ChannelAdapter, ChannelDeps } from "./types.js";
export { ManagedChannel, ChannelRegistry } from "./registry.js";
export { OllamaAdapter, extractError, estimatePromptTokens, autoNumCtx } from "./ollama.js";
export { OpenAICompatAdapter } from "./openai.js";
export { ClaudeCliAdapter } from "./claude/adapter.js";
export type { ClaudeDeps, ClaudeLoginState } from "./claude/adapter.js";
export { nodeSpawn, makeTempDir, writeTempFile, rmDir } from "./claude/nodeSpawn.js";
export type { SpawnedProc, SpawnFn } from "./claude/nodeSpawn.js";
export { ClaudeStreamParser } from "./claude/parser.js";
export type { ClaudeEvent } from "./claude/parser.js";
