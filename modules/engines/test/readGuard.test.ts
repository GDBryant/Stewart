import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { collect, type ChatMessage, type ToolCall } from "@stewart/kernel";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { nativeLoop, type EngineTurn } from "../src/api.js";
import { digestOf, ReadGuard } from "../src/readGuard.js";

const read = (id: string, path: string, extra: Record<string, unknown> = {}): ToolCall => ({ id, name: "ReadFile", arguments: { path, ...extra } });
const toolMsg = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content });
const file = "1: package a\n2: fun main() {}\n3: // end";

describe("ReadGuard", () => {
  it("first read passes; an unchanged repeat with the earlier result still in context is replaced by a note with a digest", () => {
    const g = new ReadGuard();
    g.turn = 2;
    expect(g.check(read("r1", "a.kt"), file, [])).toBeUndefined();
    g.turn = 5;
    const note = g.check(read("r2", "a.kt"), file, [toolMsg("r1", file)]);
    expect(note).toMatch(/^\[Stewart\] already read at turn 3; unchanged\. 3 lines, starts: package a\./);
  });

  it("a changed file re-reads in full and becomes the new baseline", () => {
    const g = new ReadGuard();
    g.check(read("r1", "a.kt"), file, []);
    const changed = `${file}\n4: more`;
    expect(g.check(read("r2", "a.kt"), changed, [toolMsg("r1", file)])).toBeUndefined();
    expect(g.check(read("r3", "a.kt"), changed, [toolMsg("r1", file), toolMsg("r2", changed)])).toMatch(/already read at turn 1/);
  });

  it("re-reads in full when the earlier result was compacted away, trimmed to a stub, or is absent", () => {
    const g = new ReadGuard();
    g.check(read("r1", "a.kt"), file, []);
    expect(g.check(read("r2", "a.kt"), file, [])).toBeUndefined(); // r1 gone from the transcript
    const g2 = new ReadGuard();
    g2.check(read("r1", "a.kt"), file, []);
    const stub = toolMsg("r1", "1: package a\n[Stewart: tool result truncated, 900 chars omitted; the full result is archived — re-read only if needed]\n3: // end");
    expect(g2.check(read("r2", "a.kt"), file, [stub])).toBeUndefined();
  });

  it("a different path or line range is a different read", () => {
    const g = new ReadGuard();
    g.check(read("r1", "a.kt"), file, []);
    const ctx = [toolMsg("r1", file)];
    expect(g.check(read("r2", "b.kt"), file, ctx)).toBeUndefined();
    expect(g.check(read("r3", "a.kt", { start_line: 1, end_line: 2 }), "1: package a\n2: fun main() {}", ctx)).toBeUndefined();
  });

  it("ignores other tools and calls without a path", () => {
    const g = new ReadGuard();
    const search: ToolCall = { id: "s1", name: "Search", arguments: { path: "a.kt" } };
    expect(g.check(search, "x", [])).toBeUndefined();
    expect(g.check(search, "x", [toolMsg("s1", "x")])).toBeUndefined();
    const noPath: ToolCall = { id: "n1", name: "ReadFile", arguments: {} };
    expect(g.check(noPath, "x", [])).toBeUndefined();
  });

  it("the Read alias counts as a read", () => {
    const g = new ReadGuard();
    const c: ToolCall = { id: "r1", name: "Read", arguments: { path: "a.kt" } };
    g.check(c, file, []);
    expect(g.check({ ...c, id: "r2" }, file, [toolMsg("r1", file)])).toMatch(/already read/);
  });
});

describe("digestOf", () => {
  it("counts numbered lines, else chars; clips a long first line; handles empty text", () => {
    expect(digestOf("1: a\n2: b")).toBe("2 lines, starts: a");
    expect(digestOf("plain text")).toBe("10 chars, starts: plain text");
    expect(digestOf(`1: ${"z".repeat(200)}`)).toContain("…");
    expect(digestOf("")).toBe("0 chars");
  });
});

describe("native loop re-read guard", () => {
  function loop(contents: string[], opts: { trimAfterFirst?: boolean } = {}) {
    let calls = 0;
    const turns: ChatEvent[][] = contents.map((_c, i) => [{ kind: "tool_calls", calls: [read(`r${i}`, "a.kt")] }, { kind: "done" }]);
    turns.push([{ kind: "text", text: "done" }, { kind: "done" }]);
    let t = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {
        for (const e of turns[Math.min(t++, turns.length - 1)]) yield e;
      },
    };
    const tool: Tool = {
      spec: { name: "ReadFile", description: "r", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
      requiresApproval: false,
      execute: async () => contents[calls++],
    };
    const turn: EngineTurn = {
      sessionId: "s",
      transcript: [{ role: "user", content: "go" }],
      system: "",
      agent: { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef,
      channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }),
      roleId: "lead",
      tools: new ToolRegistry([tool]),
      approve: async () => ({ kind: "approved" }),
      state: {},
      cwd: "/p",
      signal: new AbortController().signal,
      maxTurns: 6,
      beforeModelTurn: async () => {
        if (opts.trimAfterFirst) {
          const m = turn.transcript.find((x) => x.role === "tool");
          if (m) m.content = "[Stewart: tool result truncated, 5 chars omitted]";
        }
      },
    };
    return { turn, results: () => turn.transcript.filter((m) => m.role === "tool").map((m) => m.content) };
  }

  it("an unchanged repeat read shows the note; the file content appears once", async () => {
    const { turn, results } = loop([file, file]);
    await collect(nativeLoop.run(turn));
    const r = results();
    expect(r[0]).toBe(file);
    expect(r[1]).toMatch(/^\[Stewart\] already read at turn 1; unchanged\. 3 lines/);
  });

  it("a changed file is returned in full the second time", async () => {
    const { turn, results } = loop([file, `${file}\n4: x`]);
    await collect(nativeLoop.run(turn));
    expect(results()[1]).toBe(`${file}\n4: x`);
  });

  it("when the first result was trimmed away, the repeat is returned in full", async () => {
    const { turn, results } = loop([file, file], { trimAfterFirst: true });
    await collect(nativeLoop.run(turn));
    expect(results()[1]).toBe(file);
  });
});
