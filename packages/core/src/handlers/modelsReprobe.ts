import { resolveModelProfile } from "@stewart/models";
import { needsLargeProbe, reprobeWindow } from "@stewart/setup";
import type { CoreCtx, ProjectCtx } from "./types.js";
import { persistQualified } from "./qualify.js";

type Ask = (question: string, options: string[]) => Promise<string | undefined>;

/** Agents (on reachable channels) whose recorded window is only the 32k probe floor. */
export function reprobeCandidates(ctx: ProjectCtx, reachable: Set<string>): { agent: string; channel: string; model: string }[] {
  return ctx.config.agents
    .filter((a) => reachable.has(a.channel))
    .filter((a) => {
      const ch = ctx.config.channels.find((c) => c.id === a.channel);
      return ch !== undefined && needsLargeProbe(ch, a.model);
    })
    .map((a) => ({ agent: a.id, channel: a.channel, model: a.model }));
}

/**
 * Offer a larger-window re-probe for floor-window agents (one ≈62k-token request each); on yes, persist the larger
 * verified window into the agent qualification record. Returns the agent ids whose window grew.
 */
export async function reprobeWindows(core: CoreCtx, ctx: ProjectCtx, reachable: Set<string>, ask: Ask): Promise<string[]> {
  const todo = reprobeCandidates(ctx, reachable);
  if (!todo.length) return [];
  const names = todo.map((t) => t.agent).join(", ");
  const ans = await ask(`${todo.length} agent${todo.length === 1 ? "" : "s"} (${names}) only have the 32k probe-floor window. Re-probe for a larger window? Sends one ~60k-token request each.`, ["Re-probe", "Skip"]);
  if (ans !== "Re-probe") return [];
  const grown: string[] = [];
  for (const t of todo) {
    const mc = core.channelService.get(t.channel);
    const ch = ctx.config.channels.find((c) => c.id === t.channel);
    if (!mc || !ch) continue;
    const window = await reprobeWindow(ch, t.model, mc).catch(() => undefined);
    const prev = resolveModelProfile({ channels: [ch] }, { channel: ch.id, model: t.model }).caps.qualified?.agent;
    if (window === undefined || !prev) continue;
    await persistQualified(core, ctx, { channel: t.channel, model: t.model }, { agent: { ...prev, context: window, at: core.clock.now() } });
    grown.push(t.agent);
  }
  return grown;
}
