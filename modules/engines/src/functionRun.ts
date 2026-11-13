import type { Json } from "@stewart/kernel";
import { ChannelError } from "@stewart/channels";
import { validateArgs } from "@stewart/tools";
import type { CompleteRequest, CompleteResult } from "./types.js";

export type FunctionRequest = CompleteRequest;
export type FunctionResult = CompleteResult;

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
async function chatOnce(req: FunctionRequest, responseSchema: unknown): Promise<{ text: string; usage?: { in: number; out: number }; costUsd?: number }> {
  let text = "";
  let usage: { in: number; out: number } | undefined;
  let costUsd: number | undefined;
  const messages = [
    { role: "system" as const, content: systemText(req) },
    { role: "user" as const, content: req.input },
  ];
  for await (const ev of req.channel.chat({ model: req.agent.model, messages, responseSchema, signal: req.signal })) {
    if (ev.kind === "text") text += ev.text;
    else if (ev.kind === "done") ({ usage, costUsd } = ev);
  }
  return { text, usage, costUsd };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The request, retried once without responseSchema when the provider rejects the format field (4xx). */
async function chatOutcome(req: FunctionRequest): Promise<{ text: string; usage?: { in: number; out: number }; costUsd?: number; error?: string }> {
  try {
    return await chatOnce(req, req.schema);
  } catch (e) {
    if (!(e instanceof ChannelError && e.status !== undefined && e.status >= 400 && e.status < 500)) return { text: "", error: errText(e) };
    try {
      return await chatOnce(req, undefined);
    } catch (e2) {
      return { text: "", error: errText(e2) };
    }
  }
}

export async function runFunction(req: FunctionRequest): Promise<FunctionResult> {
  const r = await chatOutcome(req);
  if (r.error !== undefined) return { ok: false, error: r.error };
  const parsed = parseObject(r.text);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const bad = validateArgs(parsed, req.schema, "function reply");
  return bad ? { ok: false, error: bad } : { ok: true, value: parsed, usage: r.usage, costUsd: r.costUsd };
}
