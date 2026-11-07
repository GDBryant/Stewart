import type { RoleDef } from "../config/schema.js";
import type { ChatMessage } from "../channels/types.js";
import { DEFAULT_CAPS } from "../channels/types.js";
import { composeRolePrompt } from "../skills/skills.js";
import { agentServesRole, roleRegistry } from "../roles.js";
import { DEFAULT_BUDGET_PROFILES, resolveLimits } from "../limits.js";
import { projectTools } from "../tools/builtins.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { RunCancelledError, ToolLoop, type LoopResult, type ToolsMode } from "../tools/toolLoop.js";
import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/types.js";
import { costOfCall, isCosting } from "./ledger.js";
import { leasedTools, LeaseCycleError } from "./writeGuard.js";
import { loadProjectContext } from "../projectContext.js";
import type { OrchestrationRuntime } from "./types.js";
import type { TaskSpec } from "./tasks.js";

export interface TaskResult {
  status: "done" | "failed" | "cancelled" | "parked" | "stopped";
  summary: string;
  filesTouched: string[];
  evidence?: string;
  cycleVictim?: string;
  cycleHolder?: string;
}

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch", "GenerateImage"]);
const TERMINAL = new Set(["submit_plan", "submit_verdict", "submit_replacements"]);

/** Deterministic prefix order: role prompt + skills, bounded AGENTS.md + memory, then the briefing. */
export async function buildRolePrompt(rt: OrchestrationRuntime, role: RoleDef): Promise<string> {
  const { prompt } = composeRolePrompt(role, rt.config.skills, rt.skillBudgetTokens);
  return `${prompt}${await loadProjectContext(rt.host)}`;
}

/**
 * Run one dispatched task under its role's constraints: fresh context, role tool
 * filter, writePaths + leases, turn budget, idempotent tool calls, ledger cost.
 */
export async function runRoleTask(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: { role: RoleDef; nestedTools?: Tool[]; depSummaries?: string[] },
): Promise<TaskResult> {
  const { role } = deps;
  const agentId = rt.roleAgentOverrides?.get(role.id) ?? role.agent;
  let agent = rt.config.agents.find((a) => a.id === agentId);
  if (!agent) return { status: "failed", summary: `role ${role.id}: enabled but no agent bound`, filesTouched: [] };
  let channel = rt.channelFor(agent.channel);
  if (channel.unhealthy) {
    const fb = role.fallbackAgent ? rt.config.agents.find((a) => a.id === role.fallbackAgent) : undefined;
    if (!fb || !agentServesRole(fb, rt.config.channels, role.id)) {
      return { status: "parked", summary: `parked: channel ${agent.channel} unhealthy`, filesTouched: [] };
    }
    const fbChannel = rt.channelFor(fb.channel);
    if (fbChannel.unhealthy) {
      return { status: "parked", summary: `parked: channel ${fb.channel} unhealthy`, filesTouched: [] };
    }
    if (!isCosting(agent) && isCosting(fb)) {
      const choice = await rt.ask(
        `Channel '${agent.channel}' is unhealthy. Switch role '${role.id}' from free agent '${agent.id}' to paid fallback '${fb.id}'?`,
        ["Switch", "Park"],
      );
      if (!choice.startsWith("Switch")) {
        return { status: "parked", summary: `parked: fallback to paid agent '${fb.id}' declined`, filesTouched: [] };
      }
    }
    agent = fb;
    channel = fbChannel;
  }
  if (rt.cost.reached() && isCosting(agent)) {
    return { status: "parked", summary: `parked: cost limit reached`, filesTouched: [] };
  }
  for (const f of spec.files) rt.leases.tryAcquire(f, spec.id);
  const paths = await ProjectPaths.forProject(rt.host);
  const extra = deps.nestedTools ?? [];
  const genChannel = channel;
  const genModel = agent.model;
  const imageGen = (channel.cfg.modelCaps?.[agent.model]?.imageGen ?? DEFAULT_CAPS.imageGen) && channel.adapter.generateImage
    ? (prompt: string) => genChannel.generateImage(genModel, prompt)
    : undefined;
  const base = roleRegistry(
    new ToolRegistry([...projectTools(rt.host, paths, { generateImage: imageGen }).tools, ...extra]),
    role,
  );
  const registry = new ToolRegistry(
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

  const prompt = await buildRolePrompt(rt, role);
  const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
  const limits = resolveLimits({
    role,
    agent,
    profile: rt.budgetProfile ?? DEFAULT_BUDGET_PROFILES.normal,
    ceiling: rt.maxWorkerTurnsCeiling ?? 60,
    perf: channel.cfg.modelCaps?.[agent.model]?.perf,
    channelType: channel.cfg.type,
  });
  const terminal = new Set([...TERMINAL].filter((t) => registry.find(t)));
  const filesTouched: string[] = [];
  let terminalCallId: string | undefined;

  const activeAgent = agent;
  const loop = new ToolLoop(
    channel,
    registry,
    (call, preview) => rt.approve(call, preview, { roleId: role.id, taskId: spec.id }),
    limits,
    rt.clock,
    prompt,
    terminal,
    mode,
    rt.idem.hooks(spec.id),
  );

  const briefingParts = [spec.task];
  if (spec.files.length) briefingParts.push(`Files: ${spec.files.join(", ")}`);
  if (spec.expect) briefingParts.push(`Expect: ${spec.expect}`);
  if (deps.depSummaries?.length) briefingParts.push(`Prior results:\n${deps.depSummaries.join("\n")}`);
  const messages: ChatMessage[] = [{ role: "user", content: briefingParts.join("\n\n") }];
  const listener = {
    onText: (t: string) => rt.bus.emit({ kind: "text_delta", runId: rt.runId, taskId: spec.id, roleId: role.id, seq: 0, text: t }),
    onReasoning: (t: string) => rt.bus.emit({ kind: "reasoning_delta", runId: rt.runId, taskId: spec.id, roleId: role.id, seq: 0, text: t }),
    onCompacted: (before: number, after: number) =>
      rt.bus.emit({ kind: "compaction", runId: rt.runId, taskId: spec.id, roleId: role.id, droppedTokens: Math.max(0, before - after) }),
    onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (WRITE_TOOLS.has(call.name) && typeof call.arguments.path === "string") filesTouched.push(call.arguments.path);
      if (TERMINAL.has(call.name)) terminalCallId = call.id;
      rt.bus.emit({ kind: "tool.request", runId: rt.runId, taskId: spec.id, roleId: role.id, callId: call.id, tool: call.name, args: call.arguments, category: call.name });
    },
    onToolOutcome: (call: { id: string; name: string }, outcome: { kind: string }) => {
      rt.bus.emit({ kind: "tool.outcome", runId: rt.runId, taskId: spec.id, roleId: role.id, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind });
    },
    onUsage: async (usage: { in: number; out: number } | undefined, reported: number | undefined) => {
      const costUsd = costOfCall(activeAgent, usage, reported);
      await rt.ledger.record({
        runId: rt.runId,
        taskId: spec.id,
        roleId: role.id,
        agentId: activeAgent.id,
        model: activeAgent.model,
        billing: activeAgent.billing ?? "reported",
        inTokens: usage?.in ?? 0,
        outTokens: usage?.out ?? 0,
        costUsd,
      });
      rt.cost.accrued += costUsd;
    },
  };

  let result: LoopResult;
  try {
    result = await loop.run(activeAgent.model, messages, listener, rt.signal);
  } catch (e) {
    if (e instanceof LeaseCycleError) {
      return { status: "cancelled", summary: e.message, filesTouched, cycleVictim: e.victim, cycleHolder: e.holder };
    }
    if (e instanceof RunCancelledError) return { status: "cancelled", summary: "cancelled", filesTouched };
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched };
    return { status: "failed", summary: e instanceof Error ? e.message : String(e), filesTouched };
  }

  if (result.kind === "failed") return { status: "failed", summary: result.message, filesTouched };
  if (result.kind === "turn_limit") return { status: "stopped", summary: "turn limit reached", filesTouched };
  const produced = [...result.base, ...result.messages];
  const submitted = terminalCallId
    ? produced.find((m) => m.role === "tool" && m.toolCallId === terminalCallId)?.content ?? ""
    : "";
  const text = produced
    .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "")
    .map((m) => (m as { content: string }).content)
    .join("\n")
    .trim();
  return { status: "done", summary: submitted || text || "(no text returned)", filesTouched };
}
