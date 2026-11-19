import type { RunEvent } from "@stewart/protocol";
import { parseSlash } from "./parse.js";
import type { SlashContext, SlashRegistry } from "./types.js";

/**
 * Runs a slash command; false when [input] is not a command (caller sends it as
 * a normal message). Unknown commands answer with a local hint, not a turn.
 */
export async function runSlash(
  registry: SlashRegistry,
  deps: Omit<SlashContext, "args" | "sessionId" | "say"> & { emit(ev: RunEvent): void },
  input: string,
  sessionId?: string,
): Promise<boolean> {
  const parsed = parseSlash(input);
  if (!parsed) return false;
  const say = (text: string) => deps.emit({ kind: "chat.local", runId: deps.ids.next("slash"), text });
  const cmd = registry.find(parsed.name);
  if (!cmd) {
    say(`Unknown command \`/${parsed.name}\` — type \`/help\``);
    return true;
  }
  try {
    await cmd.run({ args: parsed.args, sessionId, ids: deps.ids, files: deps.files, interaction: deps.interaction, session: deps.session, say });
  } catch (e) {
    say(`/${cmd.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}
