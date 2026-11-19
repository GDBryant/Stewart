import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChatEvent } from "../src/api.js";
import { ChannelRegistry, ManagedChannel } from "../src/registry.js";
import { ChannelService } from "../src/service.js";
import { Semaphore } from "../src/semaphore.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

function gated(): { adapter: ChannelAdapter; open: () => void; started: () => number } {
  let started = 0;
  let gate!: () => void;
  const opened = new Promise<void>((r) => (gate = r));
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async () => [],
    probeCaps: async () => ({}),
    chat: async function* (): AsyncGenerator<ChatEvent> {
      started++;
      await opened;
      yield { kind: "done" };
    },
  };
  return { adapter, open: gate, started: () => started };
}

const drain = async (mc: ManagedChannel) => {
  for await (const _ of mc.chat({ model: "m", messages: [] })) void _;
};

describe("Semaphore", () => {
  it("hands a released slot straight to the next waiter", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const order: number[] = [];
    const w = s.acquire().then(() => order.push(1));
    s.release();
    await w;
    expect(s.active).toBe(1);
    expect(order).toEqual([1]);
  });

  it("never exceeds the limit when a caller arrives right after release", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    let second = false;
    let third = false;
    void s.acquire().then(() => (second = true));
    s.release();
    void s.acquire().then(() => (third = true));
    await tick();
    expect(second).toBe(true);
    expect(third).toBe(false);
    expect(s.active).toBe(1);
    expect(s.queued).toBe(1);
  });

  it("a raised limit admits waiters; a lowered one drains below it first", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    let woke = false;
    void s.acquire().then(() => (woke = true));
    s.setLimit(2);
    await tick();
    expect(woke).toBe(true);
    expect(s.active).toBe(2);
    s.setLimit(1);
    let late = false;
    void s.acquire().then(() => (late = true));
    s.release();
    await tick();
    expect(late).toBe(false);
    s.release();
    await tick();
    expect(late).toBe(true);
  });
});

describe("ManagedChannel limits", () => {
  it("runs one chat at a time at maxParallel 1", async () => {
    const g = gated();
    const mc = new ManagedChannel(g.adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    const all = [drain(mc), drain(mc), drain(mc)];
    await tick();
    expect(g.started()).toBe(1);
    g.open();
    await Promise.all(all);
    expect(g.started()).toBe(3);
  });

  it("admit() limits tasks independently of requests and release is idempotent", async () => {
    const mc = new ManagedChannel(gated().adapter, { id: "c", type: "fake", enabled: true, maxParallel: 1 });
    const r1 = await mc.admit();
    let got = false;
    void mc.admit().then(() => (got = true));
    await tick();
    expect(got).toBe(false);
    r1();
    r1();
    await tick();
    expect(got).toBe(true);
  });
});

describe("ChannelService.rebuild keeps limiter state", () => {
  function svc(adapter: ChannelAdapter) {
    const registry = new ChannelRegistry();
    registry.register("ollama", () => adapter);
    const host = { secrets: { get: async () => undefined }, log: () => {} };
    return { s: new ChannelService({ registry, adapterDeps: {} }), host };
  }
  const row = { id: "o", type: "ollama", enabled: true };

  it("a reload mid-run does not let a second request through", async () => {
    const g = gated();
    const { s, host } = svc(g.adapter);
    await s.rebuild([row], host);
    const first = drain(s.require("o"));
    await tick();
    await s.rebuild([row], host);
    const second = drain(s.require("o"));
    await tick();
    expect(g.started()).toBe(1);
    g.open();
    await Promise.all([first, second]);
    expect(g.started()).toBe(2);
  });

  it("applies a changed maxParallel and resets the breaker on reuse", async () => {
    const { s, host } = svc(gated().adapter);
    await s.rebuild([row], host);
    const mc = s.require("o");
    mc.unhealthy = true;
    await s.rebuild([{ ...row, maxParallel: 3 }], host);
    expect(s.require("o")).toBe(mc);
    expect(mc.cfg.maxParallel).toBe(3);
    expect(mc.unhealthy).toBe(false);
  });

  it("builds a fresh channel when the type changes and drops removed rows", async () => {
    const registry = new ChannelRegistry();
    registry.register("ollama", () => gated().adapter);
    registry.register("openai-compatible", () => gated().adapter);
    const s = new ChannelService({ registry, adapterDeps: {} });
    const host = { secrets: { get: async () => undefined }, log: () => {} };
    await s.rebuild([row], host);
    const old = s.require("o");
    await s.rebuild([{ ...row, type: "openai-compatible" }], host);
    expect(s.require("o")).not.toBe(old);
    await s.rebuild([], host);
    expect(s.get("o")).toBeUndefined();
  });
});
