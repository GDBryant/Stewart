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
