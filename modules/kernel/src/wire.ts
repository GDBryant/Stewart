/** Wire types shared by every layer: tool calls, chat messages, tool specs. */
export type Json = Record<string, unknown>;

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ChatMessage =
  | { role: "system" | "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  parameters: Json;
}

/**
 * v1 ImageStripping: non-vision models get `[image: name]` placeholders at
 * request time; the stored transcript keeps the real attachments.
 */
export function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || !m.images?.length) return m;
    const placeholders = m.images.map((_, i) => `[image: image-${i + 1}]`);
    return {
      ...m,
      content: [m.content, ...placeholders].filter(Boolean).join("\n"),
      images: undefined,
    };
  });
}
