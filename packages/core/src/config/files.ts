import { agentsFile, channelsFile, rolesFile, settingsFile } from "./schema.js";
import type { z } from "zod";

/** Files the config system knows about, mapped to their schema. */
export const CONFIG_FILE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "channels.yaml": channelsFile,
  "agents.yaml": agentsFile,
  "roles.yaml": rolesFile,
  "settings.yaml": settingsFile,
};

/** Project layer may only carry these (trusted-workspace gated in loader). */
export const PROJECT_FILES = new Set(["roles.yaml"]);
