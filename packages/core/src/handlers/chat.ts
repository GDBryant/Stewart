import { expandMentions, normalizeImages } from "@stewart/context";
import { counterIds } from "@stewart/kernel";
import { builtinCommands, createRegistry, runSlash, slashPlainText } from "@stewart/slash";
import type { CoreCtx } from "./types.js";

const slashRegistry = createRegistry(builtinCommands());

type ChatParams = { projectId: string; text: string; images?: string[]; sessionId?: string };

export async function handleChatSend(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as ChatParams;
  const ctx = core.ctx(p.projectId);
  const handled = await runSlash(
    slashRegistry,
    {
      ids: core.deps.ids ?? counterIds(),
      emit: core.deps.emitEvent,
      files: ctx.host.files,
      interaction: ctx.interaction,
      session: {
        send: (sessionId, text) => ctx.sessions.send({ sessionId, text }),
        clear: (sessionId) => ctx.sessions.clear(sessionId),
      },
    },
    p.text,
    p.sessionId,
  );
  if (handled) return { sessionId: p.sessionId };
  const lead = ctx.config.roles.find((r) => r.id === "lead" && r.enabled);
  if (!lead) throw new Error("the lead role is disabled; enable it to chat");
  const mention = await expandMentions(ctx.host, slashPlainText(p.text));
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

/** Sets (when `on` is given) and returns the project's bypass-permissions mode. */
export function handlePermissionsBypass(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; on?: boolean };
  const perms = core.ctx(p.projectId).permissions;
  if (typeof p.on === "boolean") perms.setBypass(p.on);
  return { on: perms.bypass };
}

export async function handleHistoryList(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  return { sessions: await (await core.ctx(p.projectId).sessions.historyStore()).list() };
}

export async function handleChatResume(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  return await core.ctx(p.projectId).sessions.resume(p.sessionId);
}

export async function handleChatRevert(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string; checkpoint?: string };
  return await core.ctx(p.projectId).sessions.revert(p.sessionId, p.checkpoint);
}

export async function handleFileDiff(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string; path: string; baseline: string };
  await core.ctx(p.projectId).sessions.fileDiff(p.sessionId, p.path, p.baseline);
  return { ok: true };
}

export async function handleHistoryLoad(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  const sessions = core.ctx(p.projectId).sessions;
  return { messages: await sessions.fullHistory(p.sessionId), plan: await sessions.planFor(p.sessionId) };
}

export async function handleHistoryDelete(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  await core.ctx(p.projectId).sessions.delete(p.sessionId);
  return { ok: true };
}
