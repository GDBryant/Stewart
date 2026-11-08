import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent, type ChatRequest } from "@stewart/channels";
import type { Clock, ToolSpec } from "@stewart/kernel";
import { createProbeLoop } from "../src/api.js";

const clock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } };

const tool: ToolSpec = {
  name: "bench_ping",
  description: "d",
  parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};

const req = (over: Partial<{ prompt: string; timeoutMs: number }> = {}) => ({
  model: "m",
  tool,
  reply: "pong",
  prompt: over.prompt ?? "call it",
  maxTurns: 3,
  timeoutMs: over.timeoutMs ?? 30_000,
});

function fakeChannel(turns: ChatEvent[][], onReq?: (req: ChatRequest) => void): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_cfg, _s, r) {
      onReq?.(r);
      for (const ev of turns[Math.min(i++, turns.length - 1)]) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

describe("createProbeLoop", () => {
  const probe = createProbeLoop({ clock });

  it("returns ok+toolOk when the model calls the tool, and feeds the reply back", async () => {
    const seen: ChatRequest[] = [];
    const ch = fakeChannel([
      [{ kind: "tool_calls", calls: [{ id: "1", name: "bench_ping", arguments: { ok: true } }] }, { kind: "done" }],
      [{ kind: "text", text: "done" }, { kind: "done" }],
    ], (r) => seen.push(r));
    const r = await probe(ch, req());
    expect(r).toEqual({ kind: "ok", toolOk: true });
    const sys = (seen[0].messages as { role: string; content: string }[]).find((m) => m.role === "system");
    expect(sys?.content).toContain("bench_ping");
    expect((seen[0].messages as { role: string; content: string }[]).some((m) => m.role === "user" && m.content === "call it")).toBe(true);
  });

  it("toolOk is false when the model never calls the tool", async () => {
    const ch = fakeChannel([[{ kind: "text", text: "no call" }, { kind: "done" }]]);
    expect(await probe(ch, req())).toEqual({ kind: "ok", toolOk: false });
  });

  it("a failed loop becomes a failed result, never a throw", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* () {
        throw new Error("provider down");
      },
    };
    const ch = new ManagedChannel(adapter, { id: "c", type: "f", enabled: true, maxParallel: 1 });
    const r = await probe(ch, req());
    expect(r.kind).toBe("failed");
    expect((r as { message: string }).message).toContain("provider down");
  });

  it("a hanging channel times out to a failed result", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* (_c, _s, r) {
        await new Promise((res, rej) => {
          r.signal.addEventListener("abort", () => rej(new Error("aborted")));
          setTimeout(() => rej(new Error("hung")), 5_000);
        });
      },
    };
    const ch = new ManagedChannel(adapter, { id: "c", type: "f", enabled: true, maxParallel: 1 });
    const r = await probe(ch, req({ timeoutMs: 20 }));
    expect(r.kind).toBe("failed");
  });
});
