import type { ToolCall } from "@stewart/kernel";
import { categoryOf } from "@stewart/permissions";
import { claudeChildEnv, nodeSpawn, type SpawnedProc } from "@stewart/channels";
import type { ClaudeCodeDeps, Engine, EngineEvent, EngineTurn } from "./types.js";
import { mcpConfigArg, startMcp, type McpHandle } from "./mcp.js";
import { LoopGuard } from "./loopGuard.js";
import { claudeComplete } from "./claudeComplete.js";
import { contextEvent, inputTokensOf, observeSystem, windowTokensOf, type ClaudeObs } from "./claudeContext.js";
import { postAttempt, type Attempt } from "./claudePost.js";
import {
  arr, claudeArgv, controlError, controlResponse, FILE_TOOLS, interruptLine, num, obj, previewFor,
  relPath, resultText, str, unseenPrefix, userLine, type Obj,
} from "./claudeLines.js";

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toolUseCall(a: Attempt, b: Obj, calls: ToolCall[]): EngineEvent {
  const call = { id: str(b.id) ?? `call_${calls.length}`, name: str(b.name) ?? "unknown", arguments: obj(b.input) ?? {} };
  calls.push(call);
  a.pending.set(call.id, { name: call.name, input: call.arguments });
  const preview = previewFor(call.name, call.arguments, a.turn.cwd);
  return { kind: "tool.request", callId: call.id, tool: call.name, args: call.arguments, category: categoryOf(preview) ?? "OTHER" };
}

function textBlock(mid: string | undefined, a: Attempt, b: Obj): { evs: EngineEvent[]; text: string } {
  const kind = b.type === "thinking" ? "thinking" : "text";
  const t = str(b[kind]) ?? "";
  const dup = mid !== undefined && a.deltaIds.has(mid);
  const evs: EngineEvent[] = t && !dup ? [{ kind: kind === "text" ? "text" : "reasoning", text: t }] : [];
  return { evs, text: kind === "text" ? t : "" };
}

function emitAssistant(a: Attempt, j: Obj): EngineEvent[] {
  const message = obj(j.message);
  if ((arr(message?.content) ?? []).some((b) => obj(b)?.type === "tool_use")) a.guard.endTurn();
  const mid = str(message?.id);
  const evs: EngineEvent[] = [];
  const calls: ToolCall[] = [];
  let text = "";
  for (const raw of arr(message?.content) ?? []) {
    const b = obj(raw);
    if (!b) continue;
    if (b.type === "tool_use") evs.push(toolUseCall(a, b, calls));
    else {
      const r = textBlock(mid, a, b);
      evs.push(...r.evs);
      text += r.text;
    }
  }
  if (text || calls.length) a.turn.transcript.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
  return evs;
}

function toolResultBlock(a: Attempt, b: Obj, tr: Obj | undefined): EngineEvent[] {
  if (b.type !== "tool_result") return [];
  const id = str(b.tool_use_id) ?? "";
  const isErr = b.is_error === true;
  const text = resultText(b);
  a.turn.transcript.push({ role: "tool", toolCallId: id, content: text });
  const evs: EngineEvent[] = [{ kind: "tool.outcome", callId: id, ok: !isErr, summary: text.split("\n")[0].slice(0, 200) }];
  const p = a.pending.get(id);
  if (p) watchLoop(a, { name: p.name, args: p.input, ok: !isErr, result: text });
  if (p && FILE_TOOLS.has(p.name)) {
    const fp = str(tr?.filePath) ?? str(p.input.file_path) ?? str(p.input.notebook_path) ?? "";
    evs.push({ kind: "write", record: { path: relPath(a.turn.cwd, fp), ok: !isErr, message: isErr ? text : undefined } });
  }
  return evs;
}

/** Feed the loop guard; on a trip, interrupt the CLI (the attempt then finishes as loop_guard). */
function watchLoop(a: Attempt, o: { name: string; args: unknown; ok: boolean; result: string }): void {
  const before = a.guard.trip;
  a.guard.record(o);
  if (!before && a.guard.trip) a.proc.write?.(interruptLine() + "\n");
}

function emitToolResult(a: Attempt, j: Obj): EngineEvent[] {
  const evs: EngineEvent[] = [];
  const tr = obj(j.tool_use_result);
  for (const raw of arr(obj(j.message)?.content) ?? []) {
    const b = obj(raw);
    if (b) evs.push(...toolResultBlock(a, b, tr));
  }
  return evs;
}

async function answerControl(a: Attempt, j: Obj): Promise<void> {
  const req = obj(j.request);
  const id = j.request_id;
  if (req && str(req.subtype) === "can_use_tool") {
    const name = str(req.tool_name) ?? "unknown";
    const input = obj(req.input) ?? {};
    const call: ToolCall = { id: str(req.tool_use_id) ?? "", name, arguments: input };
    const d = await a.turn.approve(call, previewFor(name, input, a.turn.cwd), { roleId: a.turn.roleId });
    const response = d.kind === "approved" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
    a.proc.write?.(controlResponse(id, response) + "\n");
    return;
  }
  a.proc.write?.(controlError(id, "unsupported") + "\n");
}

function streamDelta(a: Attempt, j: Obj): EngineEvent | null {
  const event = obj(j.event);
  const delta = obj(event?.delta);
  const mid = str(obj(event?.message)?.id) ?? str(j.api_message_id);
  const field = str(delta?.type) === "text_delta" ? "text" : str(delta?.type) === "thinking_delta" ? "thinking" : undefined;
  const text = field ? str(delta?.[field]) : undefined;
  if (!text) return null;
  if (mid) a.deltaIds.add(mid);
  return { kind: field === "text" ? "text" : "reasoning", text };
}

function emitResult(a: Attempt, j: Obj): EngineEvent[] {
  const u = obj(j.usage);
  const inTok = inputTokensOf(u);
  a.obs.inputTokens = inTok;
  a.obs.windowTokens = windowTokensOf(j) ?? a.obs.windowTokens;
  a.obs.turnCount = num(j.num_turns) ?? a.obs.turnCount;
  a.obs.cliSessionId = str(j.session_id) ?? a.obs.cliSessionId;
  a.result = { subtype: str(j.subtype) ?? "success", isError: j.is_error === true, text: str(j.result) ?? "" };
  return [{ kind: "usage", inTokens: inTok ?? 0, outTokens: num(u?.output_tokens) ?? 0, costUsd: num(j.total_cost_usd) }];
}

/** Handle one stream-json line; returns true when the turn-ending `result` line arrived. */
async function* handleLine(a: Attempt, j: Obj): AsyncGenerator<EngineEvent, boolean> {
  if (j.type === "system") {
    observeSystem(a.obs, j);
    if (j.subtype === "init" && typeof j.session_id === "string") a.turn.state.cliSessionId = j.session_id;
  } else if (j.type === "assistant") {
    yield* emitAssistant(a, j);
  } else if (j.type === "user") {
    yield* emitToolResult(a, j);
  } else if (j.type === "control_request") {
    await answerControl(a, j);
  } else if (j.type === "stream_event") {
    const ev = streamDelta(a, j);
    if (ev) yield ev;
  } else if (j.type === "result") {
    yield* emitResult(a, j);
    return true;
  }
  return false;
}

async function* pumpLines(a: Attempt): AsyncGenerator<EngineEvent, void> {
  for await (const line of a.proc.stdout) {
    a.lines++;
    let j: Obj | undefined;
    try {
      j = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (j && (yield* handleLine(a, j))) return;
  }
}

/** Abort → interrupt control_request, SIGTERM the tree after 3 s. Returns the detach fn. */
function cancelWatch(turn: EngineTurn, proc: SpawnedProc): () => void {
  const onAbort = () => {
    proc.write?.(interruptLine() + "\n");
    const t = setTimeout(() => void proc.kill(), 3000);
    (t as { unref?: () => void }).unref?.();
  };
  if (turn.signal.aborted) onAbort();
  else turn.signal.addEventListener("abort", onAbort, { once: true });
  return () => turn.signal.removeEventListener("abort", onAbort);
}

async function* runAttempt(turn: EngineTurn, deps: ClaudeCodeDeps, prefix: string, obs: ClaudeObs): AsyncGenerator<EngineEvent, Attempt | null> {
  const spawn = deps.spawn ?? nodeSpawn;
  const argv = claudeArgv(turn, str(turn.state.cliSessionId));
  let mcp: McpHandle | undefined;
  if (turn.hostTools) {
    mcp = await startMcp(turn.hostTools, turn.signal, turn.approve);
    const names = turn.hostTools.tools.map((t) => `mcp__stewart__${t.spec.name}`).join(" ");
    argv.push("--mcp-config", mcpConfigArg(mcp.url, mcp.token), "--allowedTools", names);
  }
  let proc: SpawnedProc;
  try {
    proc = spawn(argv, { cwd: turn.cwd, env: claudeChildEnv(turn.channel.cfg, deps.env ?? (process.env as Record<string, string | undefined>)) });
  } catch (e) {
    obs.spawnError = `cannot start Claude CLI at ${argv[0]}: ${err(e)}`;
    return null;
  }
  const a: Attempt = { turn, proc, obs, deltaIds: new Set(), pending: new Map(), usedResume: str(turn.state.cliSessionId) !== undefined, lines: 0, cli: argv[0], guard: new LoopGuard() };
  const unwatch = cancelWatch(turn, proc);
  try {
    proc.write?.(userLine(turn.transcript, prefix) + "\n");
    yield* pumpLines(a);
  } finally {
    unwatch();
    await mcp?.close();
  }
  return a;
}

/** Yield an attempt's events through, returning its Attempt record (or null on spawn failure). */
async function* driveAttempt(gen: AsyncGenerator<EngineEvent, Attempt | null>): AsyncGenerator<EngineEvent, Attempt | null> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
    yield step.value;
  }
}

async function* runClaude(turn: EngineTurn, deps: ClaudeCodeDeps): AsyncGenerator<EngineEvent, void> {
  if (turn.signal.aborted) {
    yield { kind: "finished", reason: "cancelled" };
    return;
  }
  const obs: ClaudeObs = { cliSessionId: str(turn.state.cliSessionId), compacted: false };
  let prefix = unseenPrefix(turn);
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = yield* driveAttempt(runAttempt(turn, deps, prefix, obs));
    if (!a) {
      yield contextEvent(obs);
      yield { kind: "finished", reason: "error", error: obs.spawnError ?? "cannot start Claude CLI" };
      break;
    }
    const post = await postAttempt(a);
    if (!post.retry || attempt === 1) {
      yield contextEvent(obs);
      if (post.ev) yield post.ev;
      break;
    }
    if (post.dropSession) delete turn.state.cliSessionId;
    prefix = unseenPrefix(turn);
  }
  turn.state.cliSeen = turn.transcript.length;
}

/** The Claude Code CLI as a full agent: its own tools, Stewart supervising permissions and file changes. */
export function claudeCodeEngine(deps: ClaudeCodeDeps = {}): Engine {
  return {
    id: "claude-code",
    caps: { ownTools: true, ownContext: true },
    run: (turn) => runClaude(turn, deps),
    complete: (req) => claudeComplete(req, deps),
  };
}
