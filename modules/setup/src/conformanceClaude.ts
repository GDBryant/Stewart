import * as path from "node:path";
import type { ChatMessage } from "@stewart/kernel";
import type { AgentDef, ChannelDef, Qual } from "@stewart/config";
import type { ManagedChannel } from "@stewart/channels";
import { claudeCodeEngine, type Engine, type EngineEvent, type EngineTurn } from "@stewart/engines";
import { ToolRegistry } from "@stewart/tools";
import {
  AGENT_PROMPT, agentCriteria, contextQual, probeMessage, qual, type ProbeTransport, type QualifyDeps,
} from "./conformanceShared.js";

const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_MAX_TURNS = 8;
const PROBE_MAX_TURNS = 2;
const TODO_FILE = "notes/todo.txt";
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

function insideDir(dir: string, p: string): boolean {
  const rel = path.relative(dir, path.resolve(dir, p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** File previews inside the scratch dir, `wc ` commands and read-only calls run; everything else is denied. */
function approveIn(dir: string): EngineTurn["approve"] {
  return async (call, preview) => {
    if (preview?.kind === "file" && insideDir(dir, preview.path)) return { kind: "approved" };
    if (preview?.kind === "command") {
      return preview.command.startsWith("wc ")
        ? { kind: "approved" }
        : { kind: "rejected", reason: "only `wc` commands are available; use the Edit tool for file changes" };
    }
    if (READ_TOOLS.has(call.name)) return { kind: "approved" };
    if (preview?.kind === "file") return { kind: "rejected", reason: "file is outside the qualification dir" };
    return { kind: "rejected", reason: "not available in qualification" };
  };
}

/** Track one event: remember `wc -l` request callIds, flag a successful outcome, surface the engine error. */
function track(ev: EngineEvent, wcCalls: Set<string>): { wcHit?: boolean; err?: string } {
  if (ev.kind === "tool.request") {
    const cmd = (ev.args as { command?: unknown } | undefined)?.command;
    if (typeof cmd === "string" && cmd.includes("wc -l")) wcCalls.add(ev.callId);
    return {};
  }
  if (ev.kind === "tool.outcome") return { wcHit: ev.ok && wcCalls.has(ev.callId) };
  if (ev.kind === "finished" && ev.reason !== "stop") return { err: `engine ${ev.reason}${ev.error ? `: ${ev.error}` : ""}` };
  return {};
}

async function drainClaude(engine: Engine, turn: EngineTurn): Promise<{ err?: string; wcOk: boolean }> {
  const wcCalls = new Set<string>();
  let wcOk = false;
  try {
    for await (const ev of engine.run(turn) as AsyncGenerator<EngineEvent>) {
      const r = track(ev, wcCalls);
      wcOk = wcOk || r.wcHit === true;
      if (r.err) return { wcOk, err: r.err };
    }
    return { wcOk };
  } catch (e) {
    return { wcOk, err: e instanceof Error ? e.message : String(e) };
  }
}

function claudeTurn(req: { agent: AgentDef; channel: ManagedChannel; transcript: ChatMessage[] }, dir: string, maxTurns: number): EngineTurn {
  return {
    sessionId: "qualify",
    transcript: req.transcript,
    system: "",
    agent: req.agent,
    channel: req.channel,
    roleId: "setup",
    tools: new ToolRegistry([]),
    approve: approveIn(dir),
    state: {},
    cwd: dir,
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    maxTurns,
  };
}

function lastText(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

/** Probe transport over one claude-code turn in the scratch dir: no tools, everything denied. */
function engineProbe(engine: Engine, agent: AgentDef, channel: ManagedChannel, dir: string): ProbeTransport {
  return async (message) => {
    const transcript: ChatMessage[] = [{ role: "user", content: message }];
    const turn = claudeTurn({ agent, channel, transcript }, dir, PROBE_MAX_TURNS);
    turn.approve = async () => ({ kind: "rejected", reason: "not available in qualification" });
    const { err } = await drainClaude(engine, turn);
    if (err) throw new Error(err);
    return { text: lastText(transcript) };
  };
}

async function readResult(host: { files: { read(p: string): Promise<{ content: string }> } }, file: string): Promise<{ content?: string; err?: string }> {
  try {
    return { content: (await host.files.read(file)).content };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

/** Claude CLI agent suite: one real engine turn in a scratch dir, then the same agent criteria. */
export async function qualifyClaudeAgent(ch: ChannelDef, agent: AgentDef, channel: ManagedChannel, deps: QualifyDeps): Promise<Qual> {
  const scratch = deps.scratch;
  if (!scratch) return qual(false, deps.clock.now(), "claude-cli qualification needs a scratch directory");
  const { host, dir } = scratch;
  const file = `${dir}/${TODO_FILE}`;
  const transcript: ChatMessage[] = [{ role: "user", content: AGENT_PROMPT }];
  const engine = deps.engine ?? claudeCodeEngine();
  try {
    await host.files.writeAtomic(file, "alpha\nbeta\n");
    const { err, wcOk } = await drainClaude(engine, claudeTurn({ agent, channel, transcript }, dir, CLAUDE_MAX_TURNS));
    const now = deps.clock.now();
    if (err) return qual(false, now, err);
    const r = await readResult(host, file);
    if (r.err) return qual(false, now, r.err);
    const failed = agentCriteria(r.content ?? "", wcOk, transcript);
    if (failed !== undefined) return qual(false, now, failed);
    return await contextQual(ch, agent.model, now, { channel, transport: engineProbe(engine, agent, channel, dir) });
  } finally {
    await host.files.delete(file).catch(() => {});
    await host.files.delete(`${dir}/notes`).catch(() => {});
    await host.files.delete(dir).catch(() => {});
  }
}
