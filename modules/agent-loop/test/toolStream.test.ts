import { describe, expect, it } from "vitest";
import { ManagedChannel, type ChannelAdapter, type ChatEvent } from "@stewart/channels";
import { DEFAULT_LIMITS } from "@stewart/budget";
import { ToolRegistry } from "@stewart/tools";
import type { ChatMessage } from "@stewart/kernel";
import type { ApprovalDecision } from "@stewart/permissions";
import { ToolLoop } from "../src/api.js";
import { streamTurn, type StreamRequest, type TurnState } from "../src/toolStream.js";

type Step = ChatEvent[] | Error | string;

/** Each chat call plays the next step: events to yield, or a value to throw. */
function scripted(steps: Step[], seen?: unknown[]): ManagedChannel {
  let i = 0;
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => ["m"],
    probeCaps: async () => ({}),
    chat: async function* (_cfg, _s, req) {
      seen?.push(req);
      const step = steps[Math.min(i++, steps.length - 1)];
      if (typeof step === "string") throw step;
      if (step instanceof Error) throw step;
      for (const ev of step) yield ev;
    },
  };
  return new ManagedChannel(adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
}

const sig = () => new AbortController().signal;
const approve = async (): Promise<ApprovalDecision> => ({ kind: "approved" });
const hist: ChatMessage[] = [{ role: "user", content: "go" }];
const listener = {};
const newTurn = (): TurnState => ({ text: "", open: true });
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  model: "m",
  outbound: hist,
  listener,
  signal: sig(),
  turn: newTurn(),
  ...over,
});
const deps = (ch: ManagedChannel, over: { toolsMode?: "native" | "shim"; modelCallTimeoutMs?: number } = {}) => ({
  channel: ch,
  registry: new ToolRegistry([]),
  toolsMode: over.toolsMode ?? ("shim" as const),
  modelCallTimeoutMs: over.modelCallTimeoutMs ?? 0,
});

describe("streamTurn", () => {
  it("forwards tool specs only in native mode", async () => {
    const seen: unknown[] = [];
    await streamTurn(deps(scripted([[{ kind: "done" }]], seen), { toolsMode: "native" }), req());
    expect(seen[0]).toMatchObject({ model: "m", messages: hist });
    expect((seen[0] as { tools?: unknown }).tools).toEqual([]);

    const shimSeen: unknown[] = [];
    await streamTurn(deps(scripted([[{ kind: "done" }]], shimSeen)), req());
    expect((shimSeen[0] as { tools?: unknown }).tools).toBeUndefined();
  });

  it("reports a timed-out call as call_timeout", async () => {
    const hang: ChannelAdapter = {
      type: "fake",
      listModels: async () => [],
      probeCaps: async () => ({}),
      chat: async function* (_c, _s, r) {
        await new Promise((_, rej) => r.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      },
    };
    const slow = new ManagedChannel(hang, { id: "c", type: "f", enabled: true, maxParallel: 1 });
    const s = await streamTurn(deps(slow, { modelCallTimeoutMs: 5 }), req());
    expect(s.failed?.message).toBe("model call timed out after 5ms");
    expect((s.failed as { code?: string }).code).toBe("call_timeout");
  });

  it("passes a thrown Error through without a code", async () => {
    const boom = new Error("boom");
    const s = await streamTurn(deps(scripted([boom])), req());
    expect(s.failed).toBe(boom);
    expect((s.failed as { code?: string }).code).toBeUndefined();
  });

  it("wraps a non-Error throw in an Error", async () => {
    const s = await streamTurn(deps(scripted(["plain string"])), req());
    expect(s.failed).toBeInstanceOf(Error);
    expect(s.failed?.message).toBe("plain string");
  });

  it("rethrows when the caller's signal aborts", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(streamTurn(deps(scripted([new Error("late")])), req({ signal: ctl.signal }))).rejects.toThrow("late");
  });
});

describe("ToolLoop truncation and failure classification", () => {
  const loopWith = (ch: ManagedChannel, maxTruncationRetries: number) =>
    new ToolLoop(ch, new ToolRegistry([]), approve, { limits: { ...DEFAULT_LIMITS, maxTruncationRetries } });

  it("treats a stalled stream as truncated and retries", async () => {
    const ch = scripted([new Error("stream stalled"), [{ kind: "text", text: "ok" }, { kind: "done" }]]);
    const r = await loopWith(ch, 1).run("m", hist, {}, sig());
    expect(r.kind).toBe("completed");
  });

  it("fails with truncated once retries are exhausted", async () => {
    const coded = Object.assign(new Error("cut"), { code: "truncated" });
    const r = await loopWith(scripted([coded]), 0).run("m", hist, {}, sig());
    expect(r).toMatchObject({ kind: "failed", code: "truncated", message: "cut" });
  });

  it("does not retry an ordinary error and keeps its code", async () => {
    const plain = Object.assign(new Error("nope"), { code: "rate_limited" });
    const r = await loopWith(scripted([plain, [{ kind: "done" }]]), 3).run("m", hist, {}, sig());
    expect(r).toMatchObject({ kind: "failed", code: "rate_limited", message: "nope" });
  });
});
