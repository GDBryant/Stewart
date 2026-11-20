import { describe, expect, it } from "vitest";
import { Core } from "../src/core.js";
import { fakeHost } from "@stewart/kernel";
import type { ChannelAdapter } from "@stewart/channels";
import type { ConfigLayer, ConfigStore } from "@stewart/config";

const memStore = (layer: ConfigLayer = {}): ConfigStore => ({ read: async () => ({ ...layer }), write: async (f, y) => void (layer[f] = y), delete: async (f) => void delete layer[f] });
const adapter: ChannelAdapter = { type: "fake", listModels: async () => [], probeCaps: async () => ({}), chat: async function* () {} };
const CHANNELS = "version: 1\nitems:\n  - id: a\n    type: fake\n    enabled: true\n  - id: b\n    type: fake\n    enabled: true\n    security:\n      passwords: false\n";

function mk(settings: string) {
  const core = new Core({
    defaults: { "channels.yaml": CHANNELS, "settings.yaml": settings },
    userConfig: memStore(),
    projectConfig: async () => memStore(),
    fetcher: async () => { throw new Error("no fetch"); },
    emitEvent: () => {},
  });
  core.channels.register("fake", () => adapter);
  return core;
}

describe("core applies business policy settings to channels", () => {
  it("defaults on; a channel override beats the global value", async () => {
    const core = mk("version: 1\n");
    await core.attachProject("p", fakeHost().host);
    expect(core.channelService.require("a").policyRules).toEqual(["passwords", "privacy"]);
    expect(core.channelService.require("b").policyRules).toEqual(["privacy"]);
  });

  it("global off applies to channels without an override", async () => {
    const core = mk("version: 1\nsecurity:\n  privacy: false\n");
    await core.attachProject("p", fakeHost().host);
    expect(core.channelService.require("a").policyRules).toEqual(["passwords"]);
    expect(core.channelService.require("b").policyRules).toEqual([]);
  });
});
