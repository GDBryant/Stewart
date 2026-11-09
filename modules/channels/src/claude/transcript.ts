import type { ChatMessage } from "@stewart/kernel";

export type ClaudeImage = { base64: string; mediaType: string };

export function parseImage(raw: string): ClaudeImage {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
  if (m) return { mediaType: m[1], base64: m[2] };
  return { mediaType: "image/png", base64: raw };
}

export interface ClaudeInput {
  system: string;
  text: string;
  images: ClaudeImage[];
  hasImages: boolean;
  /** One stream-json user line (no trailing newline). */
  streamJsonLine(): string;
  /** Log-safe outgoing text: prompt plus image placeholders, never base64. */
  logText(): string;
}

/** Argv for the CLI; stream-json input is only requested when images are sent. */
export function argv(cliPath: string, model: string, promptFile: string, streamJsonInput: boolean): string[] {
  return [
    cliPath,
    "-p",
    ...(streamJsonInput ? ["--input-format", "stream-json"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--model",
    model,
    "--system-prompt-file",
    promptFile,
  ];
}

/**
 * Only the last user message's images become blocks; earlier-turn images degrade to
 * `[image: name]` text so stdin stays a single message.
 */
export function prepare(messages: ChatMessage[]): ClaudeInput {
  const lastUser = messages.map((m, i) => (m.role === "user" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const flattened = messages.map((m, i) => {
    if (m.role !== "user" || !m.images?.length || i === lastUser) return m;
    return {
      ...m,
      content: [m.content, ...m.images.map((_, j) => `[image: image-${j + 1}]`)].filter(Boolean).join("\n"),
      images: undefined,
    };
  });
  const [system, text] = render(flattened);
  const images = ((lastUser >= 0 ? messages[lastUser] : undefined) as { images?: string[] } | undefined)?.images?.map(parseImage) ?? [];
  return {
    system,
    text,
    images,
    hasImages: images.length > 0,
    streamJsonLine() {
      const content: unknown[] = [];
      if (text.trim()) content.push({ type: "text", text });
      for (const img of images) {
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
      }
      return JSON.stringify({ type: "user", message: { role: "user", content } });
    },
    logText() {
      return [text, ...images.map((_, i) => `[image: image-${i + 1}]`)].join("\n");
    },
  };
}

function renderMessage(msg: ChatMessage, callNames: Map<string, string>): string {
  const tag = msg.role === "assistant" ? "assistant" : msg.role === "tool" ? "tool_result" : "user";
  let body = `\n\n<${tag}`;
  if (msg.role === "tool") {
    const n = callNames.get(msg.toolCallId);
    if (n) body += ` tool="${n}"`;
  }
  body += `>\n${msg.content}`;
  if (msg.role === "assistant") {
    for (const call of msg.toolCalls ?? []) {
      callNames.set(call.id, call.name);
      body += `\n[called tool ${call.name} with arguments ${JSON.stringify(call.arguments)}]`;
    }
  }
  return `${body}\n</${tag}>`;
}

export function render(messages: ChatMessage[]): [string, string] {
  const system =
    messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n") || "You are a helpful assistant.";
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length === 1 && rest[0].role === "user") return [system, rest[0].content];
  let body = "The conversation so far is below. Reply as the assistant to the last user message.";
  // Raw tool history (e.g. from another provider) is rendered as neutral notes, not as a callable format.
  const callNames = new Map<string, string>();
  for (const msg of rest) body += renderMessage(msg, callNames);
  return [system, body];
}
