import { nativeLoop } from "./nativeLoop.js";
import { claudeCodeEngine } from "./claudeCode.js";
import type { Engine } from "./types.js";

/** Pick the engine for a channel type: `claude-cli` runs the CLI as a full supervised agent. */
export function engineFor(channelType: string): Engine {
  if (channelType === "claude-cli") return claudeCodeEngine();
  return nativeLoop;
}
