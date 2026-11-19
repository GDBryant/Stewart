import { createSlashRegistry } from "@stewart/slash";
import type { CoreCtx } from "./types.js";

export const slashRegistry = createSlashRegistry();

export function handleSlashList(_core: CoreCtx, _params: unknown): unknown {
  return { commands: slashRegistry.list() };
}
