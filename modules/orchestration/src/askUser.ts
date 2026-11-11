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

export async function answerNestedAskUser(host: AskUserHost, roleId: string, taskId: string, question: string, options?: string[]): Promise<string> {
  const rt = host.rt;
  const qId = rt.ids.next("q");
  const self = await selfAnswer(host, question, options, qId, roleId, taskId);
  if (self !== null) return self;
  const o = await rt.prompt(questionPrompt("ask_user", question, options), { roleId, taskId });
  if (o.kind !== "answered") return NO_ANSWER;
  rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId, roleId, questionId: qId, answer: o.value, answeredBy: "user" });
  return o.value;
}

async function selfAnswer(host: AskUserHost, question: string, options: string[] | undefined, qId: string, roleId: string, taskId: string): Promise<string | null> {
  const rt = host.rt;
  if (host.channel.unhealthy || (rt.cost.reached() && isCosting(host.agent))) return null;
  try {
    const { text, delegated } = await askOrchestrator(host, question, options, roleId);
    const trimmed = text.trim();
    if (!delegated && trimmed && !trimmed.includes("DELEGATE_TO_USER")) {
      rt.bus.emit({ kind: "question.answered", runId: rt.runId, taskId, roleId, questionId: qId, answer: trimmed, answeredBy: "orchestrator" });
      return trimmed;
    }
  } catch {
    /* fall through to user */
  }
  return null;
}

async function askOrchestrator(host: AskUserHost, question: string, options: string[] | undefined, roleId: string): Promise<{ text: string; delegated: boolean }> {
  const rt = host.rt;
  const prior = [...host.results.entries()].map(([id, r]) => `${id}: ${r.summary}`).join("\n");
  const promptText = [
    `User request: ${host.userText}`,
    prior ? `Completed tasks:\n${prior}` : "",
    `Role '${roleId}' asks: ${question}${options?.length ? ` (options: ${options.join(", ")})` : ""}`,
    "If the user request, plan, or completed tasks already answer this, reply with the direct answer. Otherwise reply with DELEGATE_TO_USER.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const acc = { text: "", delegated: false };
  const handlers: { [K in ChatEvent["kind"]]: (ev: Extract<ChatEvent, { kind: K }>) => void | Promise<void> } = {
    text: (ev) => {
      acc.text += ev.text;
    },
    reasoning: () => {},
    tool_calls: (ev) => {
      if (ev.calls.some((c) => c.name === "ask_user")) acc.delegated = true;
    },
    done: async (ev) => {
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
    },
  };
  for await (const ev of host.channel.chat({
    model: host.agent.model,
    messages: [
      { role: "system", content: await buildRolePrompt(rt, host.orchestrator) },
      { role: "user", content: promptText },
    ],
    signal: rt.signal,
  })) {
    await (handlers[ev.kind] as (e: ChatEvent) => void | Promise<void>)(ev);
  }
  return acc;
}
