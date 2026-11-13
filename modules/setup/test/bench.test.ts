import { describe, expect, it } from "vitest";
import { BENCH_VERSION, benchModel } from "../src/api.js";
import { ManagedChannel } from "@stewart/channels";
import type { ChannelAdapter, ChannelConfig, ChatEvent } from "@stewart/channels";
import { loadEffectiveConfig } from "@stewart/roles-skills";

import type { ConfigStore } from "@stewart/config";
import type { Clock, HostPort } from "@stewart/kernel";
import { systemClock } from "@stewart/kernel";

function fakeChannel(
  turns: ChatEvent[][],
  opts: { caps?: Record<string, unknown>; cfgCaps?: Record<string, unknown>; onEvent?: (ev: ChatEvent) => void; fail?: boolean } = {},
): { channel: ManagedChannel; adapter: ChannelAdapter } {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => opts.caps ?? {},
    chat: async function* (_cfg: ChannelConfig, _s: string | undefined, _req: unknown) {
      if (opts.fail) throw new Error("bench boom");
      for (const ev of turns[Math.min(i++, turns.length - 1)]) {
        opts.onEvent?.(ev);
        yield ev;
      }
    },
  };
  const channel = new ManagedChannel(adapter, {
    id: "c",
    type: "fake",
    enabled: true,
    maxParallel: 1,
    ...(opts.cfgCaps ? { modelCaps: { m: opts.cfgCaps as never } } : {}),
  });
  return { channel, adapter };
}

const text = (t: string): ChatEvent => ({ kind: "text", text: t });
const done = (out?: number): ChatEvent => ({ kind: "done", usage: out === undefined ? undefined : { in: 10, out } });
// removed: const pingCall = '<tool_call>{"name":"bench_ping","arguments":{"ok":true}}</tool_call>';
const editCall = '<tool_call>{"name":"EditFile","arguments":{"path":"notes.txt","old_string":"line3","new_string":"three"}}</tool_call>';

function memStore(): ConfigStore {
  const layer: Record<string, string | undefined> = {};
  return { read: async () => ({ ...layer }), write: async (f, y) => { layer[f] = y; } };
}

const fakeHost = (): HostPort => ({
  secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  files: {
    read: async () => ({ content: "" }),
    edit: async () => ({ applied: true as const }),
    readBack: async () => "",
    exists: async () => false,
    list: async () => [],
    stat: async () => ({ size: 0 }),
    readBinary: async () => ({ base64: "", size: 0 }),
    writeBinary: async () => {},
    writeAtomic: async () => {},
    appendLine: async () => {},
    readLines: async () => [],
    delete: async () => {},
  },
  proc: { run: () => { throw new Error("no proc in test"); } },
  diff: { preview: async () => {} },
  diag: { problems: async () => [] },
  editor: { selection: async () => null },
  workspace: { roots: async () => ["/p"], stateDir: async () => "/tmp/st", trusted: async () => true },
  log: () => {},
});

describe("benchModel", () => {
  type R = { kind: "ok"; toolOk: boolean } | { kind: "failed"; message: string };
  const fakeProbe = (results: R[] | ((req: { tool: { name: string } }) => R)) => {
    const reqs: { model: string; tool: { name: string }; reply: string; prompt: string; maxTurns: number; timeoutMs: number }[] = [];
    const fn = async (_c: unknown, req: (typeof reqs)[number]) => {
      reqs.push(req);
      return typeof results === "function" ? results(req) : (results[Math.min(reqs.length - 1, results.length - 1)] ?? { kind: "ok", toolOk: true });
    };
    return { fn: fn as never, reqs };
  };

  it("measures speed, tool reliability, edit and json when tool support is unknown", async () => {
    let t = 0;
    const clock: Clock = { now: () => t, setTimeout: systemClock.setTimeout };
    const { channel } = fakeChannel(
      [
        [text("a hash"), text(" map"), done(210)],
        [text('{"ok": true, "n": 1}'), done()],
      ],
      { onEvent: (ev) => { if (ev.kind === "text") t += 50; if (ev.kind === "done") t += 1000; } },
    );
    const probe = fakeProbe([{ kind: "ok", toolOk: true }]);
    const perf = await benchModel(channel, "m", clock, probe.fn);
    expect(perf.benchVersion).toBe(BENCH_VERSION);
    expect(perf.ttftMs).toBe(50);
    expect(perf.tokPerSec).toBeCloseTo(200, 1);
    expect(perf.toolReliability).toBe(1);
    expect(perf.editOk).toBe(true);
    expect(perf.jsonOk).toBe(true);
    expect(probe.reqs).toHaveLength(4);
    expect(probe.reqs.slice(0, 3).every((r) => r.tool.name === "bench_ping" && r.maxTurns === 3 && r.timeoutMs === 30000)).toBe(true);
    expect(probe.reqs[0].reply).toBe("pong");
    expect(probe.reqs[0].prompt).toContain("bench_ping");
    expect(probe.reqs[3].tool.name).toBe("EditFile");
    expect(probe.reqs[3].reply).toBe("edited");
    expect(probe.reqs[3].prompt).toContain("line3");
  });

  it("counts non-calling trials against reliability and reports malformed json", async () => {
    const { channel } = fakeChannel([[text("ok"), done(10)], [text("not json at all"), done()]]);
    const probe = fakeProbe((req) => ({ kind: "ok", toolOk: req.tool.name === "EditFile" ? false : false }));
    const perf = await benchModel(channel, "m", systemClock, probe.fn);
    expect(perf.toolReliability).toBe(0);
    expect(perf.editOk).toBe(false);
    expect(perf.jsonOk).toBe(false);
  });

  it("leaves toolReliability and editOk undefined when a probe fails", async () => {
    const { channel } = fakeChannel([[text("x"), done(10)], [text("{}"), done()]]);
    const probe = fakeProbe((_req) => ({ kind: "failed" as const, message: "boom" }));
    const perf = await benchModel(channel, "m", systemClock, probe.fn);
    expect(perf.toolReliability).toBeUndefined();
    expect(perf.editOk).toBeUndefined();
    expect(perf.ttftMs).toBeDefined();
  });

  it("leaves every field undefined when the model is unreachable", async () => {
    const { channel } = fakeChannel([], { fail: true });
    const probe = fakeProbe((_req) => ({ kind: "failed" as const, message: "boom" }));
    const perf = await benchModel(channel, "m", systemClock, probe.fn);
    expect(perf.ttftMs).toBeUndefined();
    expect(perf.tokPerSec).toBeUndefined();
    expect(perf.toolReliability).toBeUndefined();
    expect(perf.editOk).toBeUndefined();
    expect(perf.jsonOk).toBeUndefined();
    expect(perf.benchVersion).toBe(BENCH_VERSION);
  });

  it("skips the probe entirely when tools are disabled", async () => {
    const { channel } = fakeChannel([[text("x"), done(5)], [text("{}"), done()]], { cfgCaps: { tools: "none" } });
    const probe = fakeProbe([]);
    const perf = await benchModel(channel, "m", systemClock, probe.fn);
    expect(probe.reqs).toHaveLength(0);
    expect(perf.toolReliability).toBeUndefined();
    expect(perf.editOk).toBeUndefined();
    expect(perf.jsonOk).toBe(false);
  });

  it("estimates tokens from characters when done carries no usage", async () => {
    let t = 0;
    const clock: Clock = { now: () => t, setTimeout: systemClock.setTimeout };
    const { channel } = fakeChannel([[text("abcd"), text("efgh"), done()]], { onEvent: (ev) => { if (ev.kind === "text") t += 50; if (ev.kind === "done") t += 500; } });
    const perf = await benchModel(channel, "m", clock, fakeProbe([{ kind: "ok", toolOk: true }]).fn);
    expect(perf.ttftMs).toBe(50);
    expect(perf.tokPerSec).toBe(3.64);
  });

  it("leaves jsonOk undefined when only the json leg fails", async () => {
    let n = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        n++;
        if (n === 2) throw new Error("json boom");
        yield text("abcd");
        yield done(8);
      },
    };
    const channel = new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    const perf = await benchModel(channel, "m", systemClock, fakeProbe([{ kind: "ok", toolOk: true }]).fn);
    expect(perf.ttftMs).toBeDefined();
    expect(perf.toolReliability).toBe(1);
    expect(perf.editOk).toBe(true);
    expect(perf.jsonOk).toBeUndefined();
  });

  it("reports jsonOk false for braces that do not parse", async () => {
    const { channel } = fakeChannel([[text("x"), done(5)], [text("{not json}"), done()]]);
    const perf = await benchModel(channel, "m", systemClock, fakeProbe([{ kind: "ok", toolOk: true }]).fn);
    expect(perf.jsonOk).toBe(false);
  });
});


describe("modelCaps.perf schema", () => {
  it("loads channels yaml with and without persisted perf", () => {
    const cfg = loadEffectiveConfig(
      {
        "channels.yaml":
          "version: 1\nitems:\n  - id: c1\n    type: ollama\n    modelCaps:\n      m1:\n        tools: native\n        perf:\n          tokPerSec: 42.5\n          toolReliability: 0.67\n          benchedAt: 100\n          benchVersion: 1\n      m2:\n        tools: shim\n",
      },
      {},
      {},
      { trusted: true },
    );
    const m1 = cfg.channels[0].modelCaps.m1;
    expect(m1.perf).toMatchObject({ tokPerSec: 42.5, toolReliability: 0.67 });
    expect(cfg.channels[0].modelCaps.m2.perf).toBeUndefined();
    expect(cfg.errors).toEqual([]);
  });
});
