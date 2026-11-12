import type { ManagedChannel } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { EngineEvent } from "@stewart/engines";
import type { Clock } from "@stewart/kernel";
import { nativeLoop } from "@stewart/engines";
import type { ProbeLoop, ProbeRequest, ProbeResult } from "@stewart/models";
import { ToolRegistry, type Tool } from "@stewart/tools";

interface Watch {
  tool: string;
  called: Set<string>;
  ok: boolean;
  abort: () => void;
}

function onEvent(ev: EngineEvent, w: Watch): ProbeResult | undefined {
  if (ev.kind === "tool.request" && ev.tool === w.tool) w.called.add(ev.callId);
  if (ev.kind === "tool.outcome" && ev.ok && w.called.has(ev.callId)) {
    w.ok = true;
    w.abort();
  }
  if (ev.kind !== "finished") return undefined;
  return verdict(ev, w.ok);
}

function verdict(ev: EngineEvent & { kind: "finished" }, ok: boolean): ProbeResult {
  if (ev.reason === "stop" || (ev.reason === "cancelled" && ok)) return { kind: "ok", toolOk: ok };
  return { kind: "failed", message: `bench call failed: ${ev.error ?? ev.reason}` };
}

async function probeTurn(channel: ManagedChannel, req: ProbeRequest): Promise<ProbeResult> {
  const agent: AgentDef = { id: "bench", channel: channel.cfg.id, model: req.model, effort: "medium" };
  const tool: Tool = { spec: req.tool, requiresApproval: false, execute: async () => req.reply };
  const ctl = new AbortController();
  const watch: Watch = { tool: req.tool.name, called: new Set(), ok: false, abort: () => ctl.abort() };
  const timeout = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    const stream = nativeLoop.run({
      sessionId: "probe",
      transcript: [{ role: "user", content: req.prompt }],
      system: "",
      agent,
      channel,
      tools: new ToolRegistry([tool]),
      approve: async () => ({ kind: "approved" }),
      state: {},
      cwd: ".",
      signal: ctl.signal,
      maxTurns: req.maxTurns,
    });
    for await (const ev of stream) {
      const done = onEvent(ev, watch);
      if (done) return done;
    }
    return { kind: "failed", message: "bench call failed: stream ended without a finish" };
  } catch (e) {
    return { kind: "failed", message: `bench call failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timeout);
  }
}

export function createProbeLoop(deps: { clock: Clock }): ProbeLoop<ManagedChannel> {
  void deps;
  return (channel, req) => probeTurn(channel, req);
}
