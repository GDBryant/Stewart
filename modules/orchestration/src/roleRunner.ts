import { fallbackPrompt } from "./prompts.js";
import type { RoleDef } from "@stewart/config";
import type { ChatMessage } from "@stewart/kernel";
import { DEFAULT_CAPS, isCosting } from "@stewart/models";
import { composeRolePrompt } from "@stewart/roles-skills";
import { agentServesRole } from "@stewart/roles-skills";
import { DEFAULT_BUDGET_PROFILES } from "@stewart/budget";
import { projectTools, type ImageGenerator } from "@stewart/tools";
import { ProjectPaths } from "@stewart/tools";
import { RunCancelledError, type LoopResult } from "@stewart/agent-loop";
import { renderForSummary, SUMMARY_INSTRUCTIONS } from "@stewart/compaction";
import { createAgentSession } from "@stewart/agent-loop";
import { classifyFault } from "@stewart/agent-loop";
import { terminalToolNames, type RunRuntime, type RoleTaskDeps, type TaskResult } from "@stewart/run-contract";
import { ToolRegistry } from "@stewart/tools";
import { costOfCall } from "@stewart/ledger";
import { LeaseCycleError } from "@stewart/run-state";
import { leasedTools } from "@stewart/tools";
import { loadProjectContext } from "@stewart/context";
import type { TaskSpec } from "@stewart/scheduling";

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);
const TERMINAL = new Set(["submit_plan", "submit_verdict", "submit_replacements"]);

/** Deterministic prefix order: role prompt + skills, bounded AGENTS.md + memory, then the briefing. */
export async function buildRolePrompt(rt: RunRuntime, role: RoleDef): Promise<string> {
  const { prompt } = composeRolePrompt(role, rt.config.skills, rt.skillBudgetTokens);
  return `${prompt}${await loadProjectContext(rt.host)}`;
}

/**
 * Run one dispatched task under its role's constraints: fresh context, role tool
 * filter, writePaths + leases, turn budget, idempotent tool calls, ledger cost.
 */
export async function runRoleTask(
  rt: RunRuntime,
  spec: TaskSpec,
  deps: RoleTaskDeps,
): Promise<TaskResult> {
  const { role } = deps;
  const resolved = await resolveAgent(rt, spec, role, deps.agent);
  if ("status" in resolved) return resolved;
  const { agent, channel } = resolved;
  for (const f of spec.files) rt.leases.tryAcquire(f, spec.id);
  const { session, state } = await buildSessionDeps(rt, spec, deps, agent, channel);

  const messages: ChatMessage[] = deps.history ?? [{ role: "user", content: roleBriefing(spec, deps) }];

  let result: LoopResult;
  try {
    result = await session.loop.run(agent.model, messages, session.listener, rt.signal);
  } catch (e) {
    return roleTaskError(e, state, rt);
  }

  return toTaskResult(result, state, session.limits.maxModelTurns);
}

function roleBriefing(spec: TaskSpec, deps: RoleTaskDeps): string {
  const parts = [spec.task];
  if (spec.files.length) parts.push(`Files: ${spec.files.join(", ")}`);
  if (spec.expect) parts.push(`Expect: ${spec.expect}`);
  if (deps.extraBriefing) parts.push(deps.extraBriefing);
  if (deps.depSummaries?.length) parts.push(`Prior results:\n${deps.depSummaries.join("\n")}`);
  return parts.join("\n\n");
}

function roleTaskError(e: unknown, state: { filesTouched: string[] }, rt: RunRuntime): TaskResult {
  if (e instanceof LeaseCycleError) {
    return { status: "cancelled", summary: e.message, filesTouched: state.filesTouched, cycleVictim: e.victim, cycleHolder: e.holder };
  }
  if (e instanceof RunCancelledError) return { status: "cancelled", summary: "cancelled", filesTouched: state.filesTouched, transcript: e.transcript };
  if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched: state.filesTouched };
  return { status: "failed", summary: e instanceof Error ? e.message : String(e), filesTouched: state.filesTouched };
}

async function unhealthyFallback(
  rt: RunRuntime,
  spec: TaskSpec,
  role: RoleDef,
  agent: NonNullable<RoleTaskDeps["agent"]>,
): Promise<TaskResult | { agent: NonNullable<RoleTaskDeps["agent"]>; channel: ReturnType<RunRuntime["channelFor"]> }> {
  const fb = role.fallbackAgent ? rt.config.agents.find((a) => a.id === role.fallbackAgent) : undefined;
  if (!fb || !agentServesRole(fb, rt.config.channels, role.id)) {
    return { status: "parked", summary: `parked: channel ${agent.channel} unhealthy`, filesTouched: [] };
  }
  const fbChannel = rt.channelFor(fb.channel);
  if (fbChannel.unhealthy) {
    return { status: "parked", summary: `parked: channel ${fb.channel} unhealthy`, filesTouched: [] };
  }
  if (!isCosting(agent) && isCosting(fb)) {
    const o = await rt.prompt(fallbackPrompt(agent, role, fb), { roleId: role.id, taskId: spec.id });
    if (o.kind !== "answered" || o.value !== "switch") {
      return { status: "parked", summary: `parked: fallback to paid agent '${fb.id}' declined`, filesTouched: [] };
    }
  }
  return { agent: fb, channel: fbChannel };
}

async function resolveAgent(
  rt: RunRuntime,
  spec: TaskSpec,
  role: RoleDef,
  override?: RoleTaskDeps["agent"],
): Promise<{ agent: NonNullable<RoleTaskDeps["agent"]>; channel: ReturnType<RunRuntime["channelFor"]> } | TaskResult> {
  const agentId = rt.roleAgentOverrides?.get(role.id) ?? role.agent;
  let agent = override ?? rt.config.agents.find((a) => a.id === agentId);
  if (!agent) return { status: "failed", summary: `role ${role.id}: enabled but no agent bound`, filesTouched: [] };
  let channel = rt.channelFor(agent.channel);
  if (channel.unhealthy) {
    const fb = await unhealthyFallback(rt, spec, role, agent);
    if ("status" in fb) return fb;
    agent = fb.agent;
    channel = fb.channel;
  }
  if (rt.cost.reached() && isCosting(agent)) {
    return { status: "parked", summary: `parked: cost limit reached`, filesTouched: [] };
  }
  return { agent, channel };
}

function imageGenFor(channel: ReturnType<RunRuntime["channelFor"]>, agent: NonNullable<RoleTaskDeps["agent"]>): ImageGenerator | undefined {
  const enabled = (channel.cfg.modelCaps?.[agent.model]?.imageGen ?? DEFAULT_CAPS.imageGen) && channel.adapter.generateImage;
  return enabled ? (prompt: string) => channel.generateImage(agent.model, prompt) : undefined;
}

function leasedRegistry(rt: RunRuntime, spec: TaskSpec, role: RoleDef, base: ToolRegistry): ToolRegistry {
  return new ToolRegistry(
    leasedTools(base.tools, {
      host: rt.host,
      leases: rt.leases,
      taskId: spec.id,
      runId: rt.runId,
      leaseWaitMs: rt.leaseWaitMs,
      stateDir: rt.stateDir,
      onWait: (_path, holder) => rt.bus.emit({ kind: "task.blocked", runId: rt.runId, taskId: spec.id, roleId: role.id, waitingOn: holder }),
    }),
  );
}

async function buildSessionDeps(
  rt: RunRuntime,
  spec: TaskSpec,
  deps: RoleTaskDeps,
  agent: NonNullable<RoleTaskDeps["agent"]>,
  channel: ReturnType<RunRuntime["channelFor"]>,
) {
  const { role } = deps;
  const paths = await ProjectPaths.forProject(rt.host);
  const extra = deps.nestedTools ?? [];
  const imageGen = imageGenFor(channel, agent);
  const base = new ToolRegistry([...projectTools(rt.host, paths, { generateImage: imageGen }).tools, ...extra]).for(role);
  const registry = leasedRegistry(rt, spec, role, base);

  const prompt = deps.prompt ?? (await buildRolePrompt(rt, role));
  const terminalNames = new Set([...TERMINAL, ...terminalToolNames(rt.features)]);
  const terminal = new Set([...terminalNames].filter((t) => registry.find(t)));
  const state = { filesTouched: [] as string[], terminalCallId: undefined as string | undefined };

  const { summarize, prune } = compactionFor(rt, spec.id);
  const session = createAgentSession(
    {
      agent,
      role,
      channel,
      registry,
      approve: (call, preview) => (deps.approve ?? rt.approve)(call, preview, { roleId: role.id, taskId: spec.id }),
      prompt,
      terminal,
      budget: { profile: rt.budgetProfile ?? DEFAULT_BUDGET_PROFILES.normal, ceiling: rt.maxWorkerTurnsCeiling ?? 60 },
      limitsOverride: prune ? { prune: true } : undefined,
      meter: { ledger: rt.ledger, cost: rt.cost, runId: rt.runId, taskId: spec.id, roleId: role.id },
      idem: rt.idem.hooks(spec.id, deps.idemOffset),
      summarize,
      events: { bus: rt.bus, runId: rt.runId, taskId: spec.id, roleId: role.id },
      hooks: {
        onToolRequested: (call) => {
          if (WRITE_TOOLS.has(call.name) && typeof call.arguments.path === "string") state.filesTouched.push(call.arguments.path);
          if (terminalNames.has(call.name)) state.terminalCallId = call.id;
        },
      },
    },
    rt.clock,
  );
  return { session, state };
}

function toTaskResult(
  result: LoopResult,
  state: { filesTouched: string[]; terminalCallId?: string },
  maxModelTurns: number,
): TaskResult {
  const { filesTouched, terminalCallId } = state;
  if (result.kind === "failed") {
    return { status: "failed", summary: result.message, filesTouched, fault: classifyFault(result), transcript: [...result.base, ...result.messages] };
  }
  if (result.kind === "turn_limit") {
    return {
      status: "stopped",
      summary: "turn limit reached",
      filesTouched,
      fault: "turn_limit",
      transcript: [...result.base, ...result.messages],
      turnBudget: maxModelTurns,
    };
  }
  const produced = [...result.base, ...result.messages];
  const submitted = terminalCallId
    ? produced.find((m) => m.role === "tool" && m.toolCallId === terminalCallId)?.content ?? ""
    : "";
  const text = produced
    .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "")
    .map((m) => (m as { content: string }).content)
    .join("\n")
    .trim();
  return { status: "done", summary: submitted || text || "(no text returned)", filesTouched, transcript: produced };
}

/** Session compaction options from `settings.compaction`; shared by worker and orchestrator loops. */
export function compactionFor(rt: RunRuntime, taskId?: string): { prune: boolean; summarize?: (middle: ChatMessage[]) => Promise<string> } {
  const c = rt.config.settings.compaction;
  return { prune: c?.prune ?? false, summarize: c?.summarize ? compactorFor(rt, taskId) : undefined };
}

/**
 * Summarizer bound to the enabled `compactor` role's agent; undefined (prune/clip only) when no such
 * role or agent exists. Calls are metered to the ledger under role `compactor`.
 */
export function compactorFor(rt: RunRuntime, taskId?: string): ((middle: ChatMessage[]) => Promise<string>) | undefined {
  const role = rt.config.roles.find((r) => r.id === "compactor" && r.enabled);
  const agent = role && rt.config.agents.find((a) => a.id === role.agent);
  if (!agent) return undefined;
  const channel = rt.channelFor(agent.channel);
  if (channel.unhealthy) return undefined;
  return (middle) => runCompactor(rt, channel, agent, middle, taskId);
}

async function recordCompactionCost(rt: RunRuntime, agent: NonNullable<RoleTaskDeps["agent"]>, ev: { usage?: { in: number; out: number }; costUsd?: number }, taskId?: string): Promise<void> {
  const costUsd = costOfCall(agent, ev.usage, ev.costUsd);
  await rt.ledger.record({
    runId: rt.runId,
    ...(taskId ? { taskId } : {}),
    roleId: "compactor",
    agentId: agent.id,
    model: agent.model,
    billing: agent.billing ?? "reported",
    inTokens: ev.usage?.in ?? 0,
    outTokens: ev.usage?.out ?? 0,
    costUsd,
  });
  rt.cost.accrued += costUsd;
}

async function runCompactor(rt: RunRuntime, channel: ReturnType<RunRuntime["channelFor"]>, agent: NonNullable<RoleTaskDeps["agent"]>, middle: ChatMessage[], taskId?: string): Promise<string> {
  if (rt.cost.reached() && isCosting(agent)) return "";
  let text = "";
  const messages: ChatMessage[] = [
    { role: "system", content: SUMMARY_INSTRUCTIONS },
    { role: "user", content: renderForSummary(middle) },
  ];
  for await (const ev of channel.chat({ model: agent.model, messages, signal: rt.signal })) {
    if (ev.kind === "text") text += ev.text;
    if (ev.kind === "done") await recordCompactionCost(rt, agent, ev, taskId);
  }
  return text;
}
