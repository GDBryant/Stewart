import type { RoleDef } from "../config/schema.js";
import type { ChatMessage } from "../channels/types.js";
import { DEFAULT_CAPS } from "../channels/types.js";
import { composeRolePrompt } from "../skills/skills.js";
import { roleRegistry, roleTurnBudget } from "../roles.js";
import { projectTools } from "../tools/builtins.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { DEFAULT_LIMITS, RunCancelledError, ToolLoop, type LoopResult, type ToolsMode } from "../tools/toolLoop.js";
import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/types.js";
import { costOfCall } from "./ledger.js";
import { leasedTools, LeaseCycleError } from "./writeGuard.js";
import type { OrchestrationRuntime } from "./types.js";
import type { TaskSpec } from "./tasks.js";

export interface TaskResult {
  status: "done" | "failed" | "cancelled" | "parked" | "stopped";
  summary: string;
  filesTouched: string[];
  evidence?: string;
}

const WRITE_TOOLS = new Set(["WriteFile", "EditFile", "ApplyPatch"]);
const TERMINAL = new Set(["submit_plan", "submit_verdict", "submit_replacements"]);
const AGENTS_MD_LIMIT = 4000;

/** Deterministic prefix order: role prompt + skills, bounded AGENTS.md, then the briefing. */
export async function buildRolePrompt(rt: OrchestrationRuntime, role: RoleDef): Promise<string> {
  const { prompt } = composeRolePrompt(role, rt.config.skills, rt.skillBudgetTokens);
  let agents = "";
  try {
    if (await rt.host.files.exists("AGENTS.md")) {
      const md = (await rt.host.files.read("AGENTS.md")).content;
      agents = `\n\n# Project instructions (AGENTS.md)\n${md.slice(0, AGENTS_MD_LIMIT)}`;
    }
  } catch {
    /* no AGENTS.md is fine */
  }
  return `${prompt}${agents}`;
}

/**
 * Run one dispatched task under its role's constraints: fresh context, role tool
 * filter, writePaths + leases, turn budget, idempotent tool calls, ledger cost.
 */
export async function runRoleTask(
  rt: OrchestrationRuntime,
  spec: TaskSpec,
  deps: { role: RoleDef; nestedTools?: Tool[] },
): Promise<TaskResult> {
  const { role } = deps;
  const agent = rt.config.agents.find((a) => a.id === role.agent);
  if (!agent) return { status: "failed", summary: `role ${role.id}: enabled but no agent bound`, filesTouched: [] };
  if (rt.cost.reached() && agent.billing !== "free" && agent.billing !== "unmetered") {
    return { status: "parked", summary: `parked: cost limit reached`, filesTouched: [] };
  }
  const channel = rt.channelFor(agent.channel);
  const paths = await ProjectPaths.forProject(rt.host);
  const extra = deps.nestedTools ?? [];
  const base = roleRegistry(new ToolRegistry([...projectTools(rt.host, paths).tools, ...extra]), role);
  const registry = new ToolRegistry(
    leasedTools(base.tools, {
      host: rt.host,
      leases: rt.leases,
      taskId: spec.id,
      runId: rt.runId,
      leaseWaitMs: rt.leaseWaitMs,
      stateDir: rt.stateDir,
      onWait: (path, holder) => rt.bus.emit({ kind: "task.blocked", runId: rt.runId, taskId: spec.id, roleId: role.id, waitingOn: holder }),
    }),
  );

  const prompt = await buildRolePrompt(rt, role);
  const mode: ToolsMode = (channel.cfg.modelCaps?.[agent.model]?.tools ?? DEFAULT_CAPS.tools) as ToolsMode;
  const limits = { ...DEFAULT_LIMITS, maxModelTurns: roleTurnBudget(role) };
  const terminal = new Set([...TERMINAL].filter((t) => registry.find(t)));
  const filesTouched: string[] = [];
  let terminalCallId: string | undefined;

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

  const messages: ChatMessage[] = [{ role: "user", content: spec.task }];
  const listener = {
    onText: (t: string) => rt.bus.emit({ kind: "text_delta", runId: rt.runId, taskId: spec.id, roleId: role.id, seq: 0, text: t }),
    onReasoning: (t: string) => rt.bus.emit({ kind: "reasoning_delta", runId: rt.runId, taskId: spec.id, roleId: role.id, seq: 0, text: t }),
    onToolRequested: (call: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (WRITE_TOOLS.has(call.name) && typeof call.arguments.path === "string") filesTouched.push(call.arguments.path);
      if (TERMINAL.has(call.name)) terminalCallId = call.id;
      rt.bus.emit({ kind: "tool.request", runId: rt.runId, taskId: spec.id, roleId: role.id, callId: call.id, tool: call.name, args: call.arguments, category: call.name });
    },
    onToolOutcome: (call: { id: string; name: string }, outcome: { kind: string }) => {
      rt.bus.emit({ kind: "tool.outcome", runId: rt.runId, taskId: spec.id, roleId: role.id, callId: call.id, ok: outcome.kind === "success", summary: outcome.kind });
    },
    onUsage: (usage: { in: number; out: number } | undefined, reported: number | undefined) => {
      const costUsd = costOfCall(agent, usage, reported);
      rt.cost.accrued = rt.cost.accrued + costUsd;
      void rt.ledger.record({
        runId: rt.runId,
        taskId: spec.id,
        roleId: role.id,
        agentId: agent.id,
        model: agent.model,
        billing: agent.billing ?? "reported",
        inTokens: usage?.in ?? 0,
        outTokens: usage?.out ?? 0,
        costUsd,
      });
    },
  };

  let result: LoopResult;
  try {
    result = await loop.run(agent.model, messages, listener, rt.signal);
  } catch (e) {
    if (e instanceof LeaseCycleError) return { status: "cancelled", summary: e.message, filesTouched };
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
