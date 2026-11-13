import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ManagedChannel, type ChannelAdapter, type SpawnFn, type SpawnedProc } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { ChatMessage } from "@stewart/kernel";
import { collect } from "@stewart/kernel";
import { ToolRegistry } from "@stewart/tools";
import type { ApproveFn } from "@stewart/permissions";
import { claudeCodeEngine, engineFor, type EngineEvent, type EngineTurn } from "../src/api.js";
import { claudeArgv, userLine } from "../src/claudeLines.js";

interface Script {
  lines: unknown[];
  stderr?: string;
  holdUntilKill?: boolean;
}

interface SpawnCall {
  argv: string[];
  env: Record<string, string>;
  written: string[];
  ended: boolean;
  killed: boolean;
  proc: SpawnedProc;
}

function fakeSpawn(scripts: Script[]): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (argv, opts) => {
    const script = scripts[Math.min(calls.length, scripts.length - 1)];
    const call: SpawnCall = { argv, env: opts.env, written: [], ended: false, killed: false } as SpawnCall;
    let killResolve: () => void;
    const killed = new Promise<void>((r) => (killResolve = r));
    let finishStdout: () => void;
    const stdoutGate = new Promise<void>((r) => (finishStdout = r));
    let doneResolve: (v: { code: number }) => void;
    const done = new Promise<{ code: number }>((r) => (doneResolve = r));
    const stdout = (async function* () {
      try {
        for (const l of script.lines) yield typeof l === "string" ? l : JSON.stringify(l);
        if (script.holdUntilKill) await killed;
      } finally {
        finishStdout();
        doneResolve({ code: 0 });
      }
    })();
    const proc: SpawnedProc = {
      stdin: (d) => call.written.push(d),
      write: (d) => call.written.push(d),
      end: () => {
        call.ended = true;
      },
      stdout,
      stderrText: async () => script.stderr ?? "",
      done,
      kill: async () => {
        call.killed = true;
        killResolve();
        doneResolve({ code: -1 });
      },
    };
    call.proc = proc;
    calls.push(call);
    return proc;
  };
  return { spawn, calls };
}

const agent = { id: "a", channel: "c", model: "haiku", effort: "medium" } as AgentDef;

function makeTurn(over: Partial<EngineTurn> = {}): EngineTurn {
  const adapter: ChannelAdapter = { type: "claude-cli", listModels: async () => ["m"], probeCaps: async () => ({}), chat: async function* () {} };
  const channel = new ManagedChannel(adapter, { id: "c", type: "claude-cli", enabled: true, maxParallel: 1, cliPath: "claude", extraEnv: { FOO: "bar" } });
  return {
    sessionId: "s1",
    transcript: [{ role: "user", content: "hello" }],
    system: "",
    agent,
    channel,
    tools: new ToolRegistry([]),
    approve: (async () => ({ kind: "approved" as const })) as ApproveFn,
    state: {},
    cwd: "/tmp/claude-fix",
    signal: new AbortController().signal,
    maxTurns: 3,
    ...over,
  };
}

const fixture = async (name: string) => (await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8")).split("\n").filter(Boolean);

async function run(turn: EngineTurn, spawn: SpawnFn, env?: Record<string, string>): Promise<EngineEvent[]> {
  return collect(claudeCodeEngine({ spawn, env }).run(turn));
}

const kinds = (evs: EngineEvent[]) => evs.map((e) => e.kind);
const texts = (evs: EngineEvent[]) => evs.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("");
const finish = (evs: EngineEvent[]) => evs.find((e) => e.kind === "finished") as Extract<EngineEvent, { kind: "finished" }>;

describe("claude-code engine", () => {
  it("is returned by engineFor for claude-cli only", () => {
    expect(engineFor("claude-cli").id).toBe("claude-code");
    expect(engineFor("ollama").id).toBe("native-loop");
  });

  it("streams a plain answer from the verbatim fixture, deduping deltas", async () => {
    const { spawn, calls } = fakeSpawn([{ lines: await fixture("claude-plain.jsonl") }]);
    const turn = makeTurn({ system: "sys prompt" });
    const evs = await run(turn, spawn, { ANTHROPIC_API_KEY: "sk", PATH: "/x" });
    expect(texts(evs)).toBe("PONG");
    expect(finish(evs).reason).toBe("stop");
    expect(turn.state.cliSessionId).toBe("604e1b57-786c-4676-b314-de9bc94d18c9");
    const usage = evs.find((e) => e.kind === "usage") as { inTokens: number; outTokens: number; costUsd: number };
    expect(usage.inTokens).toBe(2 + 18911 + 13423);
    expect(usage.outTokens).toBe(5);
    expect(usage.costUsd).toBeCloseTo(0.0039, 3);
    const argv = calls[0].argv;
    expect(argv).toContain("--include-partial-messages");
    expect(argv).toContain("--permission-prompt-tool");
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("--append-system-prompt");
    expect(calls[0].env.FOO).toBe("bar");
    expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(calls[0].written[0]).message.content).toEqual([{ type: "text", text: "hello" }]);
    const kindsSeen = new Set(kinds(evs));
    expect(kindsSeen.has("reasoning")).toBe(false);
    expect(evs.filter((e) => e.kind === "text")).toHaveLength(1);
  });

  it("approves an Edit from the verbatim fixture and records the write", async () => {
    const approvals: { name: string; preview: unknown }[] = [];
    const approve: ApproveFn = async (call, preview) => {
      approvals.push({ name: call.name, preview });
      return { kind: "approved" };
    };
    const { spawn, calls } = fakeSpawn([{ lines: await fixture("claude-edit.jsonl") }]);
    const turn = makeTurn({ approve });
    const evs = await run(turn, spawn);
    const allow = calls[0].written.find((w) => w.includes('"behavior":"allow"'));
    expect(allow).toBeTruthy();
    expect(JSON.parse(allow!).response.response.updatedInput.file_path).toBe("/tmp/claude-fix/note.txt");
    const req = evs.find((e) => e.kind === "tool.request" && e.tool === "Edit");
    expect(req).toBeTruthy();
    const write = evs.find((e) => e.kind === "write") as { record: { path: string; ok: boolean } };
    expect(write.record).toEqual({ path: "note.txt", ok: true });
    const outcomes = evs.filter((e) => e.kind === "tool.outcome");
    expect(outcomes.length).toBeGreaterThan(0);
    expect(finish(evs).reason).toBe("stop");
    expect(approvals[0].name).toBe("Edit");
    expect((approvals[0].preview as { kind: string }).kind).toBe("file");
    const toolMsg = turn.transcript.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(turn.transcript.some((m) => m.role === "assistant" && m.toolCalls?.length)).toBe(true);
  });

  it("denies an Edit and reports the failed write, continuing to stop", async () => {
    const approve: ApproveFn = async () => ({ kind: "rejected", reason: "denied by user" });
    const lines = [
      { type: "system", subtype: "init", session_id: "s-new" },
      { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "/tmp/claude-fix/a.txt", old_string: "x", new_string: "y" }, tool_use_id: "t1" } },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/tmp/claude-fix/a.txt" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Edit failed: denied", is_error: true }] } },
      { type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "The edit was denied." }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "s-new", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const { spawn, calls } = fakeSpawn([{ lines }]);
    const turn = makeTurn({ approve });
    const evs = await run(turn, spawn);
    const deny = JSON.parse(calls[0].written.find((w) => w.includes('"behavior":"deny"'))!);
    expect(deny.response.response.message).toBe("denied by user");
    const write = evs.find((e) => e.kind === "write") as { record: { ok: boolean; message?: string } };
    expect(write.record.ok).toBe(false);
    expect(write.record.message).toContain("denied");
    expect(finish(evs).reason).toBe("stop");
  });

  it("passes --resume on the next turn and stores the fresh session id", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "cli-2" },
      { type: "result", subtype: "success", is_error: false, session_id: "cli-2", total_cost_usd: 0, usage: {} },
    ];
    const { spawn, calls } = fakeSpawn([{ lines }]);
    const turn = makeTurn({ state: { cliSessionId: "cli-1" } });
    const evs = await run(turn, spawn);
    expect(finish(evs).reason).toBe("stop");
    const i = calls[0].argv.indexOf("--resume");
    expect(calls[0].argv[i + 1]).toBe("cli-1");
    expect(turn.state.cliSessionId).toBe("cli-2");
  });

  it("retries once fresh when --resume hits a stale session id", async () => {
    const ok = [
      { type: "system", subtype: "init", session_id: "fresh-1" },
      { type: "result", subtype: "success", is_error: false, session_id: "fresh-1", total_cost_usd: 0, usage: {} },
    ];
    const { spawn, calls } = fakeSpawn([
      { lines: [{ type: "system", subtype: "init", session_id: "stale" }], stderr: "No conversation found with session id stale" },
      { lines: ok },
    ]);
    const transcript: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "did things" },
      { role: "user", content: "second" },
    ];
    const turn = makeTurn({ state: { cliSessionId: "stale" }, transcript });
    const evs = await run(turn, spawn);
    expect(finish(evs).reason).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).not.toContain("--resume");
    const sent = JSON.parse(calls[1].written[0]).message.content[0].text;
    expect(sent).toContain("Earlier in this session:");
    expect(sent).toContain("second");
    expect(turn.state.cliSessionId).toBe("fresh-1");
  });

  it("retries once fresh when a result line reports a stale resume", async () => {
    const stale = [
      { type: "system", subtype: "init", session_id: "stale" },
      { type: "result", subtype: "error", is_error: true, session_id: "stale", result: "No conversation found", total_cost_usd: 0, usage: {} },
    ];
    const ok = [
      { type: "system", subtype: "init", session_id: "fresh-2" },
      { type: "result", subtype: "success", is_error: false, session_id: "fresh-2", total_cost_usd: 0, usage: {} },
    ];
    const { spawn, calls } = fakeSpawn([{ lines: stale }, { lines: ok }]);
    const turn = makeTurn({ state: { cliSessionId: "stale" } });
    const evs = await run(turn, spawn);
    expect(finish(evs).reason).toBe("stop");
    expect(calls).toHaveLength(2);
  });

  it("sends an interrupt control_request on cancel and finishes cancelled", async () => {
    const { spawn, calls } = fakeSpawn([{ lines: [{ type: "system", subtype: "init", session_id: "s" }], holdUntilKill: true }]);
    const ctl = new AbortController();
    const turn = makeTurn({ signal: ctl.signal });
    const collected = (async () => {
      const out: EngineEvent[] = [];
      for await (const e of claudeCodeEngine({ spawn, env: {} }).run(turn)) out.push(e);
      return out;
    })();
    await new Promise((r) => setTimeout(r, 30));
    ctl.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0].written.some((w) => w.includes('"subtype":"interrupt"'))).toBe(true);
    await calls[0].proc.kill();
    const evs = await collected;
    expect(finish(evs).reason).toBe("cancelled");
  });

  it("finishes cancelled immediately when the signal is already aborted", async () => {
    const { spawn, calls } = fakeSpawn([{ lines: [] }]);
    const ctl = new AbortController();
    ctl.abort();
    const evs = await run(makeTurn({ signal: ctl.signal }), spawn);
    expect(finish(evs).reason).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("reports exit without a result using the stderr tail", async () => {
    const { spawn } = fakeSpawn([{ lines: [{ type: "system", subtype: "init", session_id: "s" }], stderr: "boom happened" }]);
    const evs = await run(makeTurn(), spawn);
    const f = finish(evs);
    expect(f.reason).toBe("error");
    expect(f.error).toContain("boom happened");
  });

  it("maps auth failures to a clear message", async () => {
    const { spawn } = fakeSpawn([{ lines: [], stderr: "Error: not logged in. Run claude /login" }]);
    const evs = await run(makeTurn(), spawn);
    const f = finish(evs);
    expect(f.reason).toBe("error");
    expect(f.error).toContain("Claude CLI not logged in");
  });

  it("answers unsupported control_requests with an error response", async () => {
    const lines = [
      { type: "control_request", request_id: "r9", request: { subtype: "elicit" } },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn, calls } = fakeSpawn([{ lines }]);
    await run(makeTurn(), spawn);
    const resp = JSON.parse(calls[0].written.find((w) => w.includes('"subtype":"error"'))!);
    expect(resp.response.request_id).toBe("r9");
    expect(resp.response.error).toBe("unsupported");
  });

  it("names the cli path when spawn fails", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    const evs = await run(makeTurn(), spawn);
    const f = finish(evs);
    expect(f.reason).toBe("error");
    expect(f.error).toContain("cannot start Claude CLI at claude");
  });

  it("maps error_max_turns to turn_limit", async () => {
    const lines = [{ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", result: "", total_cost_usd: 0, usage: {} }];
    const { spawn } = fakeSpawn([{ lines }]);
    const evs = await run(makeTurn(), spawn);
    expect(finish(evs).reason).toBe("turn_limit");
  });

  it("maps an error result to finished error with the result text", async () => {
    const lines = [{ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", result: "it broke", total_cost_usd: 0, usage: {} }];
    const { spawn } = fakeSpawn([{ lines }]);
    const evs = await run(makeTurn(), spawn);
    const f = finish(evs);
    expect(f.reason).toBe("error");
    expect(f.error).toBe("it broke");
  });

  it("skips malformed stdout lines and unknown message types", async () => {
    const lines = [
      "garbage line",
      "42",
      { type: "system", subtype: "hook_started", hook_id: "h1" },
      { type: "system", subtype: "init" },
      { type: "rate_limit_event", rate_limit_info: {} },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "interrupted", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn } = fakeSpawn([{ lines }]);
    const turn = makeTurn();
    const evs = await run(turn, spawn);
    expect(texts(evs)).toBe("ok");
    expect(finish(evs).reason).toBe("stop");
  });

  it("streams thinking and text deltas once each", async () => {
    const lines = [
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" }, message: { id: "mX" } }, api_message_id: "mX" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ans" }, message: { id: "mX" } }, api_message_id: "mX" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } },
      { type: "assistant", message: { id: "mX", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ans" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn } = fakeSpawn([{ lines }]);
    const evs = await run(makeTurn(), spawn);
    expect(texts(evs)).toBe("ans");
    expect(evs.filter((e) => e.kind === "reasoning")).toHaveLength(1);
  });

  it("answers a Bash permission with a command preview", async () => {
    const seen: unknown[] = [];
    const approve: ApproveFn = async (_c, p) => {
      seen.push(p);
      return { kind: "approved" };
    };
    const lines = [
      { type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la" }, tool_use_id: "t2" } },
      { type: "control_request", request_id: "r3" },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn, calls } = fakeSpawn([{ lines }]);
    await run(makeTurn({ approve }), spawn);
    expect(seen[0]).toEqual({ kind: "command", command: "ls -la", cwd: "." });
    expect(calls[0].written.some((w) => w.includes('"subtype":"error"'))).toBe(true);
  });

  it("writes ok for a MultiEdit tool_result via tool_use_result.filePath", async () => {
    const lines = [
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t9", name: "MultiEdit", input: { file_path: "rel.txt", edits: [{ old_string: "a", new_string: "b" }] } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: [{ type: "text", text: "Applied 2 edits" }] }] }, tool_use_result: { filePath: "rel.txt" } },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn } = fakeSpawn([{ lines }]);
    const turn = makeTurn();
    const evs = await run(turn, spawn);
    const write = evs.find((e) => e.kind === "write") as { record: { path: string; ok: boolean } };
    expect(write.record).toEqual({ path: "rel.txt", ok: true });
    expect(turn.transcript.find((m) => m.role === "tool")?.content).toBe("Applied 2 edits");
  });

  it("trips the loop guard when the same Bash call fails twice: interrupts and finishes loop_guard", async () => {
    const bash = (id: string, mid: string) => ({ type: "assistant", message: { id: mid, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] } });
    const fail = (id: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "exit 1" }] } });
    const lines = [bash("t1", "m1"), fail("t1"), bash("t2", "m2"), fail("t2"), { type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted" }];
    const { spawn, calls } = fakeSpawn([{ lines }]);
    const evs = await run(makeTurn(), spawn);
    expect(evs[evs.length - 1]).toMatchObject({ kind: "finished", reason: "loop_guard", error: expect.stringContaining("same call failed twice") });
    expect(calls[0].written.some((w) => w.includes("interrupt"))).toBe(true);
    expect(calls[0].killed).toBe(true);
  });

  it("does not trip on distinct successful calls", async () => {
    const lines = [
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] } },
      { type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls -a" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "a" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
    ];
    const { spawn } = fakeSpawn([{ lines }]);
    const evs = await run(makeTurn(), spawn);
    expect(evs[evs.length - 1]).toMatchObject({ kind: "finished", reason: "stop" });
  });
});

describe("claude-code line helpers", () => {
  it("handles an empty transcript and raw base64 images", () => {
    expect(JSON.parse(userLine([])).message.content).toEqual([]);
    const line = JSON.parse(userLine([{ role: "user", content: "", images: ["ZZZ"] } as ChatMessage]));
    expect(line.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "ZZZ" } });
  });

  it("caps tool_result transcript text at 2000 chars", async () => {
    const { spawn } = fakeSpawn([{
      lines: [
        { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t5", name: "Bash", input: {} }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t5", content: "x".repeat(3000) }] } },
        { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, usage: {} },
      ],
    }]);
    const turn = makeTurn();
    await run(turn, spawn);
    const tm = turn.transcript.find((m) => m.role === "tool");
    expect(tm?.content.length).toBe(2001);
  });

  it("builds argv with resume and system prompt only when set", () => {
    const t = makeTurn({ system: "  " });
    const argv = claudeArgv(t, undefined);
    expect(argv[0]).toBe("claude");
    expect(argv).not.toContain("--append-system-prompt");
    const withSys = claudeArgv(makeTurn({ system: "SYS" }), "rid");
    expect(withSys).toContain("--resume");
    expect(withSys[withSys.indexOf("--append-system-prompt") + 1]).toBe("SYS");
    const noBudget = claudeArgv(makeTurn({ maxTurns: 0 }), undefined);
    expect(noBudget).not.toContain("--max-turns");
  });

  it("encodes images as base64 content blocks", () => {
    const transcript: ChatMessage[] = [{ role: "user", content: "look", images: ["data:image/png;base64,AAAA"] } as ChatMessage];
    const line = JSON.parse(userLine(transcript));
    expect(line.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });
});
