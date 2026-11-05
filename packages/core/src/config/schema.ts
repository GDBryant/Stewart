import { z } from "zod";

export const CONFIG_VERSION = 1;

const modelCaps = z.object({
  tools: z.enum(["native", "shim", "none"]).optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  imageGen: z.boolean().optional(),
  contextTokens: z.number().int().positive().optional(),
  numCtx: z.number().int().positive().optional(),
});

export const channelSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1), // openai-compatible | ollama | claude-cli | acp — open set via ChannelRegistry
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  baseUrl: z.string().optional(),
  secretRef: z.string().optional(),
  discoverModels: z.boolean().default(true),
  extraModels: z.array(z.string()).default([]),
  maxParallel: z.number().int().min(1).optional(), // default: ollama 1, others 4
  modelCaps: z.record(z.string(), modelCaps).default({}),
});
export type ChannelDef = z.infer<typeof channelSchema>;

export const agentSchema = z.object({
  id: z.string().min(1),
  channel: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "max"]).default("medium"),
  temperature: z.number().optional(),
  billing: z.enum(["free", "reported", "priced", "unmetered"]).optional(),
  price: z.object({ inPerMTok: z.number(), outPerMTok: z.number() }).optional(),
});
export type AgentDef = z.infer<typeof agentSchema>;

export const roleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(false),
  prompt: z.string().optional(),
  agent: z.string().optional(),
  fallbackAgent: z.string().optional(),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  turnBudget: z.union([z.number().int().positive(), z.literal("unlimited")]).default(25),
});
export type RoleDef = z.infer<typeof roleSchema>;

export const settingsSchema = z.object({
  costLimit: z
    .object({
      perRunUsd: z.number().min(0).default(0),
      onLimit: z.enum(["ask", "stop"]).default("ask"),
    })
    .default({}),
  maxRunHours: z.number().min(0).default(0),
  planGate: z.boolean().default(false),
  leaseWaitSeconds: z.number().min(1).default(300),
  maxNestedDispatches: z.number().int().min(0).default(3),
  maxReplans: z.number().int().min(0).default(2),
  skillBudgetTokens: z.number().int().positive().default(8000),
  log: z.object({ level: z.enum(["off", "calls", "full"]).default("off"), retainDays: z.number().int().min(0).default(7) }).default({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Each config file is versioned; loaders migrate older versions. */
export function versioned<T extends z.ZodTypeAny>(inner: T) {
  return z.object({ version: z.number().int().default(CONFIG_VERSION), items: z.array(inner).default([]) });
}

export const channelsFile = versioned(channelSchema);
export const agentsFile = versioned(agentSchema);
export const rolesFile = versioned(roleSchema);
export const settingsFile = z.object({ version: z.number().int().default(CONFIG_VERSION) }).merge(settingsSchema);
