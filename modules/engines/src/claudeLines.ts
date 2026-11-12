import * as path from "node:path";
import type { ChatMessage } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import { normalizeModel } from "@stewart/catalog";
import type { EngineTurn } from "./types.js";

export const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RESULT_CAP = 2000;
const RECAP_MSGS = 6;
const RECAP_CAP = 4000;

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
export const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

function cliPath(turn: EngineTurn): string {
  return (turn.channel.cfg.cliPath as string | undefined) ?? "claude";
}

/** stream-json argv for one supervised CLI turn; `resume` = the stored CLI session id. */
export function claudeArgv(turn: EngineTurn, resume: string | undefined): string[] {
  const a = [
    cliPath(turn), "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--permission-prompt-tool", "stdio", "--include-partial-messages",
    "--model", normalizeModel(turn.agent.model),
  ];
  if (resume) a.push("--resume", resume);
  if (turn.system.trim()) a.push("--append-system-prompt", turn.system);
  if (turn.maxTurns > 0 && turn.maxTurns < 1_000_000) a.push("--max-turns", String(turn.maxTurns));
  return a;
}

function imageBlock(raw: string): Obj {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
  return { type: "image", source: { type: "base64", media_type: m?.[1] ?? "image/png", data: m?.[2] ?? raw } };
}

/** The one stdin line: the last transcript user message, images as base64 blocks. */
export function userLine(messages: ChatMessage[], prefix = ""): string {
  const last = [...messages].reverse().find((m) => m.role === "user") as { content: string; images?: string[] } | undefined;
  const text = prefix + (last?.content ?? "");
  const content: unknown[] = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const img of last?.images ?? []) content.push(imageBlock(img));
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

/** Path a CLI file tool reports, relativised to the project root for write records and previews. */
export function relPath(cwd: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
  return rel.replace(/\\/g, "/") || ".";
}

function filePreview(input: Obj, cwd: string): ToolPreview {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? "";
  const edits = arr(input.edits);
  const after =
    str(input.content) ?? str(input.new_string) ?? str(input.new_source) ??
    (edits ? JSON.stringify(edits) : "");
  return { kind: "file", path: relPath(cwd, p), before: str(input.old_string) ?? null, after };
}

/** Approval/tool.request preview for a CLI tool call. */
export function previewFor(name: string, input: Obj, cwd: string): ToolPreview | null {
  if (name === "Bash" && typeof input.command === "string") return { kind: "command", command: input.command, cwd: "." };
  if (FILE_TOOLS.has(name)) return filePreview(input, cwd);
  return { kind: "other", category: "OTHER" };
}

export function controlResponse(requestId: unknown, response: Obj): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

export function controlError(requestId: unknown, error: string): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
}

export function interruptLine(): string {
  return JSON.stringify({ type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } });
}

/** Text of a tool_result block (string or nested content blocks), capped for the transcript. */
export function resultText(block: Obj): string {
  const c = block.content;
  const raw = typeof c === "string" ? c : (arr(c) ?? []).map((b) => str(obj(b)?.text) ?? "").join("\n");
  return raw.length > RESULT_CAP ? `${raw.slice(0, RESULT_CAP)}…` : raw;
}

/** A short text-only recap of the last transcript messages, for the fresh retry after a stale --resume. */
export function recapPrefix(transcript: ChatMessage[]): string {
  const texts = transcript.slice(-RECAP_MSGS).map((m) => `${m.role}: ${m.content}`).join("\n");
  return texts.trim() ? `Earlier in this session:\n${texts.slice(0, RECAP_CAP)}\n\n` : "";
}
