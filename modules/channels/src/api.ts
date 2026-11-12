// Public surface of @stewart/channels. Only this file is importable from outside.
export { ChannelError } from "./types.js";
export type { ChatEvent, ChatRequest, ChannelConfig, ChannelAdapter, ChannelDeps } from "./types.js";
export { ManagedChannel, ChannelRegistry } from "./registry.js";
export { OllamaAdapter, extractError, estimatePromptTokens, autoNumCtx } from "./ollama.js";
export { OpenAICompatAdapter } from "./openai.js";
export { ClaudeCliAdapter, claudeChildEnv } from "./claude/adapter.js";
export type { ClaudeDeps, ClaudeLoginState } from "./claude/adapter.js";
export { nodeSpawn, makeTempDir, classify, writeTempFile, rmDir } from "./claude/nodeSpawn.js";
export type { SpawnedProc, SpawnFn } from "./claude/nodeSpawn.js";
export { ChannelService } from "./service.js";
export type { ChannelHealth, ChannelServiceDeps, ChannelSpec } from "./service.js";
