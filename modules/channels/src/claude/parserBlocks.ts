export type ClaudeRawCall = { id: string | null; name: string; argumentsJson: string };

export type ClaudeEvent =
  | { t: "text"; text: string }
  | { t: "reasoning"; text: string }
  | { t: "calls"; calls: ClaudeRawCall[] }
  | { t: "failed"; message: string; code: string };

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** State a tool_use block records into; supplied by ClaudeStreamParser. */
export type ToolBlockCtx = {
  readonly seenToolUseIds: Set<string>;
  readonly nativeCalls: ClaudeRawCall[];
  setToolMessageId(id: string | undefined): void;
  failed(message: string, code: string): ClaudeEvent;
};

export function toolBlock(block: Obj | undefined, message: Obj, ctx: ToolBlockCtx): ClaudeEvent[] | null {
  if (!block) return null;
  const handlers: Record<string, (b: Obj) => ClaudeEvent[] | null> = {
    server_tool_use: (b) =>
      str(b.name) !== "advisor" ? [ctx.failed("CLI invoked a server tool", "isolation_violation")] : null,
    tool_use: (b) => {
      const name = str(b.name);
      const callId = str(b.id) ?? null;
      if (name && (callId === null || !ctx.seenToolUseIds.has(callId))) {
        if (callId !== null) ctx.seenToolUseIds.add(callId);
        ctx.setToolMessageId(str(message.id));
        ctx.nativeCalls.push({ id: callId, name, argumentsJson: JSON.stringify(b.input ?? {}) });
      }
      return null;
    },
  };
  const h = handlers[str(block.type) ?? ""];
  return h ? h(block) : null;
}

export function textBlock(block: Obj | undefined): ClaudeEvent | null {
  if (!block) return null;
  const handlers: Record<string, (b: Obj) => ClaudeEvent | null> = {
    text: (b) => {
      const text = str(b.text);
      return text ? { t: "text", text } : null;
    },
    thinking: (b) => {
      const text = str(b.thinking);
      return text ? { t: "reasoning", text } : null;
    },
  };
  const h = handlers[str(block.type) ?? ""];
  return h ? h(block) : null;
}
