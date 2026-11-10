import { expandMentions, normalizeImages } from "@stewart/context";
import { composeRolePrompt } from "@stewart/roles-skills";
import { budgetProfile, classifyTask } from "@stewart/budget";
import { recoveryState } from "@stewart/agent-loop";
import { parseChatCommand } from "@stewart/runs";
import type { ChatMessage } from "@stewart/kernel";
import type { CoreCtx } from "./types.js";
import { pickChatAgent, workspaceInfoFor } from "./util.js";

type ChatParams = { projectId: string; text: string; images?: string[]; direct?: boolean; sessionId?: string; profile?: string };

async function chatProfileName(core: CoreCtx, ctx: ReturnType<CoreCtx["ctx"]>, p: ChatParams, cmd: ReturnType<typeof parseChatCommand>, mentionText: string, hasImages: boolean, orchestrated: boolean): Promise<ReturnType<typeof classifyTask>> {
  if (cmd.profileName) return cmd.profileName as ReturnType<typeof classifyTask>;
  const ws = await workspaceInfoFor(core, ctx, p.projectId);
  return classifyTask(mentionText, { workspaceSize: ws?.sizeClass, hasAttachments: hasImages, orchestrated });
}

async function orchestratedChat(core: CoreCtx, ctx: ReturnType<CoreCtx["ctx"]>, p: ChatParams, mentionText: string, sessionId: string | undefined, profile: ReturnType<typeof budgetProfile>, profileName: string): Promise<unknown> {
  const history: ChatMessage[] = sessionId ? ((await (await ctx.runs.historyStore()).load(sessionId)) ?? []) : [];
  const run = await ctx.runs.orchestrated(p.projectId, {
    config: ctx.config,
    channelFor: (id) => core.channelService.require(id),
    text: mentionText,
    sessionId,
    history,
    profile,
    profileName,
  });
  return { runId: run.id };
}

async function directChat(core: CoreCtx, ctx: ReturnType<CoreCtx["ctx"]>, p: ChatParams, mentionText: string, images: string[] | undefined, sessionId: string | undefined, profile: ReturnType<typeof budgetProfile>, profileName: string): Promise<unknown> {
  const role = ctx.config.roles.find((r) => r.id === "general-worker" && r.enabled);
  const agent = pickChatAgent(ctx.config, role);
  const channel = core.channelService.require(agent.channel);
  const { prompt, truncated } = role
    ? composeRolePrompt(role, ctx.config.skills, ctx.config.settings.skillBudgetTokens)
    : { prompt: undefined, truncated: false };
  if (truncated) ctx.host.log(`role ${role?.id}: skill text truncated at skillBudgetTokens`);
  const history = sessionId ? ((await (await ctx.runs.historyStore()).load(sessionId)) ?? []) : [];
  const run = await ctx.runs.direct(
    p.projectId,
    channel,
    agent,
    mentionText,
    images,
    role,
    prompt || undefined,
    sessionId,
    history,
    { config: ctx.config, profile, name: profileName, recovery: recoveryState(ctx.config.settings) },
  );
  return { runId: run.id };
}

export async function handleChatSend(core: CoreCtx, params: unknown): Promise<unknown> {
  const p = params as ChatParams;
  const ctx = core.ctx(p.projectId);
  const cmd = parseChatCommand(p.text, p.profile);
  const direct = p.direct || cmd.direct;
  const mention = await expandMentions(ctx.host, cmd.text);
  for (const d of mention.dropped) ctx.host.log(`mention ${d} could not be resolved`);
  const norm = normalizeImages(p.images ?? []);
  if (norm.dropped) ctx.host.log(`${norm.dropped} image(s) dropped: over size/count limits`);
  const orchestrator = ctx.config.roles.find((r) => r.id === "orchestrator" && r.enabled);
  const profileName = await chatProfileName(core, ctx, p, cmd, mention.text, norm.images.length > 0, !!orchestrator && !direct);
  const profile = budgetProfile(ctx.config.settings, profileName);
  if (orchestrator && !direct) return orchestratedChat(core, ctx, p, mention.text, p.sessionId, profile, profileName);
  return directChat(core, ctx, p, mention.text, norm.images.length ? norm.images : undefined, p.sessionId, profile, profileName);
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
    channelFor: (id) => core.channelService.require(id),
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
