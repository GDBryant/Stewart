import type { FilesPort, IdGen } from "@stewart/kernel";
import type { Interaction } from "@stewart/interaction";
import type { SlashCommandInfo } from "@stewart/protocol";

export type { SlashCommandInfo } from "@stewart/protocol";

export interface SlashSessionPort {
  send(sessionId: string | undefined, text: string): Promise<unknown>;
  clear(sessionId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface SlashContext {
  args: string;
  sessionId?: string;
  ids: IdGen;
  files: FilesPort["files"];
  interaction: Interaction;
  session: SlashSessionPort;
  say(text: string): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  argHint: string;
  description: string;
  run(ctx: SlashContext): Promise<void>;
}

export interface SlashRegistry {
  find(name: string): SlashCommand | undefined;
  list(): SlashCommandInfo[];
}
