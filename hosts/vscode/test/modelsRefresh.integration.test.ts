import { describe, expect, it, vi } from "vitest";
import { Core, fakeHost, type ConfigLayer, type ConfigStore, type ManagedChannel } from "@stewart/core";
import { createMessageDispatcher, type RouteMessage } from "../src/messageDispatcher.js";
import { route, type RouteCtx } from "../src/routes.js";
import { Store } from "../../../packages/webview/src/state.js";
import { MockBridge, type Inbound, type Outbound } from "../../../packages/webview/src/bridge.js";

const CHANNELS_YAML = `version: 1
items:
  - id: c1
    type: ollama
    enabled: true
`;
const AGENTS_YAML = `version: 1
items:
  - id: a1
    channel: c1
    model: m1
`;
const ROLES_YAML = `version: 1
items:
  - id: lead
    enabled: true
    agent: a1
`;

const itemIds = (yaml: string | undefined): string[] => [...(yaml ?? "").matchAll(/^\s+- id: (.+)$/gm)].map((m) => m[1].trim());

const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 2000 });

async function rig(models: string[] = ["m1", "m2", "m3", "m4"]) {
  const layer: ConfigLayer = { "channels.yaml": CHANNELS_YAML, "agents.yaml": AGENTS_YAML, "roles.yaml": ROLES_YAML };
  const writes = { fail: false };
  const userConfig: ConfigStore = {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      if (writes.fail) throw new Error("write failed");
      layer[file] = yaml;
    },
  };
  const bridge = new MockBridge();
  const posted: Record<string, unknown>[] = [];
  const core = new Core({
    fetcher: async () => {
      throw new Error("no fetch");
    },
    defaults: {},
    userConfig,
    projectConfig: async () => ({ read: async () => ({}), write: async () => {} }),
    emitEvent: (ev) => bridge.inbound({ type: "event", ev }),
  });
  await core.attachProject("workspace", fakeHost().host);
  const managed = {
    cfg: { id: "c1", type: "ollama" },
    listModels: async () => models,
    priceList: async () => undefined,
  } as unknown as ManagedChannel;
  vi.spyOn(core.channelService, "get").mockImplementation((id) => (id === "c1" ? managed : undefined));
  const panel = {
    webview: {
      postMessage: async (m: Record<string, unknown>) => {
        posted.push(m);
        bridge.inbound(m as Inbound);
        return true;
      },
    },
  };
  const ctx = { core, host: { userConfigDir: async () => "/cfg" }, panel, api: {} } as unknown as RouteCtx;
  const dispatch = createMessageDispatcher((m) => route(ctx, m));
  const dispatched: Promise<void>[] = [];
  vi.spyOn(bridge, "post").mockImplementation((m: Outbound) => {
    bridge.sent.push(m);
    dispatched.push(dispatch(m as RouteMessage));
  });
  const store = new Store(bridge);
  const drain = async () => {
    for (let i = 0; i < dispatched.length; i++) await dispatched[i];
  };
  const nextQuestion = async (text: string) => {
    await waitFor(() => expect(store.state.questions.some((q) => q.question.includes(text))).toBe(true));
    return store.state.questions.find((q) => q.question.includes(text))!;
  };
  const refreshResults = () => posted.filter((m) => m.type === "models.refresh.result");
  const agentIds = () => (store.state.config?.summary.agents ?? []).map((a) => a.id);
  return { core, layer, writes, posted, store, drain, nextQuestion, refreshResults, agentIds };
}

async function settleRefresh(r: Awaited<ReturnType<typeof rig>>) {
  await waitFor(() => {
    expect(r.store.state.refreshBusy).toBe(false);
    expect(r.core.refreshInFlight.size).toBe(0);
  });
  await r.drain();
}

describe("webview -> dispatcher -> route -> core models.refresh", () => {
  it("chat.answer reaches a queued models.refresh and applies the per-model decisions", async () => {
    const r = await rig();
    r.store.refreshModels();
    const batch = await r.nextQuestion("3 new models");
    expect(r.store.state.refreshBusy).toBe(true);
    r.store.answer(batch.questionId, "Ask each");
    r.store.answer((await r.nextQuestion("'m2'")).questionId, "Add");
    r.store.answer((await r.nextQuestion("'m3'")).questionId, "Skip");
    r.store.answer((await r.nextQuestion("'m4'")).questionId, "Add");
    await settleRefresh(r);
    expect(itemIds(r.layer["agents.yaml"])).toEqual(["a1", "c1-m2", "c1-m4"]);
    expect(r.agentIds()).toEqual(["a1", "c1-m2", "c1-m4"]);
    expect(r.store.state.questions).toEqual([]);
    expect(r.refreshResults().at(-1)).toMatchObject({ ok: true, added: ["c1-m2", "c1-m4"] });
    expect(r.store.state.refreshSummary).toBe("models refresh: +2 agents");

    r.store.refreshModels();
    r.store.answer((await r.nextQuestion("'m3'")).questionId, "Skip");
    await settleRefresh(r);
    expect(r.refreshResults().at(-1)).toMatchObject({ ok: true, added: [] });
    expect(r.store.state.refreshSummary).toBe("models refresh: agents up to date");
  });

  it("a config write failure posts a typed models.refresh.result and the retry succeeds", async () => {
    const r = await rig();
    r.writes.fail = true;
    r.store.refreshModels();
    r.store.answer((await r.nextQuestion("3 new models")).questionId, "Add all");
    await settleRefresh(r);
    expect(r.refreshResults().at(-1)).toEqual({ type: "models.refresh.result", ok: false, error: "write failed" });
    expect(itemIds(r.layer["agents.yaml"])).toEqual(["a1"]);

    r.writes.fail = false;
    r.store.refreshModels();
    r.store.answer((await r.nextQuestion("3 new models")).questionId, "Add all");
    await settleRefresh(r);
    expect(r.refreshResults().at(-1)).toMatchObject({ ok: true, added: ["c1-m2", "c1-m3", "c1-m4"] });
    expect(itemIds(r.layer["agents.yaml"])).toEqual(["a1", "c1-m2", "c1-m3", "c1-m4"]);
    expect(r.agentIds()).toEqual(["a1", "c1-m2", "c1-m3", "c1-m4"]);
  });
});
