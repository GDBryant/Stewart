import type { ChatEvent, ManagedChannel } from "@stewart/channels";
import type { ChatMessage, ToolCall } from "@stewart/kernel";
import type { ToolsMode } from "@stewart/models";
import { ToolCallStreamFilter } from "@stewart/toolcall-format";
import type { LoopListener } from "./loopTypes.js";
import type { ToolRegistry } from "@stewart/tools";

export interface TurnState {
  text: string;
  open: boolean;
}

type DeltaHandlers = {
  [K in ChatEvent["kind"]]: (ev: Extract<ChatEvent, { kind: K }>) => void;
};

export interface StreamOutcome {
  calls: ToolCall[];
  sawDone: boolean;
  sawTruncated: boolean;
  postDone: boolean;
  failed: Error | null;
  usage: { in: number; out: number } | undefined;
  costUsd: number | undefined;
  /** Text the stream filter held back (unfinished call block). */
  held?: string;
}

export interface StreamDeps {
  channel: ManagedChannel;
  registry: ToolRegistry;
  toolsMode: ToolsMode;
  modelCallTimeoutMs: number;
}

/** Per-turn inputs for `streamTurn`, grouped so the call takes two params. */
export interface StreamRequest {
  model: string;
  outbound: ChatMessage[];
  listener: LoopListener;
  signal: AbortSignal;
  turn: TurnState;
}

interface CallTimeout {
  signal: AbortSignal;
  timeoutMs: number;
  timedOut(): boolean;
  done(): void;
}

/** Streams one model call; accumulates text into `req.turn.text` so a cancel can recover the partial reply. */
export async function streamTurn(deps: StreamDeps, req: StreamRequest): Promise<StreamOutcome> {
  const s: StreamOutcome = {
    calls: [],
    sawDone: false,
    sawTruncated: false,
    postDone: false,
    failed: null,
    usage: undefined,
    costUsd: undefined,
  };
  const filter = deps.toolsMode === "shim" ? new ToolCallStreamFilter() : undefined;
  const call = armCallTimeout(req.signal, deps.modelCallTimeoutMs);
  const onDelta = streamDeltas(s, req.turn, req.listener, filter);
  try {
    for await (const ev of deps.channel.chat({
      model: req.model,
      messages: req.outbound,
      tools: deps.toolsMode === "native" ? deps.registry.specs.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })) : undefined,
      signal: call.signal,
    })) {
      onDelta(ev);
    }
    s.held = filter?.flush() ?? "";
  } catch (e) {
    if (req.signal.aborted) throw e;
    s.failed = callFailure(e, call);
  } finally {
    call.done();
  }
  return s;
}

/** The error a failed model call reports: a timeout error when our own timer fired, else the thrown error. */
function callFailure(e: unknown, call: CallTimeout): Error {
  if (!call.timedOut()) return e instanceof Error ? e : new Error(String(e));
  const err = new Error(`model call timed out after ${call.timeoutMs}ms`);
  (err as { code?: string }).code = "call_timeout";
  return err;
}

function armCallTimeout(signal: AbortSignal, timeoutMs: number): CallTimeout {
  if (timeoutMs <= 0) return { signal, timeoutMs, timedOut: () => false, done: () => {} };
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal.aborted) ctl.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctl.signal,
    timeoutMs,
    timedOut: () => ctl.signal.aborted,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function streamDeltas(
  s: StreamOutcome,
  turn: TurnState,
  listener: LoopListener,
  filter: ToolCallStreamFilter | undefined,
): (ev: ChatEvent) => void {
  const handlers: DeltaHandlers = {
    text: (ev) => {
      turn.text += ev.text;
      const shown = filter ? filter.push(ev.text) : ev.text;
      if (shown) listener.onText?.(shown);
    },
    reasoning: (ev) => listener.onReasoning?.(ev.text),
    tool_calls: (ev) => {
      s.calls = ev.calls;
    },
    done: (ev) => {
      s.sawDone = true;
      s.sawTruncated = ev.truncated === true;
      s.usage = ev.usage;
      s.costUsd = ev.costUsd;
    },
  };
  return (ev) => {
    if (s.sawDone) s.postDone = true;
    else (handlers[ev.kind] as (e: ChatEvent) => void)(ev);
  };
}
