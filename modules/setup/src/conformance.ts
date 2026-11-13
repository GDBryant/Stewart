import { fakeHost, type ChatMessage, type HostPort } from "@stewart/kernel";
import type { AgentDef, ChannelDef, Qual } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";
import { ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { engineFor, nativeLoop, type Engine, type EngineEvent } from "@stewart/engines";
import type { ManagedChannel } from "@stewart/channels";
import { qualifyClaudeAgent } from "./conformanceClaude.js";
import {
  AGENT_MIN_CONTEXT, AGENT_PROMPT, AGENT_TIMEOUT_MS, agentCriteria, contextQual, qual, type QualifyDeps,
} from "./conformanceShared.js";

export { CONFORMANCE_VERSION } from "./conformanceShared.js";
export type { QualifyDeps } from "./conformanceShared.js";

const AGENT_MAX_TURNS = 8;
const FUNCTION_PROMPT =
  'Reply with only a JSON object, no prose: {"sum": <17 plus 25 as a number>, "word": "<the word stewart reversed>"}';

/** Reason the model cannot serve agents without running the suite, or null to run it. */
export function agentBlockReason(ch: ChannelDef, model: string): string | null {
  const profile = resolveModelProfile({ channels: [ch] }, { channel: ch.id, model });
  if (profile.caps.tools === "none") return "model does not support native tools";
  if (profile.contextTokens !== undefined && profile.contextTokens < AGENT_MIN_CONTEXT)
    return `context ${profile.contextTokens} < ${AGENT_MIN_CONTEXT}`;
  return null;
}

function sandbox(): { host: HostPort; files: Record<string, string>; wcOk: () => boolean } {
  const files: Record<string, string> = { "notes/todo.txt": "alpha\nbeta\n" };
  let wcOk = false;
  const { host, setProcHandler } = fakeHost(files);
  setProcHandler((argv: string[], onData: (d: string) => void) => {
    const cmd = argv.join(" ");
    if (cmd.includes("wc -l")) {
      wcOk = true;
      onData("3 notes/todo.txt\n");
      return { code: 0 };
    }
    onData("command not available\n");
    return { code: 1 };
  });
  return { host, files, wcOk: () => wcOk };
}

/** Agent suite: one native-loop turn against an in-memory sandbox, then the window check. */
export async function qualifyAgent(ch: ChannelDef, agent: AgentDef, channel: ManagedChannel, deps: QualifyDeps): Promise<Qual> {
  const blocked = agentBlockReason(ch, agent.model);
  if (blocked) return qual(false, deps.clock.now(), blocked);
  if (channel.cfg.type === "claude-cli") return await qualifyClaudeAgent(ch, agent, channel, deps);
  const transcript: ChatMessage[] = [{ role: "user", content: AGENT_PROMPT }];
  const { host, files, wcOk } = sandbox();
  const paths = await ProjectPaths.forProject(host);
  const all = projectTools(host, paths);
  const keep = new Set(["ReadFile", "EditFile", "WriteFile", "RunTerminal"]);
  const turn = {
    sessionId: "qualify",
    roleId: "setup",
    transcript,
    system: "",
    agent,
    channel,
    tools: new ToolRegistry(all.tools.filter((t) => keep.has(t.spec.name))),
    approve: async () => ({ kind: "approved" as const }),
    state: {},
    cwd: paths.base,
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    maxTurns: AGENT_MAX_TURNS,
  };
  const runErr = await drainEngine(deps.engine ?? nativeLoop, turn);
  const now = deps.clock.now();
  if (runErr) return qual(false, now, runErr);
  const failed = agentCriteria(files["notes/todo.txt"], wcOk(), transcript);
  if (failed !== undefined) return qual(false, now, failed);
  return await contextQual(ch, agent.model, now, { channel });
}

async function drainEngine(engine: Engine, turn: Parameters<Engine["run"]>[0]): Promise<string | undefined> {
  try {
    for await (const ev of engine.run(turn) as AsyncGenerator<EngineEvent>) {
      if (ev.kind === "finished" && ev.reason !== "stop") return `engine ${ev.reason}${ev.error ? `: ${ev.error}` : ""}`;
    }
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const FUNCTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { sum: { type: "number" }, word: { type: "string" } },
  required: ["sum", "word"],
};

/** Function suite: one schema-constrained request through the channel's engine; the reply must hold the exact values. */
export async function qualifyFunction(agent: AgentDef, channel: ManagedChannel, deps: QualifyDeps): Promise<Qual> {
  const res = await engineFor(channel.cfg.type).complete({ channel, agent, system: "", input: FUNCTION_PROMPT, schema: FUNCTION_SCHEMA, signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
  const now = deps.clock.now();
  if (!res.ok) return qual(false, now, res.error);
  const r = res.value as { sum?: unknown; word?: unknown };
  if (r.sum !== 42 || r.word !== "trawets") return qual(false, now, "wrong values");
  return qual(true, now);
}
