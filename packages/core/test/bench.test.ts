import { describe, expect, it } from "vitest";
import { BENCH_VERSION, benchModel } from "@stewart/setup";
import { ManagedChannel } from "@stewart/channels";
import type { ChannelAdapter, ChannelConfig, ChatEvent } from "@stewart/channels";
import { loadEffectiveConfig } from "@stewart/roles-skills";
import { Core } from "../src/core.js";
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
const pingCall = '<tool_call>{"name":"bench_ping","arguments":{"ok":true}}</tool_call>';
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

describe("channel.probe bench", () => {
  function benchCore(adapter: ChannelAdapter, capsYaml = ""): Core {
    const core = new Core({
      defaults: {
        "channels.yaml": `version: 1\nitems:\n  - id: c1\n    type: fake\n${capsYaml}`,
      },
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      fetcher: async () => { throw new Error("no fetch"); },
      emitEvent: () => {},
    });
    core.channels.register("fake", () => adapter);
    return core;
  }

  it("runs the bench on request, merges perf into caps and caches it", async () => {
    const { adapter } = fakeChannel([
      [text("hi"), done(8)],
      [text(pingCall), done()],
      [text(pingCall), done()],
      [text(pingCall), done()],
      [text(editCall), done()],
      [text('{"ok": true, "n": 1}'), done()],
    ]);
    const core = benchCore(adapter);
    await core.attachProject("p", fakeHost());
    const r = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m", bench: true })) as {
      ok: boolean; cached: boolean; caps: { perf?: { toolReliability?: number; jsonOk?: boolean; benchVersion: number } };
    };
    expect(r.ok).toBe(true);
    expect(r.caps.perf).toMatchObject({ toolReliability: 1, jsonOk: true, benchVersion: BENCH_VERSION });
    const again = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m", bench: true })) as { ok: boolean; cached: boolean };
    expect(again).toMatchObject({ ok: true, cached: true });
  });

  it("does not run the bench without the flag and skips image-gen models", async () => {
    let chats = 0;
    const { adapter } = fakeChannel([[text("x"), done()]], { caps: { imageGen: true } });
    const orig = adapter.chat.bind(adapter);
    adapter.chat = (c, s, r) => { chats++; return orig(c, s, r); };
    const core = benchCore(adapter);
    await core.attachProject("p", fakeHost());
    const plain = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m" })) as { ok: boolean; caps: { perf?: unknown } };
    expect(plain.ok).toBe(true);
    expect(plain.caps.perf).toBeUndefined();
    const benched = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m", bench: true, force: true })) as {
      ok: boolean; caps: { imageGen?: boolean; perf?: unknown };
    };
    expect(benched.ok).toBe(true);
    expect(benched.caps.imageGen).toBe(true);
    expect(benched.caps.perf).toBeUndefined();
    expect(chats).toBe(0);
  });
});

