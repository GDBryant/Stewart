import type { SlashCommand } from "../types.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  argHint: "",
  description: "Start a new conversation: forget this chat's messages and engine state",
  async run(ctx) {
    if (!ctx.sessionId) return ctx.say("Clear: no session yet — already a new conversation.");
    const res = await ctx.session.clear(ctx.sessionId);
    ctx.say(res.ok ? "Cleared. Starting a new conversation." : `Clear failed: ${res.reason ?? "unknown error"}`);
  },
};
