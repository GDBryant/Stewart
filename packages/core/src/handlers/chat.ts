import { expandMentions, normalizeImages } from "@stewart/context";
import { composeRolePrompt } from "@stewart/roles-skills";
import { budgetProfile, classifyTask } from "@stewart/budget";
import { recoveryState } from "@stewart/agent-loop";
import { parseChatCommand } from "@stewart/runs";
import type { CoreCtx } from "./types.js";
import { channelById, pickChatAgent, workspaceInfoFor } from "./util.js";

export async function handleChatSend(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; text: string; images?: string[]; direct?: boolean; sessionId?: string; profile?: string };
  const ctx = core.ctx(p.projectId);
  const cmd = parseChatCommand(p.text, p.profile);
  const direct = p.direct || cmd.direct;
  const mention = await expandMentions(ctx.host, cmd.text);
  for (const d of mention.dropped) ctx.host.log(`mention ${d} could not be resolved`);
  const norm = normalizeImages(p.images ?? []);
  if (norm.dropped) ctx.host.log(`${norm.dropped} image(s) dropped: over size/count limits`);
  const orchestrator = ctx.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  const profileName =
    cmd.profileName ??
    classifyTask(mention.text, {
      workspaceSize: (await workspaceInfoFor(core, ctx, p.projectId))?.sizeClass,
      hasAttachments: norm.images.length > 0,
      orchestrated: !!orchestrator && !direct,
    });
  const profile = budgetProfile(ctx.config.settings, profileName);
  if (orchestrator && !direct) {
    const run = await ctx.runs.orchestrated(p.projectId, {
      config: ctx.config,
      channelFor: (id) => channelById(core, id),
      text: mention.text,
      sessionId: p.sessionId,
      profile,
      profileName,
    });
    return { runId: run.id };
  }
  const role = ctx.config.roles.find((r) => r.id === "general-worker" && r.enabled);
  const agent = pickChatAgent(ctx.config, role);
  const channel = channelById(core, agent.channel);
  const { prompt, truncated } = role
    ? composeRolePrompt(role, ctx.config.skills, ctx.config.settings.skillBudgetTokens)
    : { prompt: undefined, truncated: false };
  if (truncated) ctx.host.log(`role ${role?.id}: skill text truncated at skillBudgetTokens`);
  const history = p.sessionId ? ((await (await ctx.runs.historyStore()).load(p.sessionId)) ?? []) : [];
  const run = await ctx.runs.direct(
    p.projectId,
    channel,
    agent,
    mention.text,
    norm.images.length ? norm.images : undefined,
    role,
    prompt || undefined,
    p.sessionId,
    history,
    { config: ctx.config, profile, name: profileName, recovery: recoveryState(ctx.config.settings) },
  );
  return { runId: run.id };
}

export function handleChatCancel(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; runId: string };
  return { ok: core.ctx(p.projectId).runs.cancel(p.runId) };
}

export async function handleChatResume(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; runId: string };
  const ctx = core.ctx(p.projectId);
  const res = await ctx.runs.resume(p.projectId, p.runId, {
    config: ctx.config,
    channelFor: (id) => channelById(core, id),
  });
  return res.ok ? { ok: true, resumed: true, runId: res.run!.id } : { ok: false, resumed: false, reason: res.reason };
}

export function handleChatRevert(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; runId: string };
  return core.ctx(p.projectId).runs.revert(p.runId);
}

export function handleChatAnswer(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; questionId: string; answer: string };
  return { ok: core.ctx(p.projectId).runs.answer(p.questionId, p.answer) };
}

export function handleChatApprove(core: CoreCtx, params: unknown): unknown {
  const p = params as { projectId: string; approvalId: string; grant: "once" | "chat" | "always" | "deny" };
  return { ok: core.ctx(p.projectId).runs.approve(p.approvalId, p.grant) };
}

export async function handleHistoryList(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string };
  const store = await core.ctx(p.projectId).runs.historyStore();
  return { sessions: await store.list() };
}

export async function handleHistoryLoad(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  const store = await core.ctx(p.projectId).runs.historyStore();
  return { messages: (await store.load(p.sessionId)) ?? [] };
}

export async function handleHistoryDelete(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as { projectId: string; sessionId: string };
  const store = await core.ctx(p.projectId).runs.historyStore();
  await store.delete(p.sessionId);
  return { ok: true };
}
