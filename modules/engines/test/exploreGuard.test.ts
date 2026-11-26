import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { collect, type ToolCall } from "@stewart/kernel";
import { ToolRegistry, type Tool } from "@stewart/tools";
import { nativeLoop, type EngineEvent, type EngineTurn } from "../src/api.js";
import { dirPrefix, ExploreGuard, NO_WRITE_TURNS } from "../src/exploreGuard.js";

const term = (command: string, extra: Record<string, unknown> = {}, id = command): ToolCall => ({ id, name: "RunTerminal", arguments: { command, ...extra } });

describe("dirPrefix", () => {
  it("takes the first 4 segments of the directory from the first path argument or cwd", () => {
    expect(dirPrefix({ command: "unzip -l ~/.gradle/caches/modules-2/files-2.1/a/b.jar" })).toBe("~/.gradle/caches/modules-2");
    expect(dirPrefix({ command: "ls", cwd: "/opt/idea/lib/app/x" })).toBe("/opt/idea/lib/app");
    expect(dirPrefix({ command: "unzip -l /opt/idea/lib/a.jar" })).toBe("/opt/idea/lib");
  });

  it("returns undefined for no path, bare names, one-segment paths, or paths inside the project root", () => {
    expect(dirPrefix({ command: "npm test" })).toBeUndefined();
    expect(dirPrefix({ command: "./gradlew test" })).toBeUndefined();
    expect(dirPrefix({ command: "ls /tmp" })).toBeUndefined();
    expect(dirPrefix({ command: "cat src/main/kotlin/A.kt" })).toBeUndefined(); // relative = project work
    expect(dirPrefix({ command: "ls /p/src/a", cwd: "" }, "/p")).toBeUndefined();
    expect(dirPrefix({ command: "ls", cwd: "/p" }, "/p")).toBeUndefined();
    expect(dirPrefix({ command: 42 })).toBeUndefined();
  });
});

describe("ExploreGuard terminal sweeps", () => {
  const jar = (i: number) => term(`unzip -l /home/u/.gradle/caches/transformed/idea/${i}.jar`);

  it("nudges on the 5th terminal call on one prefix, once per prefix", () => {
    const g = new ExploreGuard({ canWrite: true });
    const out: (string | undefined)[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(g.record(jar(i), true));
      g.endTurn();
    }
    expect(out.slice(0, 4).every((x) => x === undefined)).toBe(true);
    expect(out[4]).toMatch(/^\[Stewart\] 5 terminal commands on \/home\/u\/.gradle\/caches/);
    expect(out[5]).toBeUndefined();
    expect(out[6]).toBeUndefined();
  });

  it("calls more than 20 turns apart do not add up; different prefixes are counted apart", () => {
    const g = new ExploreGuard({ canWrite: true });
    for (let i = 0; i < 4; i++) g.record(jar(i), true);
    for (let i = 0; i < 25; i++) g.endTurn();
    expect(g.record(jar(9), true)).toBeUndefined();
    const g2 = new ExploreGuard({ canWrite: true });
    for (let i = 0; i < 4; i++) g2.record(term(`ls /var/log/app${i}/x`), true);
    expect(g2.record(term("ls /srv/data/a/b"), true)).toBeUndefined();
  });

  it("other tools and project-local commands never nudge", () => {
    const g = new ExploreGuard({ root: "/p", canWrite: true });
    for (let i = 0; i < 10; i++) {
      expect(g.record({ id: `s${i}`, name: "Search", arguments: { path: "/a/b/c/d" } }, true)).toBeUndefined();
      expect(g.record(term(`cat /p/src/f${i}.ts`), true)).toBeUndefined();
    }
  });
});

describe("ExploreGuard no-write threshold", () => {
  it("asks to re-plan after 40 turns without a successful write, then again after 40 more", () => {
    const g = new ExploreGuard({ canWrite: true });
    const nudges: number[] = [];
    for (let i = 1; i <= 90; i++) if (g.endTurn()) nudges.push(i);
    expect(nudges).toEqual([NO_WRITE_TURNS, NO_WRITE_TURNS * 2]);
  });

  it("a successful write resets the count; a failed write does not", () => {
    const g = new ExploreGuard({ canWrite: true });
    for (let i = 0; i < 30; i++) g.endTurn();
    g.record({ id: "w", name: "EditFile", arguments: {} }, true);
    g.endTurn();
    for (let i = 0; i < 38; i++) expect(g.endTurn()).toBeUndefined();
    const h = new ExploreGuard({ canWrite: true });
    for (let i = 0; i < 39; i++) {
      h.record({ id: `w${i}`, name: "EditFile", arguments: {} }, false);
      expect(h.endTurn()).toBeUndefined();
    }
    h.record({ id: "wz", name: "EditFile", arguments: {} }, false);
    expect(h.endTurn()).toMatch(/40 model turns without a file change/);
  });

  it("a role that cannot write is never asked", () => {
    const g = new ExploreGuard({ canWrite: false });
    for (let i = 0; i < 100; i++) expect(g.endTurn()).toBeUndefined();
  });
});

describe("native loop exploration nudges", () => {
  const tool = (name: string): Tool => ({
    spec: { name, description: name, parameters: { type: "object", properties: { command: { type: "string" } }, additionalProperties: false } },
    requiresApproval: false,
    execute: async (a) => `ran ${String(a.command)}`,
  });

  function turnWith(tools: Tool[], turns: ChatEvent[][], maxTurns: number): EngineTurn {
    let i = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {
        for (const e of turns[Math.min(i++, turns.length - 1)]) yield e;
      },
    };
    return {
      sessionId: "s",
      transcript: [{ role: "user", content: "go" }],
      system: "",
      agent: { id: "a", channel: "c", model: "m", effort: "medium" } as AgentDef,
      channel: new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 }),
      roleId: "lead",
      tools: new ToolRegistry(tools),
      approve: async () => ({ kind: "approved" }),
      state: {},
      cwd: "/p",
      signal: new AbortController().signal,
      maxTurns,
    };
  }

  const termTurn = (i: number): ChatEvent[] => [{ kind: "tool_calls", calls: [term(`unzip -l /home/u/.gradle/caches/x/y/${i}.jar`, {}, `t${i}`)] }, { kind: "done" }];

  it("5 sweeps of one directory add a [Stewart] user message and a diag event", async () => {
    const turns = [...Array.from({ length: 5 }, (_v, i) => termTurn(i)), [{ kind: "text", text: "done" }, { kind: "done" }] as ChatEvent[]];
    const t = turnWith([tool("RunTerminal")], turns, 10);
    const evs: EngineEvent[] = await collect(nativeLoop.run(t));
    expect(evs.find((e) => e.kind === "diag")).toMatchObject({ tag: "exploration_nudge" });
    expect(t.transcript.filter((m) => m.role === "user" && m.content.includes("terminal commands on /home/u/.gradle/caches"))).toHaveLength(1);
  });

  it("40 read-only turns on a writing role add the re-plan nudge; a read-only role gets none", async () => {
    const read = (i: number): ChatEvent[] => [{ kind: "tool_calls", calls: [{ id: `r${i}`, name: "ReadFile", arguments: { command: String(i) } }] }, { kind: "done" }];
    const turns = [...Array.from({ length: 41 }, (_v, i) => read(i)), [{ kind: "text", text: "done" }, { kind: "done" }] as ChatEvent[]];
    const writer = turnWith([tool("ReadFile"), tool("EditFile")], turns, 60);
    await collect(nativeLoop.run(writer));
    expect(writer.transcript.some((m) => m.role === "user" && m.content.includes("40 model turns without a file change"))).toBe(true);
    const reader = turnWith([tool("ReadFile")], turns, 60);
    await collect(nativeLoop.run(reader));
    expect(reader.transcript.some((m) => m.role === "user" && m.content.includes("without a file change"))).toBe(false);
  });
});

describe("ExploreGuard scratch scripts", () => {
  const write = (path: string): ToolCall => ({ id: path, name: "WriteFile", arguments: { path, content: "x" } });
  it("nudges once toward health_batches for a script under /tmp or hidden in the root", () => {
    const g = new ExploreGuard({ canWrite: true });
    expect(g.record(write("/tmp/pack.py"), true)).toMatch(/health_batches/);
    expect(g.record(write(".pack_health.py"), true)).toBeUndefined(); // once per run
  });
  it("ignores ordinary project files, non-scripts, failed writes and other tools", () => {
    const g = new ExploreGuard({ canWrite: true });
    expect(g.record(write("scripts/build.mjs"), true)).toBeUndefined();
    expect(g.record(write("pack.py"), true)).toBeUndefined();
    expect(g.record(write("/tmp/notes.txt"), true)).toBeUndefined();
    expect(g.record(write("/tmp/pack.py"), false)).toBeUndefined();
    expect(g.record({ id: "r", name: "ReadFile", arguments: { path: "/tmp/pack.py" } }, true)).toBeUndefined();
  });
  it("still counts the write for the no-write nudge", () => {
    const g = new ExploreGuard({ canWrite: true });
    g.record(write(".x.sh"), true);
    for (let i = 0; i < NO_WRITE_TURNS - 1; i++) expect(g.endTurn()).toBeUndefined();
  });
});
