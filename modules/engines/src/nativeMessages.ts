import type { ChatMessage } from "@stewart/kernel";

const CALL_CAP = 200;
const RESULT_CAP = 500;

type AssistantMsg = Extract<ChatMessage, { role: "assistant" }>;

function callLine(msg: AssistantMsg, results: Map<string, string>): string {
  const lines = (msg.toolCalls ?? []).map((c) => {
    const args = JSON.stringify(c.arguments ?? {}).slice(0, CALL_CAP);
    return `[${c.name} ${args}] → ${(results.get(c.id) ?? "").slice(0, RESULT_CAP)}`;
  });
  return [msg.content, ...lines].filter(Boolean).join("\n");
}

function foreignIds(transcript: ChatMessage[], toolNames: Set<string>): Set<string> {
  const calls = transcript.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
  return new Set(calls.filter((c) => !toolNames.has(c.name)).map((c) => c.id));
}

function render(m: ChatMessage, foreign: Set<string>, results: Map<string, string>): ChatMessage[] {
  if (m.role === "tool" && m.toolCallId && foreign.has(m.toolCallId)) return [];
  if (m.role === "assistant" && m.toolCalls?.some((c) => foreign.has(c.id))) {
    return [{ role: "assistant", content: callLine(m, results) }];
  }
  return [m];
}

/**
 * Request messages for the provider, transcript untouched: an assistant message whose calls name tools
 * outside the current registry (made by another engine) flattens to plain text, and its tool messages drop.
 */
export function forNative(transcript: ChatMessage[], toolNames: Set<string>): ChatMessage[] {
  const foreign = foreignIds(transcript, toolNames);
  if (!foreign.size) return transcript;
  const results = new Map(transcript.filter((m) => m.role === "tool").map((m) => [(m as { toolCallId: string }).toolCallId, m.content]));
  return transcript.flatMap((m) => render(m, foreign, results));
}
