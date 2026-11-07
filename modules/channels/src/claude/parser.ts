export type ClaudeRawCall = { id: string | null; name: string; argumentsJson: string };

export type ClaudeEvent =
  | { t: "text"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "calls"; calls: ClaudeRawCall[] }
  | { t: "failed"; message: string; code: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

export function classify(message: string): string {
  if (/not logged in|log ?in|authenticat|oauth|unauthori[sz]ed|\b401\b|token.*expired/i.test(message)) return "auth";
  if (/issue with the selected model/i.test(message)) return "model_unavailable";
  if (/rate limit|\b429\b|usage limit/i.test(message)) return "rate_limited";
  return "cli_error";
}

export function mapStopReason(raw: string | undefined): string | undefined {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return raw;
  }
}

/** Port of v1 ClaudeStreamParser: stream-json lines → events + isolation policy. */
export class ClaudeStreamParser {
  readonly deltaMessageIds = new Set<string>();
  stopReason: string | undefined;
  resultSeen = false;
  resultIsError = false;
  usage: { in: number | undefined; out: number | undefined; costUsd: number | undefined } | undefined;
  finishReason: string | undefined;
  failedEmitted = false;
  /** The CLI's tool turn is over: stop reading and complete with `tool_calls`. */
  toolTurnEnded = false;
  /** The CLI rejected a surfaced tool_use; more tool_use blocks of the same message may still follow. */
  cutPending = false;
  readonly nativeCalls: ClaudeRawCall[] = [];
  private emittedNativeCalls = 0;
  private readonly seenToolUseIds = new Set<string>();
  private toolMessageId: string | undefined;
  /** Per-message stream usage: [input incl. cache, output]; repeated events for one id keep the max. */
  private readonly streamUsage = new Map<string, [number | undefined, number | undefined]>();

  /** `result` usage when present, else the sum over the turn's messages (each API call bills separately). */
  turnUsage(): { in?: number; out?: number; costUsd?: number } | undefined {
    if (this.usage) {
      return { in: this.usage.in, out: this.usage.out, costUsd: this.usage.costUsd };
    }
    if (this.streamUsage.size === 0) return undefined;
    const sum = (i: 0 | 1) => {
      const vs = [...this.streamUsage.values()].map((s) => s[i]).filter((v): v is number => v !== undefined);
      return vs.length ? vs.reduce((a, b) => a + b, 0) : undefined;
    };
    return { in: sum(0), out: sum(1) };
  }

  private recordUsage(o: Obj): void {
    let id: string | undefined;
    let u: unknown;
    const type = str(o.type);
    if (type === "assistant") {
      const m = obj(o.message);
      id = str(m?.id);
      u = m?.usage;
    } else if (type === "stream_event") {
      const event = obj(o.event);
      if (!event) return;
      if (event.type === "message_start") {
        id = this.eventMessageId(o);
        u = obj(event.message)?.usage;
      } else if (event.type === "message_delta") {
        id = this.eventMessageId(o);
        u = event.usage;
      } else {
        return;
      }
    } else {
      return;
    }
    const usage = obj(u);
    if (!usage) return;
    if (this.cutPending && id !== this.toolMessageId) return;
    const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map((k) => num(usage[k])).filter((v): v is number => v !== undefined);
    const slot = this.streamUsage.get(id ?? "") ?? [undefined, undefined] as [number | undefined, number | undefined];
    this.streamUsage.set(id ?? "", slot);
    // Counts are cumulative per message; max ignores stale snapshots in repeated assistant events.
    if (parts.length) slot[0] = Math.max(slot[0] ?? 0, parts.reduce((a, b) => a + b, 0));
    const out = num(usage.output_tokens);
    if (out !== undefined) slot[1] = Math.max(slot[1] ?? 0, out);
  }

  private failed(message: string, code: string): ClaudeEvent {
    this.failedEmitted = true;
    return { t: "failed", message, code };
  }

  feed(line: string): ClaudeEvent[] {
    if (this.resultSeen || this.toolTurnEnded) return [];
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return [];
    }
    const j = obj(o);
    if (!j) return [];
    this.recordUsage(j);
    if (this.cutPending && this.endsToolTurn(j)) {
      this.toolTurnEnded = true;
      this.finishReason = "tool_calls";
      return [];
    }
    switch (str(j.type)) {
      case "system":
        return this.systemEvent(j);
      case "stream_event":
        return this.streamEvent(j);
      case "assistant":
        return this.assistantEvent(j);
      case "user":
        return this.userEvent(j);
      case "result":
        return this.resultEvent(j);
      default:
        return [];
    }
  }

  /** After a rejected tool_use: the tool message is over once it stops or another message begins. */
  private endsToolTurn(o: Obj): boolean {
    switch (str(o.type)) {
      case "assistant":
        return str(obj(o.message)?.id) !== this.toolMessageId;
      case "stream_event": {
        const event = obj(o.event);
        const et = str(event?.type);
        if (et === "message_start" || et === "message_delta" || et === "message_stop") return true;
        const id = this.eventMessageId(o);
        return id !== undefined && id !== this.toolMessageId;
      }
      default:
        return false;
    }
  }

  private nonemptyArray(v: unknown): boolean {
    return Array.isArray(v) && v.length > 0;
  }

  private systemEvent(o: Obj): ClaudeEvent[] {
    if (str(o.subtype) !== "init") return [];
    if (this.nonemptyArray(o.tools) || this.nonemptyArray(o.mcp_servers)) {
      return [this.failed("CLI advertised tools or MCP servers", "isolation_violation")];
    }
    return [];
  }

  private streamEvent(o: Obj): ClaudeEvent[] {
    const event = obj(o.event);
    if (!event) return [];
    switch (str(event.type)) {
      case "content_block_delta": {
        const delta = obj(event.delta);
        if (!delta) return [];
        if (delta.type === "text_delta") {
          const mid = this.eventMessageId(o);
          if (mid) this.deltaMessageIds.add(mid);
          const text = str(delta.text);
          return text ? [{ t: "text", text }] : [];
        }
        if (delta.type === "thinking_delta") {
          const mid = this.eventMessageId(o);
          if (mid) this.deltaMessageIds.add(mid);
          const text = str(delta.thinking);
          return text ? [{ t: "reasoning", text }] : [];
        }
        return [];
      }
      case "content_block_start": {
        const block = obj(event.content_block);
        if (block?.type === "server_tool_use" && str(block.name) !== "advisor") {
          return [this.failed("CLI invoked a server tool", "isolation_violation")];
        }
        return [];
      }
      case "message_delta": {
        const sr = str(obj(event.delta)?.stop_reason);
        if (sr) this.stopReason = sr;
        return [];
      }
      default:
        return [];
    }
  }

  private eventMessageId(o: Obj): string | undefined {
    return str(obj(obj(o.event)?.message)?.id) ?? str(o.api_message_id);
  }

  private assistantEvent(o: Obj): ClaudeEvent[] {
    const message = obj(o.message);
    if (!message) return [];
    const out: ClaudeEvent[] = [];
    const blocks = arr(message.content) ?? [];
    for (const b of blocks) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === "server_tool_use") {
        if (str(block.name) !== "advisor") return [this.failed("CLI invoked a server tool", "isolation_violation")];
      } else if (block.type === "tool_use") {
        const name = str(block.name);
        const callId = str(block.id) ?? null;
        if (name && (callId === null || !this.seenToolUseIds.has(callId))) {
          if (callId !== null) this.seenToolUseIds.add(callId);
          this.toolMessageId = str(message.id);
          this.nativeCalls.push({ id: callId, name, argumentsJson: JSON.stringify(block.input ?? {}) });
        }
      }
    }
    const id = str(message.id);
    if (id === undefined || !this.deltaMessageIds.has(id)) {
      for (const b of blocks) {
        const block = obj(b);
        if (!block) continue;
        if (block.type === "text") {
          const text = str(block.text);
          if (text) out.push({ t: "text", text });
        } else if (block.type === "thinking") {
          const text = str(block.thinking);
          if (text) out.push({ t: "reasoning", text });
        }
      }
    }
    if (this.nativeCalls.length > this.emittedNativeCalls) {
      out.push({ t: "calls", calls: this.nativeCalls.slice(this.emittedNativeCalls) });
      this.emittedNativeCalls = this.nativeCalls.length;
    }
    return out;
  }

  private userEvent(o: Obj): ClaudeEvent[] {
    const content = obj(o.message)?.content;
    const blocks = arr(content);
    if (!blocks) return [];
    let hasToolResult = false;
    for (const b of blocks) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === "tool_result") {
        if (block.is_error !== true) return [this.failed("CLI executed a tool", "isolation_violation")];
        hasToolResult = true;
      }
    }
    if (hasToolResult && this.nativeCalls.length > 0) {
      this.cutPending = true;
      this.finishReason = "tool_calls";
    }
    return [];
  }

  private resultEvent(o: Obj): ClaudeEvent[] {
    this.resultSeen = true;
    if (o.is_error === true) {
      this.resultIsError = true;
      const message = str(o.result) ?? "Claude CLI error";
      return [this.failed(message, classify(message))];
    }
    const fr = mapStopReason(this.stopReason ?? str(o.stop_reason));
    this.finishReason = this.nativeCalls.length > 0 ? "tool_calls" : fr;
    const u = obj(o.usage);
    if (u) {
      this.usage = {
        in:
          (num(u.input_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0),
        out: num(u.output_tokens),
        costUsd: num(o.total_cost_usd),
      };
    }
    return [];
  }
}
