import type { ChannelAdapter, ChannelConfig, ChannelDeps, ChatEvent, ChatRequest, ToolCall } from "./types.js";
import type { Fetcher } from "../ports.js";
import { ChannelError } from "./types.js";
import { lines } from "./stream.js";

function url(cfg: ChannelConfig, path: string): string {
  return (cfg.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "") + path;
}

/** v1 extractError: JSON `error` string wins; JSON with non-string error falls back to raw body; empty falls back to status text. */
export function extractError(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
    return body;
  } catch {
    return body;
  }
}

/** Ollama channel: NDJSON streaming, /api/tags + /api/show probes. */
export class OllamaAdapter implements ChannelAdapter {
  readonly type = "ollama";
  constructor(private deps: ChannelDeps) {}

  async listModels(cfg: ChannelConfig): Promise<string[]> {
    const r = await this.deps.fetcher(url(cfg, "/api/tags"), {});
    if (r.status !== 200) throw new ChannelError(`GET /api/tags → ${r.status}`, r.status);
    const text = await new Response(r.body).text();
    const names = (JSON.parse(text).models ?? []).map((m: { name: string }) => m.name) as string[];
    return [...new Set([...names, ...(cfg.extraModels ?? [])])];
  }

  async probeCaps(cfg: ChannelConfig, _secret: string | undefined, model: string): Promise<Partial<import("./types.js").ModelCaps>> {
    const r = await this.deps.fetcher(url(cfg, "/api/show"), { method: "POST", body: JSON.stringify({ model }) });
    if (r.status !== 200) throw new ChannelError(`POST /api/show → ${r.status}`, r.status);
    const info = JSON.parse(await new Response(r.body).text());
    const caps: string[] = info.capabilities ?? [];
    return {
      tools: caps.includes("tools") ? "native" : "shim",
      vision: caps.includes("vision"),
      reasoning: caps.includes("thinking"),
      contextTokens: info.model_info?.["general.context_length"] ?? undefined,
    };
  }

  async *chat(cfg: ChannelConfig, _secret: string | undefined, req: ChatRequest): AsyncIterable<ChatEvent> {
    const tools = req.tools?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    const messages = req.messages.map((m) => {
      if (m.role === "tool") return { role: "tool", content: m.content };
      if (m.role === "assistant") {
        return { role: "assistant", content: m.content, tool_calls: m.toolCalls?.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) };
      }
      return { role: m.role, content: m.content, images: m.images };
    });
    const dbg = this.deps.debug;
    const numCtx = cfg.modelCaps?.[req.model]?.numCtx;
    const body = JSON.stringify({
      model: req.model,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
      options: { temperature: req.temperature, num_ctx: numCtx },
    });
    dbg?.record({ direction: "outgoing", provider: this.type, model: req.model, payload: `num_ctx=${numCtx ?? "default"} ${body}` });
    let r: Awaited<ReturnType<Fetcher>>;
    try {
      r = await this.deps.fetcher(url(cfg, "/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, signal: req.signal, body });
    } catch (e) {
      dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: `connection failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
    if (r.status !== 200) {
      const text = await new Response(r.body).text();
      dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: `HTTP ${r.status}: ${text}` });
      if (r.status === 429) throw new ChannelError("rate limited", 429, Number(r.headers["retry-after"] ?? 1) * 1000);
      throw new ChannelError(extractError(text, `POST /api/chat → ${r.status}`), r.status); // v1: extractError
    }
    if (!r.body) throw new ChannelError("empty response body");

    const calls: ToolCall[] = [];
    let usage: { in: number; out: number } | undefined;
    let truncated = false;
    let sawDone = false;
    try {
      for await (const line of lines(r.body, req.signal, this.deps.stallTimeoutMs ?? 60_000)) {
        dbg?.record({ direction: "incoming", provider: this.type, model: req.model, payload: line });
        let j: {
          error?: unknown;
          message?: unknown;
          done?: unknown;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          j = JSON.parse(line);
        } catch {
          throw new ChannelError(`malformed NDJSON line: ${line.slice(0, 80)}`); // v1: malformed → Failed
        }
        if (j.error !== undefined) throw new ChannelError(String(j.error));
        const m = j.message as { content?: unknown; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[] } | null | undefined;
        if (m !== undefined && m !== null && typeof m !== "object") throw new ChannelError("invalid message field");
        if (typeof m?.content === "string" && m.content) yield { kind: "text", text: m.content };
        if (m?.thinking) yield { kind: "reasoning", text: m.thinking };
        if (Array.isArray(m?.tool_calls)) {
          for (const tc of m.tool_calls) {
            calls.push({ id: tc.id ?? `call_${calls.length}`, name: tc.function.name, arguments: tc.function.arguments }); // v1: synthesised call_N ids
          }
        }
        if (j.done === true) {
          usage = { in: j.prompt_eval_count ?? 0, out: j.eval_count ?? 0 };
          truncated = j.done_reason === "length";
          sawDone = true;
          break;
        }
      }
    } catch (e) {
      dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (!sawDone && !req.signal.aborted) dbg?.record({ direction: "error", provider: this.type, model: req.model, payload: "stream ended before done" });
    if (calls.length) yield { kind: "tool_calls", calls };
    yield { kind: "done", usage, truncated };
  }
}
