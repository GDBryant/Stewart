import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import {
  fallbackOrder,
  normalizeReason,
  orderSmokeCandidates,
  rankCandidates,
  SetupProbeRunner,
  smokeModel,
  type SmokeChannel,
} from "../src/probe.js";

const never = new AbortController().signal;

function chan(events: (ChatEvent | "hang" | Error)[], hooks?: { onCall?(): void }): SmokeChannel {
  return {
    chat: async function* (req: ChatRequest) {
      hooks?.onCall?.();
      for (const e of events) {
        if (req.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (e === "hang") await new Promise(() => {});
        if (e instanceof Error) throw e;
        yield e;
      }
    },
  };
}

const text = (t: string): ChatEvent => ({ kind: "text", text: t });
const done: ChatEvent = { kind: "done" };
const calls = (c: SmokeChannel) => {
  let n = 0;
  const orig = c.chat.bind(c);
  c.chat = (req) => {
    n++;
    return orig(req);
  };
  return () => n;
};

describe("smokeModel", () => {
  it("green on a short text reply", async () => {
    const r = await smokeModel(chan([text("OK"), done]), "m", { signal: never });
    expect(r.state).toBe("green");
  });

  it("red on provider error, empty response, tool-only output and missing done", async () => {
    expect((await smokeModel(chan([new Error("HTTP 401")]), "m", { signal: never })).state).toBe("red");
    const e1 = await smokeModel(chan([done]), "m", { signal: never });
    expect(e1).toMatchObject({ state: "red", reason: "empty response" });
    const e2 = await smokeModel(chan([{ kind: "tool_calls", calls: [{ id: "1", name: "t", arguments: {} }] }, done]), "m", { signal: never });
    expect(e2).toMatchObject({ state: "red", reason: "tool calls but no text" });
    const e3 = await smokeModel(chan([text("hi")]), "m", { signal: never });
    expect(e3).toMatchObject({ state: "red", reason: "stream ended without completion" });
  });

  it("orange on timeout, aborted on outer cancel", async () => {
    const t = await smokeModel(chan(["hang"]), "m", { signal: never, timeoutMs: 15 });
    expect(t.state).toBe("orange");
    expect(t.reason).toContain("15ms");
    const ctrl = new AbortController();
    const p = smokeModel(chan(["hang"]), "m", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    expect((await p).state).toBe("aborted");
  });
});

describe("SetupProbeRunner", () => {
  const mk = () => {
    const channels = new Map<string, SmokeChannel>();
    const runner = new SetupProbeRunner({
      channelFor: (id) => channels.get(id),
      now: () => 0,
      timeoutMs: 50,
    });
    return { runner, channels };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("probes one at a time in order and marks green", async () => {
    const { runner, channels } = mk();
    let active = 0;
    let max = 0;
    channels.set("c", {
      chat: async function* (req: ChatRequest) {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        yield text("OK");
        yield done;
        active--;
      },
    });
    runner.start({
      signature: "s",
      priority: [
        { channel: "c", model: "a" },
        { channel: "c", model: "b" },
      ],
      rest: Promise.resolve([]),
    });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(max).toBe(1);
    const s = runner.snapshot();
    expect(s.items.map((i) => i.state)).toEqual(["green", "green"]);
    expect(s.green).toHaveLength(2);
  });

  it("dedupes candidates and returns cached snapshot for the same signature", async () => {
    const { runner, channels } = mk();
    const n = calls((channels.set("c", chan([text("OK"), done])), channels.get("c")!));
    const cands = [
      { channel: "c", model: "a" },
      { channel: "c", model: "a" },
    ];
    runner.start({ signature: "s", priority: cands, rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(n()).toBe(1);
    runner.start({ signature: "s", priority: cands, rest: Promise.resolve([]) });
    await flush();
    expect(n()).toBe(1);
    expect(runner.snapshot().items).toHaveLength(1);
  });

  it("appends the ranked tail after priority items and skips unknown channels as red", async () => {
    const { runner, channels } = mk();
    channels.set("c", chan([text("OK"), done]));
    runner.start({
      signature: "s",
      priority: [{ channel: "c", model: "local" }],
      rest: Promise.resolve([
        { channel: "c", model: "remote" },
        { channel: "gone", model: "x" },
      ]),
    });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const s = runner.snapshot();
    expect(s.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["c:local", "c:remote", "gone:x"]);
    expect(s.items[2].state).toBe("red");
    expect(s.items[2].reason).toBe("channel not configured");
  });

  it("cancel aborts the in-flight probe and marks the rest skipped", async () => {
    const { runner, channels } = mk();
    channels.set("c", chan(["hang"]));
    runner.start({
      signature: "s",
      priority: [
        { channel: "c", model: "a" },
        { channel: "c", model: "b" },
      ],
      rest: Promise.resolve([]),
    });
    await vi.waitFor(() => expect(runner.snapshot().items[0]?.state).toBe("running"));
    runner.cancel();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("cancelled"));
    const s = runner.snapshot();
    expect(s.items.map((i) => i.state)).toEqual(["skipped", "skipped"]);
    expect(s.green).toHaveLength(0);
    runner.cancel(); // idempotent
    expect(runner.snapshot().status).toBe("cancelled");
  });

  it("retry re-probes only non-green results", async () => {
    const { runner, channels } = mk();
    let fail = true;
    channels.set("c", {
      chat: async function* () {
        if (fail) throw new Error("boom");
        yield text("OK");
        yield done;
      },
    });
    runner.start({
      signature: "s",
      priority: [
        { channel: "c", model: "a" },
        { channel: "c", model: "b" },
      ],
      rest: Promise.resolve([]),
    });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(runner.snapshot().items.every((i) => i.state === "red")).toBe(true);
    fail = false;
    runner.retry();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(runner.snapshot().items.every((i) => i.state === "green")).toBe(true);
    const before = runner.snapshot().items.length;
    runner.retry(); // all green → no-op
    expect(runner.snapshot().items).toHaveLength(before);
  });

  it("emits probe.state snapshots on transitions", async () => {
    const snaps: string[] = [];
    const channels = new Map<string, SmokeChannel>([["c", chan([text("OK"), done])]]);
    const runner = new SetupProbeRunner({
      channelFor: (id) => channels.get(id),
      onEvent: (ev) => snaps.push(`${ev.snapshot.status}:${ev.snapshot.items[0]?.state ?? "-"}`),
      timeoutMs: 50,
    });
    runner.start({ signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(snaps.length).toBeGreaterThan(2);
    expect(snaps.at(-1)).toBe("done:green");
  });

  it("records queue wait separately from probe duration", async () => {
    let t = 0;
    const channels = new Map<string, SmokeChannel>();
    channels.set("c", {
      chat: async function* () {
        t += 500;
        yield text("OK");
        yield done;
      },
    });
    const runner = new SetupProbeRunner({ channelFor: (id) => channels.get(id), now: () => t, timeoutMs: 50 });
    runner.start({
      signature: "s",
      priority: [
        { channel: "c", model: "a" },
        { channel: "c", model: "b" },
      ],
      rest: Promise.resolve([]),
    });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const items = runner.snapshot().items;
    expect(items[0].waitMs).toBe(0);
    expect(items[1].waitMs).toBe(500);
    expect(items[0].attempts).toBe(1);
    expect(runner.snapshot().counts.green).toBe(2);
    expect(runner.snapshot().runId).toBe(1);
  });

  it("is idempotent for repeated starts with the same signature", async () => {
    const { runner, channels } = mk();
    const n = calls((channels.set("c", chan([text("OK"), done])), channels.get("c")!));
    const opts = { signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) };
    runner.start(opts);
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const before = n();
    const snap = runner.start(opts);
    await flush();
    expect(n()).toBe(before);
    expect(snap.runId).toBe(1);
  });

  it("a different signature mid-run cancels the old run and discards its late results", async () => {
    const channels = new Map<string, SmokeChannel>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    channels.set("slow", {
      chat: async function* (req: ChatRequest) {
        await gate;
        if (req.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield text("OK");
        yield done;
      },
    });
    channels.set("fast", chan([text("OK"), done]));
    const runner = new SetupProbeRunner({ channelFor: (id) => channels.get(id), timeoutMs: 1000 });
    runner.start({ signature: "s1", priority: [{ channel: "slow", model: "a" }], rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner.snapshot().items[0]?.state).toBe("running"));
    const snap2 = runner.start({
      signature: "s2",
      priority: [
        { channel: "fast", model: "b" },
        { channel: "slow", model: "a" },
      ],
      rest: Promise.resolve([]),
    });
    expect(snap2.runId).toBe(2);
    release();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const s = runner.snapshot();
    expect(s.runId).toBe(2);
    expect(s.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["fast:b", "slow:a"]);
    // slow:a was re-probed by run 2 (also green); the run-1 late result never wrote.
    expect(s.items.every((i) => i.state === "green")).toBe(true);
  });

  it("skips same-channel candidates when an adapter ignores abort, without overlapping requests", async () => {
    let calls = 0;
    const channels = new Map<string, SmokeChannel>();
    channels.set("c", {
      chat: async function* () {
        calls++;
        await new Promise(() => {}); // ignores the abort signal entirely
        yield text("OK");
        yield done;
      },
    });
    channels.set("d", chan([text("OK"), done]));
    const runner = new SetupProbeRunner({ channelFor: (id) => channels.get(id), timeoutMs: 30, drainMs: 20 });
    runner.start({
      signature: "s",
      priority: [
        { channel: "c", model: "a" },
        { channel: "c", model: "b" },
        { channel: "d", model: "x" },
      ],
      rest: Promise.resolve([]),
    });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"), { timeout: 2000 });
    const s = runner.snapshot();
    expect(s.items.map((i) => i.state)).toEqual(["orange", "skipped", "green"]);
    expect(s.items[1].reason).toContain("did not terminate");
    expect(calls).toBe(1); // the wedged channel was never re-entered
    expect(s.counts.skipped).toBe(1);
  });

  it("cancel before the deadline yields cancelled/skipped; timeout yields done/orange — one terminal state each", async () => {
    const channels = new Map<string, SmokeChannel>();
    channels.set("c", chan(["hang"]));
    const runner = new SetupProbeRunner({ channelFor: (id) => channels.get(id), timeoutMs: 5000 });
    runner.start({ signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) });
    runner.cancel();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("cancelled"));
    expect(runner.snapshot().items[0].state).toBe("skipped");

    const runner2 = new SetupProbeRunner({ channelFor: (id) => channels.get(id), timeoutMs: 30 });
    runner2.start({ signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner2.snapshot().status).toBe("done"));
    expect(runner2.snapshot().items[0].state).toBe("orange");
    runner2.cancel(); // late cancel is a no-op on a finished run
    expect(runner2.snapshot().status).toBe("done");
  });

  it("retry is bounded and preserves prior attempt diagnostics", async () => {
    const channels = new Map<string, SmokeChannel>();
    let calls = 0;
    channels.set("c", {
      chat: async function* () {
        calls++;
        throw new Error("boom");
      },
    });
    const runner = new SetupProbeRunner({ channelFor: (id) => channels.get(id), timeoutMs: 50, maxAttempts: 2 });
    runner.start({ signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    expect(runner.snapshot().items[0]).toMatchObject({ state: "red", reason: "boom", attempts: 1 });
    runner.retry();
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const second = runner.snapshot().items[0];
    expect(second).toMatchObject({ state: "red", attempts: 2, lastReason: "boom" });
    runner.retry(); // attempts capped → no-op
    await flush();
    expect(runner.snapshot().items[0].attempts).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("normalizeReason", () => {
  it("strips provider bodies, collapses whitespace and truncates", () => {
    expect(normalizeReason("POST /chat/completions → 500: {\"error\":\"secret body\"}")).toBe("POST /chat/completions → 500");
    expect(normalizeReason("probe → 401: unauthorized")).toBe("probe → 401");
    expect(normalizeReason("HTTP 429: rate limited\nmore detail")).toBe("HTTP 429");
    expect(normalizeReason(`err ${"x".repeat(300)}`).length).toBeLessThanOrEqual(160);
    expect(normalizeReason("  plain   error  ")).toBe("plain error");
  });
});

describe("sanitizeReason dep", () => {
  it("is applied to stored reasons after normalization", async () => {
    const channels = new Map<string, SmokeChannel>();
    channels.set("c", {
      chat: async function* () {
        throw new Error("POST /x → 500 Bearer abc123 token");
      },
    });
    const runner = new SetupProbeRunner({
      channelFor: (id) => channels.get(id),
      timeoutMs: 50,
      sanitizeReason: (r) => r.replace(/Bearer abc123 token/, "[REDACTED]"),
    });
    runner.start({ signature: "s", priority: [{ channel: "c", model: "a" }], rest: Promise.resolve([]) });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("done"));
    const item = runner.snapshot().items[0];
    expect(item.state).toBe("red");
    expect(item.reason).toBe("POST /x → 500 [REDACTED]");
  });
});

describe("ordering", () => {
  const c = (channel: string, channelType: string, model: string, hasAgent = false, sizeB?: number) => ({
    channel,
    channelType,
    model,
    hasAgent,
    sizeB,
  });

  it("puts ollama first, claude-cli second, others last", () => {
    const { priority, rest } = orderSmokeCandidates([
      c("r", "openai-compatible", "gpt"),
      c("o", "ollama", "qwen:7b", false, 7),
      c("cl", "claude-cli", "sonnet"),
      c("o2", "ollama", "llama:3b", false, 3),
    ]);
    expect(priority.map((p) => `${p.channel}:${p.model}`)).toEqual(["o2:llama:3b", "o:qwen:7b", "cl:sonnet"]);
    expect(rest.map((p) => `${p.channel}:${p.model}`)).toEqual(["r:gpt"]);
  });

  it("fallbackOrder prefers agents then smaller models then name", () => {
    const out = fallbackOrder([c("a", "x", "big:70b", false, 70), c("b", "x", "small:1b", true, 1), c("c", "x", "mid:7b", false, 7)]);
    expect(out.map((x) => x.channel)).toEqual(["b", "c", "a"]);
  });
});

describe("rankCandidates", () => {
  const rc = (channel: string, model: string, channelType = "openai-compatible") => ({ channel, model, channelType });
  const ranker = (reply: (ChatEvent | "hang")[] | Error) => ({
    chat: async function* (): AsyncGenerator<ChatEvent> {
      if (reply instanceof Error) throw reply;
      for (const e of reply) {
        if (e === "hang") await new Promise(() => {});
        else yield e;
      }
    },
  });

  it("validates the ranking: unknown and duplicate ids dropped, omitted appended in fallback order", async () => {
    const cands = [rc("c", "b"), rc("c", "a"), rc("c", "z")];
    const reply = [text('{"order":["c:z","c:nope","c:z","c:a"]}'), done];
    const r = await rankCandidates(cands, ranker(reply), "m");
    expect(r?.map((x) => x.model)).toEqual(["z", "a", "b"]);
  });

  it("returns undefined on unparseable replies and chat failures", async () => {
    const cands = [rc("c", "a")];
    expect(await rankCandidates(cands, ranker([text("no json"), done]), "m")).toBeUndefined();
    expect(await rankCandidates(cands, ranker(new Error("down")), "m")).toBeUndefined();
    expect(await rankCandidates(cands, ranker(["hang"]), "m", { timeoutMs: 10 })).toBeUndefined();
  });

  it("empty candidate list short-circuits", async () => {
    expect(await rankCandidates([], ranker([]), "m")).toEqual([]);
  });
});
