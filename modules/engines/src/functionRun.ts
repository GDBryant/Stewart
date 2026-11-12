import type { AgentDef } from "@stewart/config";
import type { Json } from "@stewart/kernel";
import type { ManagedChannel } from "@stewart/channels";
import { validateArgs } from "@stewart/tools";

export interface FunctionRequest {
  channel: ManagedChannel;
  agent: AgentDef;
  /** Role prompt: what the function does. */
  system: string;
  /** The single input the function works on. */
  input: string;
  /** JSON Schema (object) the reply must satisfy. */
  schema: Json;
  signal: AbortSignal;
}

export type FunctionResult =
  | { ok: true; value: Json; usage?: { in: number; out: number }; costUsd?: number }
  | { ok: false; error: string };

const FENCED = /```(?:json)?\s*\n([\s\S]*?)```/;

/** Parse a reply as a JSON object: the whole text, a fenced block, or the outermost braces. */
function parseObject(text: string): Json | string {
  const body = text.trim();
  const candidates = [body, FENCED.exec(body)?.[1], body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Json;
    } catch {
      /* try the next candidate */
    }
  }
  return "reply is not a JSON object";
}

function systemText(req: FunctionRequest): string {
  return `${req.system}\n\nReply with exactly one JSON object and nothing else. It must satisfy this JSON Schema:\n${JSON.stringify(req.schema)}`;
}

/**
 * Function run path: one request, no tools, a schema-validated JSON object out.
 * For models that cannot act as agents (no reliable native tool calling) or for narrow one-shot work.
 */
export async function runFunction(req: FunctionRequest): Promise<FunctionResult> {
  let text = "";
  let usage: { in: number; out: number } | undefined;
  let costUsd: number | undefined;
  try {
    const messages = [
      { role: "system" as const, content: systemText(req) },
      { role: "user" as const, content: req.input },
    ];
    for await (const ev of req.channel.chat({ model: req.agent.model, messages, signal: req.signal })) {
      if (ev.kind === "text") text += ev.text;
      else if (ev.kind === "done") ({ usage, costUsd } = ev);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const parsed = parseObject(text);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const bad = validateArgs(parsed, req.schema, "function reply");
  return bad ? { ok: false, error: bad } : { ok: true, value: parsed, usage, costUsd };
}
