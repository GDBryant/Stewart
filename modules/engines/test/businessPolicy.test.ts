import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent, type SpawnedProc, type SpawnFn } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { collect, type ChatMessage } from "@stewart/kernel";
import { ToolRegistry } from "@stewart/tools";
import type { ApproveFn } from "@stewart/permissions";
import { claudeCodeEngine, nativeLoop, type EngineEvent, type EngineTurn } from "../src/api.js";

const SECRET = "password=hunter2";
const agent = { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef;

function channel(type: string, sent: ChatMessage[][], replies: ChatEvent[][] = [[{ kind: "text", text: "ok" }, { kind: "done" }]], rules = true): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type,
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      sent.push(req.messages);
      for (const ev of replies[Math.min(i++, replies.length - 1)]) yield ev;
    },
  };
  const ch = new ManagedChannel(adapter, { id: "c", type, enabled: true, maxParallel: 1, cliPath: "claude" });
  if (rules) ch.setRules(["passwords", "privacy"]);
  return ch;
}

function turn(ch: ManagedChannel, transcript: ChatMessage[], over: Partial<EngineTurn> = {}): EngineTurn {
  return {
    sessionId: "s", transcript, system: "sys", agent, channel: ch, roleId: "lead", tools: new ToolRegistry([]),
    approve: (async () => ({ kind: "approved" as const })) as ApproveFn, state: {}, cwd: "/p", signal: new AbortController().signal, maxTurns: 3, ...over,
  };
}

const finish = (evs: EngineEvent[]) => evs.find((e) => e.kind === "finished") as Extract<EngineEvent, { kind: "finished" }>;
const notices = (evs: EngineEvent[]) => evs.filter((e) => e.kind === "policy.notice");

function spawnRecorder(): { spawn: SpawnFn; written: string[]; spawned: () => number } {
  const written: string[] = [];
  let n = 0;
  const spawn: SpawnFn = () => {
    n++;
    return { write: (d: string) => void written.push(d), stdout: (async function* () {})(), stderrText: async () => "", done: Promise.resolve({ code: 0 }), kill: async () => {} } as unknown as SpawnedProc;
  };
  return { spawn, written, spawned: () => n };
}

describe("native loop business policy", () => {
  it("blocks a user message: notice, failed finish with evidence, transcript redacted, nothing sent", async () => {
    const sent: ChatMessage[][] = [];
    const t = turn(channel("fake", sent), [{ role: "user", content: SECRET }]);
    const evs = await collect(nativeLoop.run(t));
    expect(sent).toEqual([]);
    expect(notices(evs)).toEqual([{ kind: "policy.notice", channel: "c", rule: "passwords", action: "blocked", where: "user", msgIndex: 1 }]);
    expect(finish(evs)).toMatchObject({ reason: "error", error: "business_policy: blocked outgoing message to c: passwords in user #1 (secret assignment)" });
    expect(JSON.stringify(evs)).not.toContain("hunter2");
    expect(t.transcript[0]).toEqual({ role: "user", content: "[message withheld by business policy: passwords]" });
  });

  it("after redaction the next request goes through", async () => {
    const sent: ChatMessage[][] = [];
    const t = turn(channel("fake", sent), [{ role: "user", content: SECRET }]);
    await collect(nativeLoop.run(t));
    t.transcript.push({ role: "user", content: "hello" });
    const evs = await collect(nativeLoop.run(t));
    expect(finish(evs).reason).toBe("stop");
    expect(sent).toHaveLength(1);
  });

  it("redacts an assistant message and its tool-call arguments", async () => {
    const sent: ChatMessage[][] = [];
    const bad: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "1", name: "Echo", arguments: { text: SECRET } }] };
    const t = turn(channel("fake", sent), [{ role: "user", content: "go" }, bad, { role: "tool", toolCallId: "1", content: "echo" }]);
    await collect(nativeLoop.run(t));
    expect(t.transcript[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "1", arguments: {} }] });
    expect(JSON.stringify(t.transcript)).not.toContain("hunter2");
  });

  it("withholds a tool result, continues, notices once even across requests", async () => {
    const sent: ChatMessage[][] = [];
    const calls: ChatEvent[][] = [[{ kind: "text", text: "a" }, { kind: "done" }]];
    const t = turn(channel("fake", sent, calls), [{ role: "user", content: "read" }, { role: "tool", toolCallId: "9", content: `.env\n${SECRET}` }]);
    const first = await collect(nativeLoop.run(t));
    expect(finish(first).reason).toBe("stop");
    expect(notices(first)).toEqual([{ kind: "policy.notice", channel: "c", rule: "passwords", action: "withheld", where: "tool", msgIndex: 2 }]);
    expect(sent[0]?.[2]).toEqual({ role: "tool", toolCallId: "9", content: "[output withheld by business policy: passwords]" });
    expect(t.transcript[1]).toMatchObject({ content: `.env\n${SECRET}` });
    t.transcript.push({ role: "user", content: "more" });
    const second = await collect(nativeLoop.run(t));
    expect(notices(second)).toEqual([]);
    expect(sent[1]?.[2]).toMatchObject({ content: "[output withheld by business policy: passwords]" });
  });

  it("withholds a tool result that another engine's tool call would flatten into assistant text", async () => {
    const sent: ChatMessage[][] = [];
    const t = turn(channel("fake", sent), [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "Read", arguments: {} }] },
      { role: "tool", toolCallId: "1", content: SECRET },
    ]);
    for (let i = 0; i < 2; i++) {
      const evs = await collect(nativeLoop.run(t));
      expect(finish(evs).reason).toBe("stop");
      expect(notices(evs)).toHaveLength(i === 0 ? 1 : 0);
    }
    expect(JSON.stringify(sent)).not.toContain("hunter2");
    expect(JSON.stringify(sent[0])).toContain("withheld by business policy");
    expect(t.transcript[2]).toMatchObject({ content: SECRET });
  });

  it("does nothing when no rule is ticked", async () => {
    const sent: ChatMessage[][] = [];
    const evs = await collect(nativeLoop.run(turn(channel("fake", sent, undefined, false), [{ role: "user", content: SECRET }])));
    expect(finish(evs).reason).toBe("stop");
    expect(notices(evs)).toEqual([]);
    expect(sent[0]?.[1]).toMatchObject({ content: SECRET });
  });
});

describe("claude-code business policy", () => {
  it("blocks a secret in the user line before spawning", async () => {
    const r = spawnRecorder();
    const t = turn(channel("claude-cli", []), [{ role: "user", content: SECRET }]);
    const evs = await collect(claudeCodeEngine({ spawn: r.spawn, env: {} }).run(t));
    expect(r.spawned()).toBe(0);
    expect(r.written).toEqual([]);
    expect(notices(evs)).toMatchObject([{ action: "blocked", where: "user", rule: "passwords" }]);
    expect(finish(evs).error).toMatch(/^business_policy: blocked outgoing message to c/);
    expect(t.transcript[0]).toMatchObject({ content: "[message withheld by business policy: passwords]" });
  });

  it("blocks a secret in the system prompt", async () => {
    const r = spawnRecorder();
    const evs = await collect(claudeCodeEngine({ spawn: r.spawn, env: {} }).run(turn(channel("claude-cli", []), [{ role: "user", content: "hi" }], { system: SECRET })));
    expect(r.spawned()).toBe(0);
    expect(notices(evs)).toMatchObject([{ where: "system", msgIndex: 0 }]);
  });

  it("withholds tool results in the recap and notifies", async () => {
    const r = spawnRecorder();
    const t = turn(channel("claude-cli", []), [{ role: "tool", toolCallId: "1", content: SECRET }, { role: "user", content: "next" }]);
    const evs = await collect(claudeCodeEngine({ spawn: r.spawn, env: {} }).run(t));
    expect(r.spawned()).toBe(1);
    expect(r.written.join("")).toContain("withheld by business policy");
    expect(r.written.join("")).not.toContain("hunter2");
    expect(notices(evs)).toMatchObject([{ action: "withheld", where: "tool", msgIndex: 1 }]);
    expect(t.transcript[0]).toMatchObject({ content: SECRET });
  });

  it("ignores hits in messages the CLI already saw", async () => {
    const r = spawnRecorder();
    const t = turn(channel("claude-cli", []), [{ role: "user", content: SECRET }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }], { state: { cliSeen: 2, cliSessionId: "x" } });
    const evs = await collect(claudeCodeEngine({ spawn: r.spawn, env: {} }).run(t));
    expect(r.spawned()).toBe(1);
    expect(notices(evs)).toEqual([]);
  });

  it("sends clean text unchanged", async () => {
    const r = spawnRecorder();
    await collect(claudeCodeEngine({ spawn: r.spawn, env: {} }).run(turn(channel("claude-cli", []), [{ role: "user", content: "hello" }])));
    expect(r.written.join("")).toContain("hello");
  });

  it("claudeComplete refuses a secret input without spawning", async () => {
    const r = spawnRecorder();
    const res = await claudeCodeEngine({ spawn: r.spawn, env: {} }).complete({ channel: channel("claude-cli", []), agent, system: "", input: SECRET, schema: { type: "object" }, signal: new AbortController().signal });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/^business_policy: blocked/);
    expect(r.spawned()).toBe(0);
  });
});

describe("function run business policy", () => {
  it("native complete reports the block as an error", async () => {
    const res = await nativeLoop.complete({ channel: channel("fake", []), agent, system: "sys", input: SECRET, schema: { type: "object" }, signal: new AbortController().signal });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/business_policy/);
  });
});
