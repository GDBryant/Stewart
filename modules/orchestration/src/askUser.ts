import type { AgentDef, RoleDef } from "@stewart/config";
import type { ChatEvent, ManagedChannel } from "@stewart/channels";
import { costOfCall } from "@stewart/ledger";
import { isCosting } from "@stewart/models";
import type { RunRuntime, TaskResult } from "@stewart/run-contract";
import { questionPrompt } from "@stewart/interaction";
import { NO_ANSWER } from "./prompts.js";
import { buildRolePrompt } from "./roleRunner.js";

export interface AskUserHost {
  readonly rt: RunRuntime;
  readonly channel: ManagedChannel;
  readonly agent: AgentDef;
  readonly orchestrator: RoleDef;
  readonly userText: string;
  readonly results: Map<string, TaskResult>;
}

export interface AskUserRequest {
  readonly roleId: string;
  readonly taskId: string;
  readonly question: string;
  readonly options?: string[];
}

export async function answerNestedAskUser(host: AskUserHost, req: AskUserRequest): Promise<string> {
  const rt = host.rt;
  const qId = rt.ids.next("q");
  const self = await selfAnswer(host, req, qId);
  if (self !== null) return self;
  const o = await rt.prompt(questionPrompt("ask_user", req.question, req.options), { roleId: req.roleId, taskId: req.taskId });
  if (o.kind !== "answered") return NO_ANSWER;
  rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId: req.taskId, roleId: req.roleId, questionId: qId, answer: o.value, answeredBy: "user" });
  return o.value;
}

async function selfAnswer(host: AskUserHost, req: AskUserRequest, qId: string): Promise<string | null> {
  const rt = host.rt;
  if (host.channel.unhealthy || (rt.cost.reached() && isCosting(host.agent))) return null;
  try {
    const { text, delegated } = await askOrchestrator(host, req);
    const trimmed = text.trim();
    if (!delegated && trimmed && !trimmed.includes("DELEGATE_TO_USER")) {
      rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId: req.taskId, roleId: req.roleId, questionId: qId, answer: trimmed, answeredBy: "orchestrator" });
      return trimmed;
    }
  } catch {
    /* fall through to user */
  }
  return null;
}

function orchestratorPrompt(host: AskUserHost, req: AskUserRequest): string {
  const prior = [...host.results.entries()].map(([id, r]) => `${id}: ${r.summary}`).join("\n");
  return [
    `User request: ${host.userText}`,
    prior ? `Completed tasks:\n${prior}` : "",
    `Role '${req.roleId}' asks: ${req.question}${req.options?.length ? ` (options: ${req.options.join(", ")})` : ""}`,
    "If the user request, plan, or completed tasks already answer this, reply with the direct answer. Otherwise reply with DELEGATE_TO_USER.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function recordOrchestratorCost(host: AskUserHost, ev: Extract<ChatEvent, { kind: "done" }>): Promise<void> {
  const rt = host.rt;
  const costUsd = costOfCall(host.agent, ev.usage, ev.costUsd);
  await rt.ledger.record({
    runId: rt.runId,
    roleId: host.orchestrator.id,
    agentId: host.agent.id,
    model: host.agent.model,
    billing: host.agent.billing ?? "reported",
    inTokens: ev.usage?.in ?? 0,
    outTokens: ev.usage?.out ?? 0,
    costUsd,
  });
  rt.cost.accrued += costUsd;
}

async function askOrchestrator(host: AskUserHost, req: AskUserRequest): Promise<{ text: string; delegated: boolean }> {
  const rt = host.rt;
  const acc = { text: "", delegated: false };
  const handlers: { [K in ChatEvent["kind"]]: (ev: Extract<ChatEvent, { kind: K }>) => void | Promise<void> } = {
    text: (ev) => {
      acc.text += ev.text;
    },
    reasoning: () => {},
    tool_calls: (ev) => {
      if (ev.calls.some((c) => c.name === "ask_user")) acc.delegated = true;
    },
    done: (ev) => recordOrchestratorCost(host, ev),
  };
  for await (const ev of host.channel.chat({
    model: host.agent.model,
    messages: [
      { role: "system", content: await buildRolePrompt(rt, host.orchestrator) },
      { role: "user", content: orchestratorPrompt(host, req) },
    ],
    signal: rt.signal,
  })) {
    await (handlers[ev.kind] as (e: ChatEvent) => void | Promise<void>)(ev);
  }
  return acc;
}
