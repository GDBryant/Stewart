import { createHash } from "node:crypto";
import type { ChatMessage, ToolCall } from "@stewart/kernel";

const TRIM_MARK = "[Stewart: tool result truncated";
const READ_TOOLS = new Set(["ReadFile", "Read"]);

interface Prior {
  hash: string;
  callId: string;
  turn: number;
}

function keyOf(call: ToolCall): string | undefined {
  const a = call.arguments;
  if (!READ_TOOLS.has(call.name) || typeof a.path !== "string") return undefined;
  return `${a.path}|${String(a.start_line ?? "")}|${String(a.end_line ?? "")}`;
}

/** One-line description of a ReadFile result: line count and the first non-empty line. */
export function digestOf(raw: string): string {
  const lines = raw.split("\n");
  const last = /^(\d+): /.exec(lines[lines.length - 1]);
  const first = lines.map((l) => l.replace(/^\d+: /, "").trim()).find((l) => l) ?? "";
  const clip = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return `${last ? `${last[1]} lines` : `${raw.length} chars`}${clip ? `, starts: ${clip}` : ""}`;
}

/** True when the earlier result is still in the transcript in full (not compacted away or trimmed to a stub). */
function stillInContext(transcript: ChatMessage[], callId: string): boolean {
  const m = transcript.find((x) => x.role === "tool" && x.toolCallId === callId);
  return m !== undefined && !m.content.includes(TRIM_MARK);
}

/**
 * Per-run record of file reads (path + line range → content hash). A repeat read of an unchanged file whose earlier
 * result is still in the transcript returns a short note instead of the content; a changed file, a different range, or
 * an earlier result that was compacted or trimmed away re-reads in full. The read itself still runs, so the hash
 * always reflects the file on disk (writes by any tool or the user are seen).
 */
export class ReadGuard {
  private readonly prior = new Map<string, Prior>();
  /** Model turn index the loop is on (set by the loop each iteration). */
  turn = 0;

  /** Returns the replacement note for a duplicate read, or undefined when `raw` should go to the model; records the read either way. */
  check(call: ToolCall, raw: string, transcript: ChatMessage[]): string | undefined {
    const key = keyOf(call);
    if (!key) return undefined;
    const hash = createHash("sha1").update(raw).digest("hex");
    const prev = this.prior.get(key);
    if (prev && prev.hash === hash && stillInContext(transcript, prev.callId)) {
      return `[Stewart] already read at turn ${prev.turn + 1}; unchanged. ${digestOf(raw)}. Use that earlier result, or read a different range (start_line/end_line).`;
    }
    this.prior.set(key, { hash, callId: call.id, turn: this.turn });
    return undefined;
  }
}
