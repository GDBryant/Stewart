import { z } from "zod";

/** Protocol major version. Bumped on breaking changes; minor skew degrades via capabilities. */
export const PROTOCOL_VERSION = 1;

/** Capabilities a peer advertises at handshake; unknown names are ignored (degraded, not refused). */
export const KNOWN_CAPABILITIES = [
  "stream_events",
  "approvals",
  "diff_preview",
  "diagnostics",
  "images",
] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export const helloSchema = z.object({
  protocol: z.number().int(),
  capabilities: z.array(z.string()).default([]),
  client: z.string().optional(),
});
export type Hello = z.infer<typeof helloSchema>;

export const helloResultSchema = z.object({
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
});
export type HelloResult = z.infer<typeof helloResultSchema>;

export const projectIdSchema = z.string().min(1);

// ---- Events: core -> host -> webview ----------------------------------------

const base = { runId: z.string(), taskId: z.string().optional(), roleId: z.string().optional() };

export const runEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started"), ...base, title: z.string() }),
  z.object({ kind: z.literal("run.finished"), ...base, status: z.enum(["done", "failed", "cancelled", "stopped", "no_dispatch"]), error: z.string().optional() }),
  z.object({ kind: z.literal("text_delta"), ...base, seq: z.number(), text: z.string() }),
  z.object({ kind: z.literal("reasoning_delta"), ...base, seq: z.number(), text: z.string() }),
  z.object({ kind: z.literal("terminal_output"), ...base, seq: z.number(), text: z.string() }),
  z.object({ kind: z.literal("task.created"), ...base, title: z.string(), dependsOn: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal("task.started"), ...base, agentId: z.string().optional() }),
  z.object({ kind: z.literal("task.blocked"), ...base, waitingOn: z.string() }),
  z.object({ kind: z.literal("task.done"), ...base, summary: z.string() }),
  z.object({ kind: z.literal("task.failed"), ...base, error: z.string() }),
  z.object({ kind: z.literal("tool.request"), ...base, callId: z.string(), tool: z.string(), args: z.unknown(), category: z.string() }),
  z.object({ kind: z.literal("tool.outcome"), ...base, callId: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ kind: z.literal("ask_user"), ...base, questionId: z.string(), question: z.string(), options: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("question.answered"), ...base, questionId: z.string(), answer: z.string(), answeredBy: z.enum(["orchestrator", "user"]) }),
  z.object({ kind: z.literal("approval.request"), ...base, approvalId: z.string(), tool: z.string(), args: z.unknown(), category: z.string() }),
  z.object({ kind: z.literal("milestone.started"), ...base, milestoneId: z.string(), title: z.string() }),
  z.object({ kind: z.literal("milestone.done"), ...base, milestoneId: z.string() }),
  z.object({ kind: z.literal("milestone.failed"), ...base, milestoneId: z.string(), error: z.string() }),
  z.object({ kind: z.literal("plan.created"), ...base, milestoneCount: z.number() }),
  z.object({ kind: z.literal("plan.validated"), ...base, verdict: z.enum(["approve", "revise"]), reasons: z.array(z.string()) }),
  z.object({ kind: z.literal("plan.approved"), ...base, milestoneCount: z.number() }),
  z.object({ kind: z.literal("review.done"), ...base, findings: z.number() }),
  z.object({ kind: z.literal("run.reverted"), ...base, filesRestored: z.array(z.string()) }),
  z.object({
    kind: z.literal("cost.summary"),
    ...base,
    capUsd: z.number(),
    accruedUsd: z.number(),
    overshootUsd: z.number(),
    byRole: z.record(z.string(), z.number()),
    byAgent: z.record(z.string(), z.object({ costUsd: z.number(), inTokens: z.number(), outTokens: z.number() })),
    parked: z.array(z.string()),
    freeFinished: z.array(z.string()),
    suggestions: z.array(z.object({ role: z.string(), agent: z.string(), reason: z.string() })),
  }),
  z.object({ kind: z.literal("cost.limit_reached"), ...base, capUsd: z.number(), accruedUsd: z.number() }),
  z.object({ kind: z.literal("cost.limit_raised"), ...base, capUsd: z.number() }),
  z.object({ kind: z.literal("cost.replaced"), ...base, roleId: z.string(), agentId: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("compaction"), ...base, droppedTokens: z.number() }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventKind = RunEvent["kind"];

// ---- RPC methods ------------------------------------------------------------

/** Host -> core requests (params). Every method carries projectId. */
export interface CoreRequests {
  hello: { params: Hello; result: HelloResult };
  "chat.send": { params: { projectId: string; text: string; images?: string[]; direct?: boolean; sessionId?: string; profile?: string }; result: { runId: string } };
  "chat.cancel": { params: { projectId: string; runId: string }; result: { ok: true } };
  "chat.resume": { params: { projectId: string; runId: string }; result: { ok: true } };
  "chat.revert": { params: { projectId: string; runId: string }; result: { ok: boolean; filesRestored: string[]; reason?: string } };
  "chat.answer": { params: { projectId: string; questionId: string; answer: string }; result: { ok: true } };
  "chat.approve": { params: { projectId: string; approvalId: string; grant: "once" | "chat" | "always" | "deny" }; result: { ok: true } };
  "config.get": { params: { projectId: string }; result: { files: Record<string, string | undefined>; summary: unknown; errors: string[]; secrets: Record<string, boolean> } };
  "config.set": { params: { projectId: string; file: string; yaml: string; layer?: "user" | "project" }; result: { ok: true } };
  "channel.test": { params: { projectId: string; channelId: string }; result: { ok: boolean; models?: string[]; error?: string } };
  "channel.probe": { params: { projectId: string; channelId: string; model: string; force?: boolean; bench?: boolean }; result: { ok: boolean; caps?: Record<string, unknown>; probedAt?: number; cached?: boolean; catalog?: Record<string, unknown>; error?: string } };
  "setup.recommend": { params: { projectId: string; mode?: "rules" | "ai"; evaluator?: { channel: string; model: string }; context?: { priorities?: { speed?: number; cost?: number; quality?: number }; typicalWork?: string }; bench?: boolean }; result: unknown };
  "secret.set": { params: { projectId: string; ref: string; value: string }; result: { ok: true } };
  "secret.delete": { params: { projectId: string; ref: string }; result: { ok: true } };
}

/** Core -> host notifications. */
export interface CoreNotifications {
  event: RunEvent;
}

export const METHODS = [
  "hello",
  "chat.send",
  "chat.cancel",
  "chat.resume",
  "chat.revert",
  "chat.answer",
  "chat.approve",
  "config.get",
  "config.set",
  "channel.test",
  "channel.probe",
  "secret.set",
  "secret.delete",
] as const;
export type Method = (typeof METHODS)[number];

// ---- JSON-RPC framing --------------------------------------------------------

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

/** Handshake: decide if peers can talk; returns negotiated capability set or a reason to refuse. */
export function negotiate(local: Hello, remote: Hello): { ok: true; capabilities: string[] } | { ok: false; error: string } {
  if (remote.protocol !== local.protocol) {
    return { ok: false, error: `protocol version mismatch: local ${local.protocol}, remote ${remote.protocol}` };
  }
  const capabilities = remote.capabilities.filter((c): c is Capability => (KNOWN_CAPABILITIES as readonly string[]).includes(c));
  return { ok: true, capabilities };
}
