import { describe, expect, it } from "vitest";
import { ChannelError, type ChannelAdapter, type ChannelSpec } from "../src/api.js";
import { ChannelRegistry } from "../src/registry.js";
import { ChannelService } from "../src/service.js";

function adapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    type: "fake",
    listModels: async () => ["m1"],
    probeCaps: async (_c, _s, model) => ({ contextTokens: 8000 }),
    chat: async function* () {
      yield { kind: "done" };
    },
    ...over,
  };
}

function svc(listModels?: ChannelAdapter["listModels"]) {
  const registry = new ChannelRegistry();
  registry.register("fake", () => adapter(listModels ? { listModels } : {}));
  registry.register("ollama", () => adapter(listModels ? { listModels } : {}));
  const logs: string[] = [];
  const secrets = new Map<string, string>([["ref1", "s3cret"]]);
  const host = { secrets: { get: async (r: string) => secrets.get(r) }, log: (m: string) => logs.push(m) };
  const s = new ChannelService({ registry, adapterDeps: {} });
  return { s, host, logs };
}

const spec = (id: string, over: Partial<ChannelSpec> = {}): ChannelSpec => ({ id, type: "fake", enabled: true, ...over });

describe("ChannelService.rebuild", () => {
  it("skips disabled rows and applies the maxParallel defaults", async () => {
    const { s, host } = svc();
    await s.rebuild([spec("a"), spec("b", { enabled: false }), spec("c", { type: "ollama", maxParallel: 7 }), spec("d", { type: "ollama" })], host);
    expect(s.ids()).toEqual(["a", "c", "d"]);
    expect(s.require("a").cfg.maxParallel).toBe(4);
    expect(s.require("c").cfg.maxParallel).toBe(7);
    expect(s.require("d").cfg.maxParallel).toBe(1);
  });

  it("logs and skips unknown types without failing the rest", async () => {
    const { s, host, logs } = svc();
    await s.rebuild([spec("bad", { type: "nope" }), spec("good")], host);
    expect(s.ids()).toEqual(["good"]);
    expect(logs[0]).toContain("channel bad: unknown channel type: nope");
  });

  it("reads secrets through the host and returns them by ref", async () => {
    const { s, host } = svc();
    const secrets = await s.rebuild([spec("a", { secretRef: "ref1" }), spec("b", { secretRef: "missing" }), spec("c")], host);
    expect([...secrets.entries()]).toEqual([["ref1", "s3cret"]]);
    expect(s.ids()).toEqual(["a", "b", "c"]);
  });
});

describe("ChannelService lookups", () => {
  it("get/require; require throws the channel-not-configured message", async () => {
    const { s, host } = svc();
    await s.rebuild([spec("a")], host);
    expect(s.get("a")).toBeDefined();
    expect(s.get("x")).toBeUndefined();
    expect(() => s.require("x")).toThrow("channel x not configured");
  });

  it("health: missing / healthy / unhealthy / backoff", async () => {
    const { s, host } = svc();
    await s.rebuild([spec("a")], host);
    expect(s.health("nope")).toBe("missing");
    expect(s.health("a")).toBe("healthy");
    s.require("a").unhealthy = true;
    expect(s.health("a")).toBe("unhealthy");

    const rl = svc(async () => {
      throw new ChannelError("rate limited", 429, 60_000);
    });
    await rl.s.rebuild([spec("a")], rl.host);
    await expect(rl.s.listModels("a")).rejects.toThrow("rate limited");
    expect(rl.s.health("a")).toBe("backoff");
  });

  it("listModels/probe delegate and propagate adapter errors", async () => {
    const { s, host } = svc();
    await s.rebuild([spec("a")], host);
    expect(await s.listModels("a")).toEqual(["m1"]);
    expect(await s.probe("a", "m1")).toEqual({ contextTokens: 8000 });
    const bad = svc(async () => {
      throw new Error("down");
    });
    await bad.s.rebuild([spec("a")], bad.host);
    await expect(bad.s.listModels("a")).rejects.toThrow("down");
  });
});

describe("ChannelService.setSecret", () => {
  it("updates only channels whose secretRef matches and returns the count", async () => {
    const { s, host } = svc();
    await s.rebuild([spec("a", { secretRef: "r" }), spec("b", { secretRef: "r" }), spec("c", { secretRef: "other" }), spec("d")], host);
    expect(s.setSecret("r", "v")).toBe(2);
    expect(s.setSecret("nope", "v")).toBe(0);
    expect(s.setSecret("r", undefined)).toBe(2);
  });
});
