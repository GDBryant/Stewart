import { afterEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/preact";
import { useSyncExternalStore } from "preact/compat";
import { useWizardDerived, type WizardDerivedInput } from "../src/wizardDerived.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply, type ChannelSummary } from "../src/bridge.js";

afterEach(cleanup);

const channels = [
  { id: "c1", type: "ollama", enabled: true },
  { id: "c2", type: "ollama", enabled: true },
] as ChannelSummary[];

const agents: [] = [];

function configReply(): { type: "config" } & ConfigReply {
  return {
    type: "config" as const,
    files: {},
    summary: { channels, agents, roles: [], skills: [], settings: {} },
    errors: [],
  };
}

describe("useWizardDerived excludeChannels filtering", () => {
  it("an excluded channel is dropped from okChannels, probe pairs and the evaluator picker", () => {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    act(() => bridge.inbound(configReply()));
    const base: WizardDerivedInput = { store, channels, agents, source: "existing", added: new Set(), evalChannel: "", evaluator: "" };
    const view = renderHook((excluded: Set<string> = new Set()) => {
      useSyncExternalStore((cb) => store.subscribe(cb), () => store.state);
      return useWizardDerived({ ...base, excluded });
    });
    // all ticked: both channels are offered; green test results put both in pairs
    expect(view.result.current.enabled.map((c) => c.id)).toEqual(["c1", "c2"]);
    act(() => {
      bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m1"] });
      bridge.inbound({ type: "channel.test.result", channelId: "c2", ok: true, models: ["m1"] });
    });
    expect(view.result.current.pairs).toEqual([{ channel: "c1", model: "m1" }, { channel: "c2", model: "m1" }]);
    expect(view.result.current.evalChannels.map((c) => c.id)).toEqual(["c1", "c2"]);
    // untick c1: it vanishes from okChannels, pairs and the evaluator picker
    act(() => view.rerender(new Set(["c1"])));
    const d = view.result.current;
    expect(d.okChannels.map((c) => c.id)).toEqual(["c2"]);
    expect(d.pairs).toEqual([{ channel: "c2", model: "m1" }]);
    expect(d.evalChannels.map((c) => c.id)).toEqual(["c2"]);
    expect(d.evalChan).toBe("c2");
  });
});
