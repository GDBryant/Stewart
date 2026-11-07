import type { RoleDef } from "@stewart/config";
import { DEFAULT_LIMITS } from "@stewart/budget";

export const DIRECT_TASK_ID = "direct";

export const chatRoleDef = (): RoleDef => ({ id: "chat", enabled: true, skills: [], tools: [], writePaths: [], turnBudget: DEFAULT_LIMITS.maxModelTurns });

export const timeCapMessage = (ms: number): string => `run time limit reached (${Math.round(ms / 60_000)}min)`;
