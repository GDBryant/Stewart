import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ManagedChannel, type ChannelAdapter, type SpawnedProc } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import type { Json } from "@stewart/kernel";
import { collect } from "@stewart/kernel";
import { claudeCodeEngine } from "../src/api.js";
import type { CompleteRequest } from "../src/types.js";
import { nativeLoop } from "../src/api.js";

const agent = { id: "a", channel: "c", model: "haiku", effort: "medium" } as AgentDef;
const schema: Json = { type: "object", properties: { sum: { type: "number" }, word: { type: "string" } }, required: ["sum", "word"], additionalProperties: false };

function channel(extra: Record<string, unknown> = {}): ManagedChannel {
  const adapter: ChannelAdapter = { type: "claude-cli", listModels: async () => ["m"], probeCaps: async () => ({}), chat: async function* () {} };
  return new ManagedChannel(adapter, { id: "c", type: "claude-cli", enabled: true, maxParallel: 1, cliPath: "claude", ...extra });
}

function fakeProc(lines: string[]): { spawn: (argv: string[]) => SpawnedProc; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = (argv: string[]) => {
    calls.push(argv);
    const stdout = (async function* () { for (const l of lines) yield l; })();
    return { write: () => {}, stdout, stderrText: async () => "", done: Promise.resolve({ code: 0 }), kill: async () => {} } as SpawnedProc;
  };
  return { spawn, calls };
}

const req = (ch = channel(), over: Partial<CompleteRequest> = {}): CompleteRequest => ({
  channel: ch, agent, system: "", input: "answer", schema, signal: new AbortController().signal, ...over,
});
const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("engine caps", () => {
  it("native-loop owns neither tools nor context; claude-code owns both", () => {
    expect(nativeLoop.caps).toEqual({ ownTools: false, ownContext: false });
    expect(claudeCodeEngine().caps).toEqual({ ownTools: true, ownContext: true });
  });
});

describe("claudeCode.complete", () => {
  it("sends -p --json-schema with no tools and the prompt positional", async () => {
    const { spawn, calls } = fakeProc(["{}"]);
    await claudeCodeEngine({ spawn }).complete(req(channel({ settingSources: "user" }), { system: "Be terse." }));
    const a = calls[0];
    expect(a.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(a).toContain("--json-schema");
    expect(a).toContain("--tools");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("user");
    expect(a).toContain("--append-system-prompt");
    expect(a[a.length - 1]).toBe("answer");
  });

  it("defaults --setting-sources to the empty value (no user/project/local settings)", async () => {
    const { spawn, calls } = fakeProc(["{}"]);
    await claudeCodeEngine({ spawn }).complete(req());
    const a = calls[0];
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("parses structured_output from the (synthesized) success envelope", async () => {
    const { spawn } = fakeProc([await fixture("claude-complete.synthesized.json")]);
    const res = await claudeCodeEngine({ spawn }).complete(req());
    expect(res).toMatchObject({ ok: true, value: { sum: 42, word: "trawets" }, costUsd: 0.012 });
    if (res.ok) expect(res.usage).toEqual({ in: 512, out: 24 });
  });

  it("fails with the result text on the real captured error envelope", async () => {
    const { spawn } = fakeProc([await fixture("claude-complete-error.json")]);
    const res = await claudeCodeEngine({ spawn }).complete(req());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("403");
  });

  it("falls back to parsing the result text as JSON", async () => {
    const { spawn } = fakeProc([JSON.stringify({ type: "result", is_error: false, result: '```json\n{"sum":42,"word":"trawets"}\n```' })]);
    const res = await claudeCodeEngine({ spawn }).complete(req());
    expect(res).toMatchObject({ ok: true, value: { sum: 42, word: "trawets" } });
  });

  it("fails when the object does not satisfy the schema", async () => {
    const { spawn } = fakeProc([JSON.stringify({ type: "result", is_error: false, structured_output: { sum: "x" } })]);
    const res = await claudeCodeEngine({ spawn }).complete(req());
    expect(res.ok).toBe(false);
  });

  it("fails cleanly when spawn throws or output is not JSON", async () => {
    const bad = await claudeCodeEngine({ spawn: () => { throw new Error("enoent"); } }).complete(req());
    expect(bad.ok).toBe(false);
    const { spawn } = fakeProc(["not json"]);
    expect((await claudeCodeEngine({ spawn }).complete(req())).ok).toBe(false);
  });

  it("kills the process on abort", async () => {
    let killed = false;
    let release: () => void = () => {};
    let doneResolve: (v: { code: number }) => void = () => {};
    const spawn = () => ({
      write: () => {},
      stdout: (async function* () { await new Promise<void>((r) => (release = r)); })(),
      stderrText: async () => "",
      done: new Promise<{ code: number }>((r) => (doneResolve = r)),
      kill: async () => { killed = true; release(); doneResolve({ code: -1 }); },
    }) as unknown as SpawnedProc;
    const ac = new AbortController();
    const p = claudeCodeEngine({ spawn }).complete(req(channel(), { signal: ac.signal }));
    ac.abort();
    const res = await p;
    expect(killed).toBe(true);
    expect(res).toMatchObject({ ok: false, error: "cancelled" });
  });
});
