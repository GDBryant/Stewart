import type { SlashCommand, SlashRegistry } from "./types.js";

export function createRegistry(commands: SlashCommand[]): SlashRegistry {
  return {
    find: (name) => commands.find((c) => c.name === name),
    list: () => commands.map(({ name, aliases, argHint, description }) => ({ name, aliases, argHint, description })),
  };
}
