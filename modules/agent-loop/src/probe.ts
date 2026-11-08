import type { ManagedChannel } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { Clock } from "@stewart/kernel";
import type { ProbeLoop, ProbeResult } from "@stewart/models";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { createAgentSession } from "./session.js";

/** One-shot loop used by capability benchmarks: a synthetic agent with a single terminal sandbox tool. */
export function createProbeLoop(deps: { clock: Clock }): ProbeLoop<ManagedChannel> {
  return async (channel, req): Promise<ProbeResult> => {
    const agent: AgentDef = { id: "bench", channel: channel.cfg.id, model: req.model, effort: "medium" };
    const tool: Tool = { spec: req.tool, requiresApproval: false, execute: async () => req.reply };
    try {
      let toolOk = false;
      const session = createAgentSession(
        {
          agent,
          channel,
          registry: new ToolRegistry([tool]),
          approve: async () => ({ kind: "approved" }),
          terminal: new Set([req.tool.name]),
          limitsOverride: { maxModelTurns: req.maxTurns },
        },
        deps.clock,
      );
      const r = await session.loop.run(
        req.model,
        [{ role: "user", content: req.prompt }],
        { onToolOutcome: (c, o) => { if (c.name === req.tool.name && o.kind === "success") toolOk = true; } },
        AbortSignal.timeout(req.timeoutMs),
      );
      if (r.kind === "failed") return { kind: "failed", message: `bench call failed: ${r.message}` };
      return { kind: "ok", toolOk };
    } catch (e) {
      return { kind: "failed", message: `bench call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}
