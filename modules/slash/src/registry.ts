import type { SlashCommand, SlashRegistry } from "./types.js";

export function createRegistry(commands: SlashCommand[]): SlashRegistry {
  const seen = new Map<string, SlashCommand>();
  for (const c of commands) {
    for (const key of [c.name, ...(c.aliases ?? [])]) {
      const k = key.toLowerCase();
      const prev = seen.get(k);
      if (prev !== undefined && prev !== c) throw new Error(`duplicate slash command name: ${k}`);
      seen.set(k, c);
    }
  }
  return {
    find: (name) => seen.get(name.toLowerCase()),
    list: () => commands.map(({ name, aliases, argHint, description }) => ({ name, aliases, argHint, description })),
  };
}
