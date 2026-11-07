import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import { Core } from "../src/core.js";
import type { ConfigStore } from "@stewart/config";
import { fakeHost } from "@stewart/kernel";

describe("channel.probe catalog info", () => {
  function catalogCore(adapter: ChannelAdapter): Core {
    const core = new Core({
      defaults: { "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: fake\n" },
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      fetcher: async () => { throw new Error("no fetch"); },
      emitEvent: () => {},
    });
    core.channels.register("fake", () => adapter);
    return core;
  }

  function memStore(): ConfigStore {
    const layer: Record<string, string | undefined> = {};
    return { read: async () => ({ ...layer }), write: async (f, y) => { layer[f] = y; } };
  }

  function fakeAdapter(priceList?: Record<string, { inPerMTok: number; outPerMTok: number }>): ChannelAdapter {
    return {
      type: "fake",
      listModels: async () => ["gpt-5-mini"],
      probeCaps: async () => ({}),
      chat: async function* (): AsyncIterable<ChatEvent> {},
      ...(priceList ? { priceList: async () => priceList } : {}),
    };
  }

  it("prefers live provider pricing over the bundled catalog", async () => {
    const core = catalogCore(fakeAdapter({ "gpt-5-mini": { inPerMTok: 9, outPerMTok: 9 } }));
    await core.attachProject("p", fakeHost().host);
    const r = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "gpt-5-mini" })) as {
      ok: boolean; catalog?: { inPerMTok: number; source: string };
    };
    expect(r.catalog).toEqual({ inPerMTok: 9, outPerMTok: 9, source: "live" });
  });

  it("falls back to the catalog and reports it absent for unknown models", async () => {
    const core = catalogCore(fakeAdapter());
    await core.attachProject("p", fakeHost().host);
    const known = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "gpt-5-mini" })) as {
      ok: boolean; catalog?: { inPerMTok: number; source: string };
    };
    expect(known.catalog?.inPerMTok).toBe(0.25);
    expect(known.catalog?.source).toMatch(/^catalog \d{4}-\d{2}$/);
    const unknown = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "weird-local-1" })) as {
      ok: boolean; catalog?: unknown;
    };
    expect(unknown.catalog).toBeUndefined();
  });
});
