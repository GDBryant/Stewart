import type { RunEvent } from "@stewart/protocol";

/** v2 debug log (settings.log): one record per provider call, plus bus events at `full`. */
export type DebugLevel = "off" | "calls" | "full";
export type DebugDirection = "outgoing" | "incoming" | "stderr" | "error" | "event";

export interface DebugEntry {
  ts?: Date;
  direction: DebugDirection;
  provider: string;
  model: string;
  payload: string;
}

/** Destination for log records. Implementations may do I/O but must never throw. */
export interface DebugSink {
  record(e: DebugEntry): void;
}

export const NOOP_DEBUG_SINK: DebugSink = { record() {} };

/** Matches the first line of a file the sink wrote: `[ISO-ts] [direction] [`. */
export const DEBUG_LINE_RE = /^\[\d{4}-\d{2}-\d{2}T[^\s\]]+\] \[(outgoing|incoming|stderr|error|event)\] \[/;

const REDACTED = "[REDACTED]";

function escapeField(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** `[ISO-ts] [dir] [provider] [model] [payload]`, single line. */
export function formatDebugLine(e: DebugEntry): string {
  const ts = (e.ts ?? new Date()).toISOString();
  return `[${ts}] [${e.direction}] [${escapeField(e.provider)}] [${escapeField(e.model)}] [${escapeField(e.payload)}]`;
}

/** Replaces Authorization header values, standalone `Bearer <token>` and exact secret strings. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',}\]]+/gi, `$1${REDACTED}`);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED);
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

/**
 * Level-gated, redacting front for a sink. Stable instance: core hands it to
 * channel adapters once and reconfigures level/sink as settings change.
 * `record` never throws, whatever the sink does.
 */
export class DebugLogger implements DebugSink {
  private _level: DebugLevel = "off";
  private sink: DebugSink = NOOP_DEBUG_SINK;

  constructor(private secrets: () => readonly string[] = () => []) {}

  get level(): DebugLevel {
    return this._level;
  }

  configure(level: DebugLevel, sink: DebugSink): void {
    this._level = level;
    this.sink = level === "off" ? NOOP_DEBUG_SINK : sink;
  }

  record(e: DebugEntry): void {
    try {
      if (this._level === "off") return;
      if (e.direction === "event" && this._level !== "full") return;
      this.sink.record({ ...e, ts: e.ts ?? new Date(), payload: redact(e.payload, this.secrets()) });
    } catch {
      /* logging never breaks a call */
    }
  }
}

/** Bus event as a `full`-level entry; text deltas are skipped (too chatty, and carried by the transcript). */
export function eventEntry(ev: RunEvent): DebugEntry | undefined {
  if (ev.kind === "text_delta") return undefined;
  return { direction: "event", provider: "core", model: "-", payload: JSON.stringify(ev) };
}
