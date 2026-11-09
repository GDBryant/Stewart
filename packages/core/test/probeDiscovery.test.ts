import { describe, expect, it, vi } from "vitest";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";
import type { ChannelAdapter, ChatEvent } from "@stewart/channels";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import type { Fetcher } from "@stewart/kernel";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

const CHANNELS_YAML = `version: 1
items:
  - id: f1
    type: fake
    enabled: true
    modelCaps:
      m1-7b:
        tools: native
        vision: true
        reasoning: true
        imageGen: true
        contextTokens: 8192
  - id: f2
    type: fake
    enabled: true
    extraModels: ["m9"]
  - id: f3
    type: ghost
    enabled: true
    extraModels: ["g1"]
  - id: ev
    type: fake
    enabled: true
`;
const AGENTS_YAML = "version: 1\nitems:\n  - id: a1\n    channel: f1\n    model: m1-7b\n";

function probeAdapter(opts: { rankReply?: string; redModels?: Set<string> } = {}) {
  const rankPrompts: string[] = [];
  const adapter: ChannelAdapter = {
    type: "fake",
    listModels: async (cfg) => {
      if (cfg.id === "f1") return ["m1-7b", "m2"];
      if (cfg.id === "f2") throw new Error("list boom");
      return [];
    },
    probeCaps: async () => ({}),
    chat: async function* (cfg, _s, req) {
      const head = req.messages[0]?.content ?? "";
      if (head.includes("Rank these model candidates")) {
        rankPrompts.push(head);
        yield { kind: "text", text: opts.rankReply ?? "no idea" } as ChatEvent;
        yield { kind: "done" } as ChatEvent;
        return;
      }
      if (opts.redModels?.has(`${cfg.id}:${req.model}`)) {
        yield { kind: "done" } as ChatEvent;
        return;
      }
      yield { kind: "text", text: "OK" } as ChatEvent;
      yield { kind: "done", usage: { in: 1, out: 1 } } as ChatEvent;
    },
  };
  return { adapter, rankPrompts };
}

function mkCore(adapter: ChannelAdapter, opts: { fetcher?: Fetcher; channelsYaml?: string; agentsYaml?: string } = {}) {
  const core = new Core({
    fetcher: opts.fetcher ?? (async () => {
      throw new Error("no fetch");
    }),
    defaults: {
      "channels.yaml": opts.channelsYaml ?? CHANNELS_YAML,
      "agents.yaml": opts.agentsYaml ?? AGENTS_YAML,
    },
    userConfig: memStore(),
    projectConfig: async () => memStore(),
    emitEvent: () => {},
  });
  core.channels.register("fake", () => adapter);
  return { core };
}

type Snap = {
  status: string;
  ranking: boolean;
  items: { channel: string; model: string; state: string; reason?: string; attempts?: number }[];
};

const waitDone = async (core: Core, pid: string) => {
  await vi.waitFor(async () => {
    expect(((await core.dispatch("setup.probe.status", { projectId: pid })) as Snap).status).toBe("done");
  });
  return (await core.dispatch("setup.probe.status", { projectId: pid })) as Snap;
};

describe("setup.probe live discovery", () => {
  it("discovers models via listModels + extraModels, dedupes, and drops unconfigured channels", async () => {
    const { adapter } = probeAdapter({ redModels: new Set(["f2:m9"]) });
    const { core } = mkCore(adapter);
    const pid = "pd1";
    await core.attachProject(pid, fakeHost().host);
    await core.dispatch("setup.probe.start", { projectId: pid });
    const snap = await waitDone(core, pid);
    expect(snap.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["f1:m1-7b", "f1:m2", "f2:m9"]);
    expect(snap.items.find((i) => i.channel === "f1" && i.model === "m1-7b")?.state).toBe("green");
    expect(snap.items.find((i) => i.channel === "f2")?.state).toBe("red");
    expect(snap.items.some((i) => i.channel === "f3")).toBe(false);
    expect(snap.ranking).toBe(false);
  });

  it("evaluator ranking orders the tail and the rank prompt carries candidate details", async () => {
    const { adapter, rankPrompts } = probeAdapter({ rankReply: '{"order":["f2:m9","f1:m2"]}', redModels: new Set(["f2:m9"]) });
    const { core } = mkCore(adapter);
    const pid = "pd2";
    await core.attachProject(pid, fakeHost().host);
    await core.dispatch("setup.probe.start", { projectId: pid, evaluator: { channel: "ev", model: "em" } });
    const snap = await waitDone(core, pid);
    expect(snap.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["f2:m9", "f1:m2", "f1:m1-7b"]);
    expect(rankPrompts).toHaveLength(1);
    expect(rankPrompts[0]).toContain("tools=native");
    expect(rankPrompts[0]).toContain("8k ctx");
    expect(rankPrompts[0]).toContain("~7B");
  });

  it("falls back to deterministic order when the evaluator channel is missing or ranking yields no order", async () => {
    const expected = ["f1:m1-7b", "f1:m2", "f2:m9"];

    const missing = probeAdapter();
    const c1 = mkCore(missing.adapter);
    const p1 = "pd3a";
    await c1.core.attachProject(p1, fakeHost().host);
    await c1.core.dispatch("setup.probe.start", { projectId: p1, evaluator: { channel: "ghost", model: "x" } });
    const s1 = await waitDone(c1.core, p1);
    expect(s1.items.map((i) => `${i.channel}:${i.model}`)).toEqual(expected);

    const noOrder = probeAdapter({ rankReply: "the models are fine" });
    const c2 = mkCore(noOrder.adapter);
    const p2 = "pd3b";
    await c2.core.attachProject(p2, fakeHost().host);
    await c2.core.dispatch("setup.probe.start", { projectId: p2, evaluator: { channel: "ev", model: "em" } });
    const s2 = await waitDone(c2.core, p2);
    expect(s2.items.map((i) => `${i.channel}:${i.model}`)).toEqual(expected);
    expect(noOrder.rankPrompts).toHaveLength(1);
  });

  it("skips ranking entirely when every candidate is local", async () => {
    const { adapter, rankPrompts } = probeAdapter();
    const channelsYaml = `version: 1
items:
  - id: oll
    type: ollama
    baseUrl: http://oll
    enabled: true
  - id: ev
    type: fake
    enabled: true
`;
    const agentsYaml = "version: 1\nitems:\n  - id: a1\n    channel: oll\n    model: m\n";
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"OK"},"done":false}', '{"done":true}'] }]);
    const { core } = mkCore(adapter, { fetcher, channelsYaml, agentsYaml });
    const pid = "pd4";
    await core.attachProject(pid, fakeHost().host);
    await core.dispatch("setup.probe.start", {
      projectId: pid,
      candidates: [{ channel: "oll", model: "m" }],
      evaluator: { channel: "ev", model: "em" },
    });
    const snap = await waitDone(core, pid);
    expect(snap.items.map((i) => `${i.channel}:${i.model}`)).toEqual(["oll:m"]);
    expect(snap.items[0]?.state).toBe("green");
    expect(rankPrompts).toHaveLength(0);
  });
});

describe("setup.probe.retry", () => {
  it("re-queues non-green results after a finished run and keeps green ones", async () => {
    const { adapter } = probeAdapter({ redModels: new Set(["f2:m9"]) });
    const { core } = mkCore(adapter);
    const pid = "pd5";
    await core.attachProject(pid, fakeHost().host);
    await core.dispatch("setup.probe.start", {
      projectId: pid,
      candidates: [
        { channel: "f1", model: "m2" },
        { channel: "f2", model: "m9" },
      ],
    });
    const first = await waitDone(core, pid);
    expect(first.items.find((i) => i.channel === "f2")?.state).toBe("red");
    expect(first.items.find((i) => i.channel === "f2")?.attempts).toBe(1);

    const retry = (await core.dispatch("setup.probe.retry", { projectId: pid })) as Snap;
    expect(retry.status).toBe("running");
    const second = await waitDone(core, pid);
    const red = second.items.find((i) => i.channel === "f2");
    const green = second.items.find((i) => i.channel === "f1");
    expect(red?.state).toBe("red");
    expect(red?.attempts).toBe(2);
    expect(green?.state).toBe("green");
    expect(green?.attempts).toBe(1);
  });
});
