import { createRegistry } from "../registry.js";
import type { SlashCommand, SlashRegistry } from "../types.js";
import { clearCommand } from "./clear.js";
import { helpCommand } from "./help.js";
import { initCommand } from "./init.js";

export function createSlashRegistry(extra: SlashCommand[] = []): SlashRegistry {
  const registry: SlashRegistry = createRegistry([helpCommand(() => registry.list()), initCommand, clearCommand, ...extra]);
  return registry;
}
