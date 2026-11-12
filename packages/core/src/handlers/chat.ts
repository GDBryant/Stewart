import { expandMentions, normalizeImages } from "@stewart/context";
import type { CoreCtx } from "./types.js";

type ChatParams = { projectId: string; text: string; images?: string[]; sessionId?: string };

export async function handleChatSend(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as ChatParams;
  const ctx = core.ctx(p.projectId);
  const lead = ctx.config.roles.find((r) => r.id === "lead" && r.enabled);
  if (!lead) throw new Error("the lead role is disabled; enable it to chat");
  const mention = await expandMentions(ctx.host, p.text);
  for (const d of mention.dropped) ctx.host.log(`mention ${d} could not be resolved`);
  const norm = normalizeImages(p.images ?? []);
  if (norm.dropped) ctx.host.log(`${norm.dropped} image(s) dropped: over size/count limits`);
  const res = await ctx.sessions.send({ sessionId: p.sessionId, text: mention.text, images: norm.images.length ? norm.images : undefined });
  return { runId: res.runId, sessionId: res.sessionId };
}

export function handleChatCancel(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; runId: string };
  return { ok: core.ctx(p.projectId).sessions.cancel(p.runId) };
}

export function handleChatAnswer(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; questionId: string; answer: string };
  return { ok: core.ctx(p.projectId).interaction.resolveAnswer(p.questionId, p.answer) };
}

export function handleChatApprove(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; approvalId: string; grant: "once" | "chat" | "always" | "deny" };
  return { ok: core.ctx(p.projectId).interaction.resolveApproval(p.approvalId, p.grant) };
}

export async function handleHistoryList(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  return { sessions: await (await core.ctx(p.projectId).sessions.historyStore()).list() };
}

export async function handleHistoryLoad(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  return { messages: (await (await core.ctx(p.projectId).sessions.historyStore()).load(p.sessionId)) ?? [] };
}

export async function handleHistoryDelete(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  await (await core.ctx(p.projectId).sessions.historyStore()).delete(p.sessionId);
  return { ok: true };
}
