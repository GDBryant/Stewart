import { describe, expect, it } from "vitest";
import { ChannelError, ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import type { AgentDef } from "@stewart/config";
import { runFunction } from "../src/api.js";

function channel(reply: ChatEvent[] | Error, onReq?: (req: { messages: { role: string; content: string }[]; tools?: unknown; responseSchema?: unknown }) => void): ManagedChannel {
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_c, _s, req) {
      onReq?.(req as never);
      if (reply instanceof Error) throw reply;
      for (const ev of reply) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

const agent: AgentDef = { id: "a", channel: "c", model: "m", effort: "medium" };
const schema = { type: "object", properties: { score: { type: "number" }, label: { type: "string", enum: ["ok", "bad"] } }, required: ["score", "label"] };
const run = (ch: ManagedChannel) => runFunction({ channel: ch, agent, system: "Score it.", input: "file x", schema, signal: new AbortController().signal });

describe("runFunction", () => {
  it("returns the validated object, with usage, and sends no tools", async () => {
    let seen: { messages: { role: string; content: string }[]; tools?: unknown; responseSchema?: unknown } | undefined;
    const ch = channel([{ kind: "text", text: '{"score": 3, "label": "ok"}' }, { kind: "done", usage: { in: 5, out: 2 }, costUsd: 0.5 }], (r) => (seen = r));
    expect(await run(ch)).toEqual({ ok: true, value: { score: 3, label: "ok" }, usage: { in: 5, out: 2 }, costUsd: 0.5 });
    expect(seen?.tools).toBeUndefined();
    expect(seen?.messages[0].content).toContain("Score it.");
    expect(seen?.messages[0].content).toContain('"required"');
    expect(seen?.messages[1]).toEqual({ role: "user", content: "file x" });
  });
  it("accepts a fenced block and prose around braces", async () => {
    expect(await run(channel([{ kind: "text", text: 'Here:\n```json\n{"score":1,"label":"bad"}\n```' }, { kind: "done" }]))).toMatchObject({ ok: true });
    expect(await run(channel([{ kind: "text", text: 'Sure {"score":1,"label":"bad"} done' }, { kind: "done" }]))).toMatchObject({ ok: true });
  });
  it("rejects non-JSON, arrays and schema violations", async () => {
    expect(await run(channel([{ kind: "text", text: "no idea" }, { kind: "done" }]))).toEqual({ ok: false, error: "reply is not a JSON object" });
    expect(await run(channel([{ kind: "text", text: "[1]" }, { kind: "done" }]))).toMatchObject({ ok: false });
    const bad = await run(channel([{ kind: "text", text: '{"score": "x", "label": "ok"}' }, { kind: "done" }]));
    expect(bad).toMatchObject({ ok: false });
    const missing = await run(channel([{ kind: "text", text: '{"score": 1}' }, { kind: "done" }]));
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("label") });
  });
  it("reports a channel error", async () => {
    expect(await run(channel(new Error("boom")))).toEqual({ ok: false, error: "boom" });
    const ch = channel(new Error("boom"));
    expect(await runFunction({ channel: ch, agent, system: "", input: "", schema, signal: new AbortController().signal })).toMatchObject({ ok: false });
  });
  it("sends the schema as responseSchema", async () => {
    let seen: { responseSchema?: unknown } | undefined;
    const ch = channel([{ kind: "text", text: '{"score":1,"label":"ok"}' }, { kind: "done" }], (r) => (seen = r));
    expect(await run(ch)).toMatchObject({ ok: true });
    expect(seen?.responseSchema).toEqual(schema);
  });
  it("retries once without responseSchema on a 4xx rejection", async () => {
    const seen: (unknown | undefined)[] = [];
    let calls = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* (_c, _s, r) {
        seen.push(r.responseSchema);
        if (++calls === 1) throw new ChannelError("response_format not supported", 400);
        yield { kind: "text", text: '{"score":2,"label":"ok"}' };
        yield { kind: "done" };
      },
    };
    const ch = new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    expect(await run(ch)).toMatchObject({ ok: true, value: { score: 2, label: "ok" } });
    expect(seen).toEqual([schema, undefined]);
  });
  it("fails when the retry without schema also 4xx-fails", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        throw new ChannelError("nope", 400);
      },
    };
    const ch = new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    expect(await run(ch)).toEqual({ ok: false, error: "nope" });
  });
  it("does not retry on a 5xx error", async () => {
    let calls = 0;
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* () {
        calls++;
        throw new ChannelError("server down", 500);
      },
    };
    const ch = new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    expect(await run(ch)).toEqual({ ok: false, error: "server down" });
    expect(calls).toBe(1);
  });
});
