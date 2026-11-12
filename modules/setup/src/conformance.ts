import { fakeHost, type ChatMessage, type HostPort } from "@stewart/kernel";
import type { AgentDef, ChannelDef, Qual } from "@stewart/config";
import { resolveModelProfile } from "@stewart/models";
import { ProjectPaths, projectTools, ToolRegistry } from "@stewart/tools";
import { nativeLoop, type Engine, type EngineEvent } from "@stewart/engines";
import type { ManagedChannel } from "@stewart/channels";

export const CONFORMANCE_VERSION = 1;
const AGENT_MIN_CONTEXT = 32_000;
const AGENT_TIMEOUT_MS = 120_000;
const AGENT_MAX_TURNS = 8;
const AGENT_PROMPT =
  "Read notes/todo.txt, add the line gamma at the end of the file, then run `wc -l notes/todo.txt` and tell me the number it printed.";
const FUNCTION_PROMPT =
  'Reply with only a JSON object, no prose: {"sum": <17 plus 25 as a number>, "word": "<the word stewart reversed>"}';

export interface QualifyDeps {
  engine?: Engine;
  clock: { now(): number };
  sleep?: (ms: number) => Promise<void>;
}

function qual(passed: boolean, now: number, detail?: string): Qual {
  return { passed, at: now, version: CONFORMANCE_VERSION, detail };
}

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

function lastText(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

async function timed<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return await Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

function agentCriteria(content: string, wcOk: boolean, transcript: ChatMessage[]): string | undefined {
  if (content !== "alpha\nbeta\ngamma\n" && content !== "alpha\nbeta\ngamma")
    return `file not edited to expected content: ${JSON.stringify(content.length > 120 ? `${content.slice(0, 120)}…` : content)}`;
  if (!wcOk) return "no successful `wc` RunTerminal call";
  if (!lastText(transcript).includes("3")) return "reply does not contain the wc count 3";
  return undefined;
}

/** Agent suite: one native-loop turn against an in-memory sandbox. */
export async function qualifyAgent(ch: ChannelDef, agent: AgentDef, channel: ManagedChannel, deps: QualifyDeps): Promise<Qual> {
  const blocked = agentBlockReason(ch, agent.model);
  if (blocked) return qual(false, deps.clock.now(), blocked);
  if (channel.cfg.type === "claude-cli") return qual(true, deps.clock.now(), "claude-code engine");
  const transcript: ChatMessage[] = [{ role: "user", content: AGENT_PROMPT }];
  const { host, files, wcOk } = sandbox();
  const paths = await ProjectPaths.forProject(host);
  const all = projectTools(host, paths);
  const keep = new Set(["ReadFile", "EditFile", "WriteFile", "RunTerminal"]);
  const turn = {
    sessionId: "qualify",
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
  return qual(failed === undefined, now, failed);
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

/** Function suite: one plain request; the reply must parse as the exact JSON object. */
export async function qualifyFunction(agent: AgentDef, channel: ManagedChannel, deps: QualifyDeps): Promise<Qual> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AGENT_TIMEOUT_MS);
  let text = "";
  let runErr: string | undefined;
  try {
    for await (const ev of channel.chat({ model: agent.model, messages: [{ role: "user", content: FUNCTION_PROMPT }], signal: ac.signal })) {
      if (ev.kind === "text") text += ev.text;
    }
  } catch (e) {
    runErr = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const now = deps.clock.now();
  if (runErr) return qual(false, now, runErr);
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
  let v: unknown;
  try {
    v = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return qual(false, now, "reply is not JSON");
  }
  const r = v as { sum?: unknown; word?: unknown };
  if (r.sum !== 42 || r.word !== "trawets") return qual(false, now, "wrong values");
  return qual(true, now);
}
