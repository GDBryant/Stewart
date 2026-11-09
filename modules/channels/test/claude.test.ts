import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliAdapter, type ClaudeDeps } from "../src/claude/adapter.js";
import { ClaudeStreamParser } from "../src/claude/parser.js";
import { argv, prepare } from "../src/claude/transcript.js";
import { type ChatMessage } from "@stewart/kernel";
import { ChannelError } from "../src/types.js";
import type { SpawnedProc, SpawnFn } from "../src/claude/nodeSpawn.js";
import { collect } from "@stewart/kernel";

const FIXTURES = join(__dirname, "../../../packages/conformance/fixtures/claude");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());

interface FakeProc {
  proc: SpawnedProc;
  stdin: string[];
  killed: boolean;
}

function fakeSpawn(lines: string[], opts: { code?: number; stderr?: string } = {}): { spawn: SpawnFn; captured: { argv: string[]; cwd: string; env: Record<string, string> }[]; procs: FakeProc[] } {
  const captured: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = (a, o) => {
    captured.push({ argv: a, cwd: o.cwd, env: o.env });
    const stdin: string[] = [];
    let killed = false;
    let doneRes: (r: { code: number }) => void = () => {};
    const done = new Promise<{ code: number }>((res) => (doneRes = res));
    const fp: FakeProc = {
      stdin,
      killed: false,
      proc: {
        stdin: (d) => stdin.push(d),
        stdout: (async function* () {
          try {
            for (const l of lines) yield l;
          } finally {
            doneRes({ code: killed ? -1 : (opts.code ?? 0) });
          }
        })(),
        stderrText: async () => opts.stderr ?? "",
        done,
        kill: async () => {
          killed = true;
          fp.killed = true;
          doneRes({ code: -1 });
        },
      },
    };
    procs.push(fp);
    return fp.proc;
  };
  return { spawn, captured, procs };
}

function deps(spawn: SpawnFn, extra: Partial<ClaudeDeps> = {}): { deps: ClaudeDeps; sysPrompts: string[]; removed: string[] } {
  const sysPrompts: string[] = [];
  const removed: string[] = [];
  return {
    sysPrompts,
    removed,
    deps: {
      spawn,
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "tok", ...((extra.env as Record<string, string>) ?? {}) },
      makeTempDir: async () => "/tmp/stewart-claude-fake",
      writeTempFile: async (c: string) => {
        sysPrompts.push(c);
        return "/tmp/stewart-claude-prompt-fake/prompt.txt";
      },
      rmDir: async (d) => {
        removed.push(d);
      },
      ...extra,
    },
  };
}

const cfg = { id: "claude", type: "claude-cli", enabled: true, maxParallel: 1 };
const req = (messages: ChatMessage[], extra: Record<string, unknown> = {}) => ({
  model: "Claude Sonnet 4.5",
  messages,
  signal: new AbortController().signal,
  ...extra,
});

describe("transcript", () => {
  it("single user message passes through", () => {
    const i = prepare([{ role: "user", content: "hi" }]);
    expect(i.system).toBe("You are a helpful assistant.");
    expect(i.text).toBe("hi");
  });

  it("joins system messages", () => {
    const i = prepare([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "q" },
    ]);
    expect(i.system).toBe("A\n\nB");
    expect(i.text).toBe("q");
  });

  it("renders multi-turn with tool history as neutral notes", () => {
    const i = prepare([
      { role: "system", content: "S" },
      { role: "user", content: "do x" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "WriteFile", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", content: "done" },
      { role: "user", content: "next" },
    ]);
    expect(i.system).toBe("S");
    expect(i.text).toContain("<user>\ndo x\n</user>");
    expect(i.text).toContain("[called tool WriteFile with arguments {\"path\":\"a\"}]");
    expect(i.text).toContain('<tool_result tool="WriteFile">\ndone\n</tool_result>');
    expect(i.text).toContain("<user>\nnext\n</user>");
  });

  it("sends only the last user message's images as blocks", () => {
    const i = prepare([
      { role: "user", content: "first", images: ["AAAA"] },
      { role: "assistant", content: "seen" },
      { role: "user", content: "second", images: ["data:image/jpeg;base64,BBBB"] },
    ]);
    expect(i.hasImages).toBe(true);
    expect(i.text).toContain("[image: image-1]");
    const line = JSON.parse(i.streamJsonLine()) as { message: { content: { type: string; source?: { media_type: string; data: string } }[] } };
    const img = line.message.content.find((b) => b.type === "image");
    expect(img?.source?.media_type).toBe("image/jpeg");
    expect(img?.source?.data).toBe("BBBB");
  });

  it("argv carries the isolation flags", () => {
    const a = argv("claude", "sonnet", "/tmp/p.txt", false);
    expect(a).toEqual([
      "claude", "-p",
      "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--tools", "", "--safe-mode",
      "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands",
      "--model", "sonnet", "--system-prompt-file", "/tmp/p.txt",
    ]);
    const withImages = argv("claude", "sonnet", "/tmp/p.txt", true);
    expect(withImages.slice(0, 4)).toEqual(["claude", "-p", "--input-format", "stream-json"]);
  });
});

describe("ClaudeStreamParser", () => {
  const feed = (p: ClaudeStreamParser, lines: string[]) => lines.flatMap((l) => p.feed(l));

  it("fails on non-empty init tools/mcp", () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, ['{"type":"system","subtype":"init","tools":["bash"],"mcp_servers":[]}']);
    expect(ev).toEqual([{ t: "failed", message: "CLI advertised tools or MCP servers", code: "isolation_violation" }]);
    expect(p.failedEmitted).toBe(true);
  });

  it("fails on non-advisor server_tool_use; allows advisor", () => {
    const ok = new ClaudeStreamParser();
    expect(feed(ok, ['{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"server_tool_use","name":"advisor"}}}'])).toEqual([]);
    const bad = new ClaudeStreamParser();
    const ev = feed(bad, ['{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"server_tool_use","name":"web_search"}}}']);
    expect(ev[0]).toMatchObject({ t: "failed", code: "isolation_violation" });
  });

  it("fails when the CLI executed a tool (non-error tool_result)", () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, ['{"type":"user","message":{"content":[{"type":"tool_result","is_error":false}]}}']);
    expect(ev[0]).toMatchObject({ t: "failed", code: "isolation_violation" });
  });

  it("emits text and reasoning deltas; dedups assistant blocks", () => {
    const p = new ClaudeStreamParser();
    feed(p, ['{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}},"api_message_id":"m1"}']);
    feed(p, ['{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}},"api_message_id":"m1"}']);
    const ev = feed(p, ['{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hi"},{"type":"thinking","thinking":"hmm"}]}}']);
    expect(ev).toEqual([]); // already streamed via deltas
  });

  it("emits assistant text when no deltas were seen for the message", () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, ['{"type":"assistant","message":{"id":"m9","content":[{"type":"text","text":"late"}]}}']);
    expect(ev).toEqual([{ t: "text", text: "late" }]);
  });

  it("emits thinking and skips empty blocks for undelta'd assistant messages", () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, ['{"type":"assistant","message":{"id":"m7","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":""},{"type":"text","text":"late"},{"type":"thinking","thinking":""}]}}']);
    expect(ev).toEqual([{ t: "reasoning", text: "hmm" }, { t: "text", text: "late" }]);
  });

  it("ends the turn after a refused tool_use (cutPending → toolTurnEnded)", () => {
    const p = new ClaudeStreamParser();
    feed(p, ['{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"bash","input":{"command":"ls"}}]}}']);
    expect(p.nativeCalls).toEqual([{ id: "t1", name: "bash", argumentsJson: '{"command":"ls"}' }]);
    feed(p, ['{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"tool_use_id":"t1"}]}}']);
    expect(p.cutPending).toBe(true);
    feed(p, ['{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"}},"api_message_id":"m1"}']);
    expect(p.toolTurnEnded).toBe(true);
    expect(p.finishReason).toBe("tool_calls");
  });

  it("classifies result errors and maps stop reasons", () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, [fixture("badmodel-stream.json")[3]]);
    expect(ev[0]).toMatchObject({ t: "failed", code: "model_unavailable" });
    expect(p.resultIsError).toBe(true);
  });

  it("sums usage incl. cache tokens and total_cost_usd", () => {
    const p = new ClaudeStreamParser();
    for (const l of fixture("auth-stream.json")) p.feed(l);
    const u = p.turnUsage();
    expect(u).toEqual({ in: 2 + 1211 + 2293, out: 4, costUsd: 0.0102346 });
    expect(p.finishReason).toBe("stop");
  });

  it("ignores malformed lines", () => {
    const p = new ClaudeStreamParser();
    expect(p.feed("{not json")).toEqual([]);
    expect(p.feed("[1,2]")).toEqual([]);
  });
});

describe("ClaudeCliAdapter", () => {
  it("streams the auth fixture to done with usage and cost", async () => {
    const { spawn, procs } = fakeSpawn(fixture("auth-stream.json"));
    const { deps: d, removed } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    const events = await collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "hi" }])));
    const texts = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
    expect(texts.join("")).toContain("ok");
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: "done", usage: { in: 3506, out: 4 }, costUsd: 0.0102346 });
    expect(procs[0].killed).toBe(true); // cleanup kill is harmless post-exit
    expect(removed).toContain("/tmp/stewart-claude-fake");
  });

  it("passes isolation argv, strips API keys, writes stdin and system prompt", async () => {
    const { spawn, captured } = fakeSpawn(fixture("auth-stream.json"));
    const { deps: d, sysPrompts } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    await collect(
      adapter.chat(cfg, undefined, req([
        { role: "system", content: "be nice" },
        { role: "user", content: "hello" },
      ])),
    );
    const call = captured[0];
    expect(call.argv[0]).toBe("claude");
    expect(call.argv).toContain("--safe-mode");
    expect(call.argv).toContain("--strict-mcp-config");
    expect(call.argv).toContain("--no-session-persistence");
    const modelIdx = call.argv.indexOf("--model");
    expect(call.argv[modelIdx + 1]).toBe("sonnet");
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(call.env.PATH).toBe("/bin");
    expect(sysPrompts).toEqual(["be nice"]);
  });

  it("uses stream-json stdin when images are present", async () => {
    const { spawn, captured, procs } = fakeSpawn(fixture("auth-stream.json"));
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    await collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "look", images: ["AAAA"] }])));
    expect(captured[0].argv).toContain("--input-format");
    const line = JSON.parse(procs[0].stdin[0]) as { type: string };
    expect(line.type).toBe("user");
  });

  it("fails with isolation_violation and kills the proc", async () => {
    const { spawn, procs } = fakeSpawn(['{"type":"system","subtype":"init","tools":["bash"],"mcp_servers":[]}']);
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    await expect(collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "hi" }])))).rejects.toMatchObject({
      name: "ChannelError",
      code: "isolation_violation",
    });
    expect(procs[0].killed).toBe(true);
  });

  it("surfaces refused tool_use as tool_calls then done (refused-tool fixture)", async () => {
    const { spawn } = fakeSpawn(fixture("refused-tool-stream.json"));
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    const events = await collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "run ls" }])));
    const calls = events.find((e) => e.kind === "tool_calls") as { calls: { name: string; arguments: Record<string, unknown> }[] } | undefined;
    expect(calls?.calls[0].name).toBe("bash");
    expect(String(calls?.calls[0].arguments.command)).toContain("ls");
    expect(events.at(-1)?.kind).toBe("done");
  });

  it("surfaces tool_use fixture as tool_calls", async () => {
    const { spawn } = fakeSpawn(fixture("tooluse-stream.json"));
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    const events = await collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "submit" }])));
    const calls = events.find((e) => e.kind === "tool_calls") as { calls: { name: string; arguments: Record<string, unknown> }[] } | undefined;
    expect(calls?.calls[0]).toMatchObject({ name: "submit_plan", arguments: { goal: "g" } });
    expect(events.at(-1)?.kind).toBe("done");
  });

  it("maps badmodel result error to model_unavailable", async () => {
    const { spawn } = fakeSpawn(fixture("badmodel-stream.json"));
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    await expect(collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "hi" }])))).rejects.toMatchObject({
      name: "ChannelError",
      code: "model_unavailable",
    });
  });

  it("maps spawn failure to cli_not_found", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    const { deps: d } = deps(spawn);
    const adapter = new ClaudeCliAdapter(d);
    await expect(collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "hi" }])))).rejects.toMatchObject({ code: "cli_not_found" });
  });

  it("maps nonzero exit + auth stderr to auth; exit 0 without result to incomplete_stream", async () => {
    const auth = fakeSpawn([], { code: 1, stderr: "Error: not logged in" });
    const a1 = new ClaudeCliAdapter(deps(auth.spawn).deps);
    await expect(collect(a1.chat(cfg, undefined, req([{ role: "user", content: "hi" }])))).rejects.toMatchObject({ code: "auth" });
    const empty = fakeSpawn([], { code: 0 });
    const a2 = new ClaudeCliAdapter(deps(empty.spawn).deps);
    await expect(collect(a2.chat(cfg, undefined, req([{ role: "user", content: "hi" }])))).rejects.toMatchObject({ code: "incomplete_stream" });
  });

  it("rejects native tools requests", async () => {
    const { spawn } = fakeSpawn([]);
    const adapter = new ClaudeCliAdapter(deps(spawn).deps);
    await expect(
      collect(adapter.chat(cfg, undefined, req([{ role: "user", content: "hi" }], { tools: [{ name: "t", description: "", schema: {} }] }))),
    ).rejects.toMatchObject({ code: "native_tools_unsupported" });
  });

  it("kills the process on abort", async () => {
    const { spawn, procs } = fakeSpawn(fixture("auth-stream.json"));
    const adapter = new ClaudeCliAdapter(deps(spawn).deps);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      collect(adapter.chat(cfg, undefined, { model: "sonnet", messages: [{ role: "user", content: "hi" }], signal: ctrl.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(procs[0].killed).toBe(true);
  });

  it("listModels probes auth and returns normalised models", async () => {
    const { spawn, captured } = fakeSpawn(['{"loggedIn":true,"authMethod":"sso","subscriptionType":"enterprise"}']);
    const adapter = new ClaudeCliAdapter(deps(spawn).deps);
    expect(await adapter.listModels(cfg)).toEqual(["sonnet", "opus", "haiku"]);
    expect(captured[0].argv.slice(0, 3)).toEqual(["claude", "auth", "status"]);
    expect(await adapter.probeCaps()).toMatchObject({ tools: "shim", vision: true, reasoning: true });
  });

  it("listModels throws auth when logged out", async () => {
    const { spawn } = fakeSpawn(['{"loggedIn":false}']);
    const adapter = new ClaudeCliAdapter(deps(spawn).deps);
    await expect(adapter.listModels(cfg)).rejects.toMatchObject({ code: "auth" });
  });

  it("loginStatus reports non-JSON and nonzero exit", async () => {
    const bad = fakeSpawn(["oops not json"]);
    expect((await new ClaudeCliAdapter(deps(bad.spawn).deps).loginStatus(cfg)).detail).toBe("non-JSON auth status");
    const exit = fakeSpawn(['{"loggedIn":true}'], { code: 3 });
    expect((await new ClaudeCliAdapter(deps(exit.spawn).deps).loginStatus(cfg)).detail).toBe("auth status exit 3");
  });
});
