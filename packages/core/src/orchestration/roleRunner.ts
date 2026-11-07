import type { AgentDef, RoleDef } from "../config/schema.js";
import type { ChatMessage } from "@stewart/kernel";
import { DEFAULT_CAPS } from "../channels/types.js";
import { composeRolePrompt } from "../skills/skills.js";
import { agentServesRole, roleRegistry } from "../roles.js";
import { DEFAULT_BUDGET_PROFILES } from "../limits.js";
import { projectTools } from "../tools/builtins.js";
import { ProjectPaths } from "../tools/projectPaths.js";
import { RunCancelledError, type ApprovalDecision, type LoopResult } from "../tools/toolLoop.js";
import { renderForSummary, SUMMARY_INSTRUCTIONS } from "@stewart/compaction";
import { createAgentSession } from "../agentSession.js";
import type { ToolCall } from "@stewart/kernel";
import type { ToolPreview } from "../tools/types.js";
import { classifyFault, type FaultKind } from "./faults.js";
import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/types.js";
import { costOfCall, isCosting } from "./ledger.js";
import { leasedTools, LeaseCycleError } from "./writeGuard.js";
import { loadProjectContext } from "../projectContext.js";
import type { OrchestrationRuntime } from "./types.js";
import type { TaskSpec } from "@stewart/scheduling";

export interface TaskResult {
  status: "done" | "failed" | "cancelled" | "parked" | "stopped";
  summary: string;
  filesTouched: string[];
  evidence?: string;
  cycleVictim?: string;
  cycleHolder?: string;
  /** Recoverable fault when the run ended on one; absent otherwise. */
  fault?: FaultKind;
  /** Full transcript (input + produced) for continuations and recovery briefs. */
  transcript?: ChatMessage[];
  /** Resolved model-turn budget, set on turn_limit results. */
  turnBudget?: number;
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
  deps: {
    role: RoleDef;
    nestedTools?: Tool[];
    depSummaries?: string[];
    /** Continuation transcript; replaces the freshly built briefing. */
    history?: ChatMessage[];
    /** Idempotency index offset for continuations (calls already in `history`). */
    idemOffset?: number;
    /** Extra briefing lines appended to the task brief (size hints, sub-task instructions). */
    extraBriefing?: string;
    /** Approval gate override (e.g. scratch-dir auto-approve); defaults to rt.approve. */
    approve?(call: ToolCall, preview: ToolPreview | null, meta: { roleId: string; taskId: string }): Promise<ApprovalDecision>;
    /** Agent override (direct runs use the chat-selected agent); defaults to the role's bound agent. */
    agent?: AgentDef;
    /** System prompt override; defaults to `buildRolePrompt`. */
    prompt?: string;
  },
): Promise<TaskResult> {
  const { role } = deps;
  const agentId = rt.roleAgentOverrides?.get(role.id) ?? role.agent;
  let agent = deps.agent ?? rt.config.agents.find((a) => a.id === agentId);
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

  const prompt = deps.prompt ?? (await buildRolePrompt(rt, role));
  const terminal = new Set([...TERMINAL].filter((t) => registry.find(t)));
  const filesTouched: string[] = [];
  let terminalCallId: string | undefined;

  const activeAgent = agent;
  const { summarize, prune } = compactionFor(rt, spec.id);
  const session = createAgentSession(
    {
      agent: activeAgent,
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
          if (WRITE_TOOLS.has(call.name) && typeof call.arguments.path === "string") filesTouched.push(call.arguments.path);
          if (TERMINAL.has(call.name)) terminalCallId = call.id;
        },
      },
    },
    rt.clock,
  );

  const briefingParts = [spec.task];
  if (spec.files.length) briefingParts.push(`Files: ${spec.files.join(", ")}`);
  if (spec.expect) briefingParts.push(`Expect: ${spec.expect}`);
  if (deps.extraBriefing) briefingParts.push(deps.extraBriefing);
  if (deps.depSummaries?.length) briefingParts.push(`Prior results:\n${deps.depSummaries.join("\n")}`);
  const messages: ChatMessage[] = deps.history ?? [{ role: "user", content: briefingParts.join("\n\n") }];

  let result: LoopResult;
  try {
    result = await session.loop.run(activeAgent.model, messages, session.listener, rt.signal);
  } catch (e) {
    if (e instanceof LeaseCycleError) {
      return { status: "cancelled", summary: e.message, filesTouched, cycleVictim: e.victim, cycleHolder: e.holder };
    }
    if (e instanceof RunCancelledError) return { status: "cancelled", summary: "cancelled", filesTouched, transcript: e.transcript };
    if (rt.signal.aborted) return { status: "cancelled", summary: "cancelled", filesTouched };
    return { status: "failed", summary: e instanceof Error ? e.message : String(e), filesTouched };
  }

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
      turnBudget: session.limits.maxModelTurns,
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
export function compactionFor(rt: OrchestrationRuntime, taskId?: string): { prune: boolean; summarize?: (middle: ChatMessage[]) => Promise<string> } {
  const c = rt.config.settings.compaction;
  return { prune: !!c?.prune, summarize: c?.summarize ? compactorFor(rt, taskId) : undefined };
}

/**
 * Summarizer bound to the enabled `compactor` role's agent; undefined (prune/clip only) when no such
 * role or agent exists. Calls are metered to the ledger under role `compactor`.
 */
export function compactorFor(rt: OrchestrationRuntime, taskId?: string): ((middle: ChatMessage[]) => Promise<string>) | undefined {
  const role = rt.config.roles.find((r) => r.id === "compactor" && r.enabled);
  const agent = role && rt.config.agents.find((a) => a.id === role.agent);
  if (!agent) return undefined;
  const channel = rt.channelFor(agent.channel);
  if (channel.unhealthy) return undefined;
  return async (middle) => {
    if (rt.cost.reached() && isCosting(agent)) return "";
    let text = "";
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_INSTRUCTIONS },
      { role: "user", content: renderForSummary(middle) },
    ];
    for await (const ev of channel.chat({ model: agent.model, messages, signal: rt.signal })) {
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "done") {
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
    }
    return text;
  };
}
