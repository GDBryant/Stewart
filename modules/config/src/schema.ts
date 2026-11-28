import { z } from "zod";
import { migrateRoleChain } from "./roleMigrate.js";

export const CONFIG_VERSION = 1;

export const effortSchema = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof effortSchema>;

const modelPerf = z.object({
  ttftMs: z.number().optional(),
  tokPerSec: z.number().optional(),
  toolReliability: z.number().min(0).max(1).optional(),
  jsonOk: z.boolean().optional(),
  editOk: z.boolean().optional(),
  benchedAt: z.number(),
  benchVersion: z.number().int(),
});

const qual = z.object({
  passed: z.boolean(),
  at: z.number(),
  version: z.number().int(),
  detail: z.string().optional(),
  context: z.number().int().positive().optional(),
});

const modelCaps = z.object({
  // "shim" (v2: text tool-call shim, removed) loads as "unknown".
  tools: z.preprocess((v) => (v === "shim" ? "unknown" : v), z.enum(["native", "unknown", "none"]).optional()),
  vision: z.boolean().optional(),
  /** The channel's engine can set reasoning effort on this model (claude-cli `--effort`, probed from `claude --help`). */
  effortSupport: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  /** openai-compatible: the channel's reasoning request field demonstrably cuts reasoning tokens on this model (probe); false = never send it. */
  reasoningControl: z.boolean().optional(),
  imageGen: z.boolean().optional(),
  contextTokens: z.number().int().positive().optional(),
  numCtx: z.number().int().positive().optional(),
  perf: modelPerf.optional(),
  qualified: z.object({ agent: qual.optional(), function: qual.optional() }).optional(),
});
export type Qual = z.infer<typeof qual>;

/** Business-policy rule switches (outbound content rules). Global defaults live in settings; a channel may override. */
export const securitySchema = z.object({ passwords: z.boolean().default(true), privacy: z.boolean().default(true) });
export const channelSecuritySchema = z.object({ passwords: z.boolean().optional(), privacy: z.boolean().optional() });
export type Security = z.infer<typeof securitySchema>;

/** Effective rules for a channel: its own override when set, else the global value. */
export function effectiveSecurity(global: Security, channel?: { security?: z.infer<typeof channelSecuritySchema> }): Security {
  const o = channel?.security;
  return { passwords: o?.passwords ?? global.passwords, privacy: o?.privacy ?? global.privacy };
}

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
  /** openai-compatible: which request field carries reasoning depth. `none` (default) sends nothing; proxies differ. */
  reasoning: z.enum(["none", "reasoning_effort", "enable_thinking"]).default("none"),
  settingSources: z.string().optional(), // claude-cli: --setting-sources; default "" loads no user/project/local settings
  modelCaps: z.record(z.string(), modelCaps).default({}),
  security: channelSecuritySchema.optional(), // absent key = inherit settings.security
});
export type ChannelDef = z.infer<typeof channelSchema>;

export const agentSchema = z.object({
  id: z.string().min(1),
  channel: z.string().min(1),
  model: z.string().min(1),
  effort: effortSchema.default("medium"),
  temperature: z.number().optional(),
  billing: z.enum(["free", "reported", "priced", "unmetered"]).optional(),
  price: z.object({ inPerMTok: z.number(), outPerMTok: z.number() }).optional(),
  costs: z.boolean().optional(), // known cost flag shown on assigned roles; default derived (claude-cli, reported/priced billing)
});
export type AgentDef = z.infer<typeof agentSchema>;

export const roleSchema = z.preprocess(
  migrateRoleChain,
  z.object({
    id: z.string().min(1),
    enabled: z.boolean().default(false),
    prompt: z.string().optional(),
    kind: z.enum(["agent", "function"]).default("agent"),
    agent: z.string().optional(),
    secondary: z.string().optional(),
    /** Larger-window agent that serves this role's plan milestone tasks first (long builds); falls back to the normal chain. */
    heavyAgent: z.string().optional(),
    /** Role ids whose primary agent's model this role should avoid running on (independent review/plan). */
    distinctFrom: z.array(z.string()).default([]),
  needs: z.object({ vision: z.boolean().optional(), minContext: z.number().int().positive().optional() }).optional(),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  turnBudget: z.union([z.number().int().positive(), z.literal("unlimited")]).default(25),
  /** false: ask the provider not to emit reasoning (Ollama `think`); report roles spend the output window on the reply. Unset: provider default. */
  think: z.boolean().optional(),
  /** Per-role reasoning depth; overrides the agent's `effort`. Unset: inherit from the agent (defaults to medium). */
  effort: effortSchema.optional(),
  }),
);
export type RoleDef = z.infer<typeof roleSchema>;

export const settingsSchema = z.object({
  costLimit: z
    .object({
      perRunUsd: z.number().min(0).default(0),
      onLimit: z.enum(["ask", "stop"]).default("ask"),
    })
    .default({}),
  /** Turn budget of the lead run (overrides the lead role's turnBudget); >= 1000 runs until the model finishes. */
  runTurnLimit: z.number().int().positive().default(60),
  /** Loop-guard divert (Part 2): when a run trips `loop_guard`, switch to the strongest reasoning-capable agent (or `agent`) once. */
  escalation: z
    .object({
      onLoopGuard: z
        .object({
          /** false turns the loop-guard divert off (the static chain proceeds); absent/true = auto-ranking. */
          enabled: z.boolean().optional(),
          /** Explicit divert target agent id; wins over the auto-ranking when eligible. */
          agent: z.string().optional(),
          /** Effort override for the diverted run (wins over the target's effective effort). */
          effort: effortSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  skillBudgetTokens: z.number().int().positive().default(8000),
  historyRetentionDays: z.number().int().min(0).default(30),
  setupPriorities: z
    .object({
      speed: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      cost: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      quality: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    })
    .default({ speed: 2, cost: 2, quality: 2 }),
  setupTypicalWork: z.enum(["scripts", "features", "refactors", "mixed"]).optional(),
  log: z.object({ level: z.enum(["off", "calls", "full"]).default("off"), retainDays: z.number().int().min(0).default(7) }).default({}),
  security: securitySchema.default({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Each config file is versioned; loaders migrate older versions. */
export function versioned<T extends z.ZodTypeAny>(inner: T) {
  return z.object({ version: z.number().int().default(CONFIG_VERSION), items: z.array(inner).default([]) });
}

export const channelsFile = versioned(channelSchema);
export const agentsFile = versioned(agentSchema);
export const rolesFile = versioned(roleSchema);
// `security` stays partial per layer so a layer that omits a rule does not reset a lower layer's value to the default.
export const settingsFile = z.object({ version: z.number().int().default(CONFIG_VERSION) }).merge(settingsSchema).extend({ security: channelSecuritySchema.optional() });

/** `.stewart/project.yaml` (project layer, trusted workspaces only): how code verifies every writing task here. */
export const projectFile = z.object({
  version: z.number().int().default(CONFIG_VERSION),
  /** Argv commands run after a task that changed files; each goes through the normal permission gate. */
  verify: z.array(z.array(z.string()).min(1)).default([]),
  readRoots: z.array(z.string()).default([]),
});
export type ProjectFile = z.infer<typeof projectFile>;
