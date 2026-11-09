import { describe, expect, it } from "vitest";
import { BENCH_VERSION } from "@stewart/setup";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import { Core } from "../src/core.js";
import { fakeHost } from "@stewart/kernel";
import type { ConfigLayer, ConfigStore } from "@stewart/config";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

function mk(channelsYaml: string, agentsYaml: string, rolesYaml: string) {
  const core = new Core({
    defaults: { "channels.yaml": channelsYaml, "agents.yaml": agentsYaml, "roles.yaml": rolesYaml },
    userConfig: memStore(),
    projectConfig: async () => memStore(),
    fetcher: async () => {
      throw new Error("no fetch");
    },
    emitEvent: () => {},
  });
  return { core, fh: fakeHost() };
}

const AGENTS = "version: 1\nitems:\n  - id: a1\n    channel: b1\n    model: mD\n";
const ROLES = "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n    tools: []\n";

describe("setup.recommend bench", () => {
  it("probes only un-benched, non-imageGen models on enabled buildable channels", async () => {
    const probed: string[] = [];
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async (cfg) => {
        if (cfg.id === "b2") throw new Error("list boom");
        if (cfg.id === "b1") return ["mA", "mB", "mC", "mD"];
        if (cfg.id === "b3") return ["mE"];
        return [];
      },
      probeCaps: async (cfg, _s, model) => {
        probed.push(`${cfg.id}:${model}`);
        return {};
      },
      chat: async function* () {
        yield { kind: "text", text: "ok" } as ChatEvent;
        yield { kind: "done", usage: { in: 1, out: 1 } } as ChatEvent;
      },
    };
    const channelsYaml = `version: 1
items:
  - id: b1
    type: fake
    enabled: true
    extraModels: ["x9"]
    modelCaps:
      mC:
        perf: { benchedAt: 1, benchVersion: ${BENCH_VERSION} }
  - id: b2
    type: fake
    enabled: true
    extraModels: ["y1"]
  - id: b3
    type: fake
    enabled: true
  - id: b4
    type: ghost
    enabled: true
  - id: b5
    type: fake
    enabled: false
`;
    const { core, fh } = mk(channelsYaml, AGENTS, ROLES);
    core.channels.register("fake", () => adapter);
    const pid = "bench1";
    await core.attachProject(pid, fh.host);
    core.probeCache.set("b1:mA", { caps: { imageGen: true }, probedAt: 0 });
    core.probeCache.set("b1:mB", { caps: { perf: { benchedAt: 1, benchVersion: BENCH_VERSION } }, probedAt: 0 });
    core.probeCache.set("b3:mE", { caps: { imageGen: true }, probedAt: 0 });

    await core.dispatch("setup.recommend", { projectId: pid, mode: "rules", bench: true });

    expect(probed.sort()).toEqual(["b1:mD", "b1:x9"]);
    expect(core.probeCache.get("b1:mD")?.caps.perf?.benchVersion).toBe(BENCH_VERSION);
    expect(core.probeCache.get("b1:x9")?.caps.perf?.benchVersion).toBe(BENCH_VERSION);
    expect(core.probeCache.get("b2:y1")).toBeUndefined();
  });
});

describe("channel.probe", () => {
  it("returns ok:false with the error when probeCaps rejects", async () => {
    const adapter: ChannelAdapter = {
      type: "fake",
      listModels: async () => ["m1"],
      probeCaps: async () => {
        throw new Error("probe boom");
      },
      chat: async function* () {
        yield { kind: "done" } as ChatEvent;
      },
    };
    const channelsYaml = "version: 1\nitems:\n  - id: c1\n    type: fake\n    enabled: true\n";
    const agentsYaml = "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n";
    const rolesYaml = "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n    tools: []\n";
    const { core, fh } = mk(channelsYaml, agentsYaml, rolesYaml);
    core.channels.register("fake", () => adapter);
    const pid = "perr";
    await core.attachProject(pid, fh.host);
    const r = (await core.dispatch("channel.probe", { projectId: pid, channelId: "c1", model: "m1" })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("probe boom");
  });
});
