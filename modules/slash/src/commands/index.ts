import { createRegistry } from "../registry.js";
import type { SlashCommand } from "../types.js";
import { clearCommand } from "./clear.js";
import { helpCommand } from "./help.js";
import { initCommand } from "./init.js";

export function builtinCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [];
  const registry = createRegistry(commands);
  commands.push(helpCommand(() => registry.list()), initCommand, clearCommand);
  return commands;
}
