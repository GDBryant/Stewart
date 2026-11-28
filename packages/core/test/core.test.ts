import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventBus, fakeHost as kernelHost } from "@stewart/kernel";
import { loadEffectiveConfig } from "@stewart/roles-skills";
import { Core } from "../src/core.js";
import type { HostPort } from "@stewart/kernel";
import { fakeFetcher, streamOf } from "@stewart/kernel";
import type { ConfigLayer } from "@stewart/config";
import type { ConfigStore } from "@stewart/config";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}
import type { RunEvent } from "@stewart/protocol";

const fakeHost = (trusted = true): HostPort => {
  const map: Record<string, string> = {};
  const files: HostPort["files"] = {
    read: async (p) => ({ content: map[p] ?? "" }),
    edit: async (e) => ({ applied: true as const }),
    readBack: async (p) => map[p] ?? "",
    exists: async (p) => p === "." || p in map || Object.keys(map).some((k) => k.startsWith(`${p}/`)),
    list: async (d) => Object.keys(map).filter((k) => (d === "." || d === "" ? true : k.startsWith(`${d}/`))),
    stat: async (p) => ({ size: map[p]?.length ?? 0 }),
    readBinary: async (p) => ({ base64: Buffer.from(map[p] ?? "", "utf8").toString("base64"), size: map[p]?.length ?? 0 }),
    writeBinary: async (p, b64) => void (map[p] = Buffer.from(b64, "base64").toString("utf8")),
    writeAtomic: async (p, c) => void (map[p] = c),
    appendLine: async (p, l) => void (map[p] = map[p] ? `${map[p]}\n${l}` : l),
    readLines: async (p) => (map[p] ? map[p].split("\n") : []),
    delete: async (p) => void delete map[p],
  };
  return {
  secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  files,
  proc: { run: () => { throw new Error("no proc in test"); } },
  diff: { preview: async () => {}, show: async () => {} },
  diag: { problems: async () => [] },
  workspace: { roots: async () => ["/p"], stateDir: async () => "/tmp/st", trusted: async () => trusted },
  log: () => {},
  };
};

describe("EventBus coalescing", () => {
  it("batches text deltas within a frame and flushes on lifecycle events", async () => {
    const out: RunEvent[] = [];
    const bus = new EventBus((e) => out.push(e), 10);
    bus.emit({ kind: "text_delta", runId: "r", seq: 0, text: "a" });
    bus.emit({ kind: "text_delta", runId: "r", seq: 0, text: "b" });
    expect(out).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe("ab");
    bus.emit({ kind: "text_delta", runId: "r", seq: 0, text: "c" });
    bus.emit({ kind: "run.finished", runId: "r", status: "done" });
    expect(out[1]).toMatchObject({ kind: "text_delta", text: "c" });
    expect(out[2].kind).toBe("run.finished");
  });

  it("delivers events to subscribers asynchronously and isolates subscriber failures", async () => {
    const out: RunEvent[] = [];
    const subOut: RunEvent[] = [];
    const bus = new EventBus((e) => out.push(e), 0);
    bus.subscribe(() => {
      throw new Error("sync subscriber boom");
    });
    bus.subscribe(async () => {
      throw new Error("async subscriber boom");
    });
    const unsub = bus.subscribe((e) => {
      subOut.push(e);
    });
    bus.emit({ kind: "run.started", runId: "r1", title: "go" });
    await new Promise((r) => setTimeout(r, 10));
    expect(out).toHaveLength(1);
    expect(subOut).toHaveLength(1);
    unsub();
    bus.emit({ kind: "run.finished", runId: "r1", status: "done" });
    await new Promise((r) => setTimeout(r, 10));
    expect(subOut).toHaveLength(1);
  });
});

describe("loadEffectiveConfig", () => {
  const rolesYaml = "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n";
  const agentsYaml = "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n";
  const channelsYaml = "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://x\n    modelCaps:\n      m1:\n        qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }\n";

  it("merges user and project roles by id, project fields winning", () => {
    const cfg = loadEffectiveConfig(
      { "agents.yaml": agentsYaml, "channels.yaml": channelsYaml, "roles.yaml": rolesYaml },
      { "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    turnBudget: 99\n" },
      {},
      { trusted: true },
    );
    const gw = cfg.roles.find((r) => r.id === "general-worker");
    expect(gw?.turnBudget).toBe(99);
    expect(gw?.agent).toBe("a1");
  });

  it("ignores project roles in an untrusted workspace", () => {
    const cfg = loadEffectiveConfig({ "roles.yaml": rolesYaml, "agents.yaml": agentsYaml, "channels.yaml": channelsYaml }, { "roles.yaml": "version: 1\nitems:\n  - id: evil\n    enabled: true\n" }, {}, { trusted: false });
    expect(cfg.roles.some((r) => r.id === "evil")).toBe(false);
    expect(cfg.errors.join(" ")).toContain("untrusted");
  });

  it("project cannot add channels or agents even when trusted", () => {
    const cfg = loadEffectiveConfig({}, { "channels.yaml": channelsYaml, "agents.yaml": agentsYaml, "roles.yaml": rolesYaml }, {}, { trusted: true });
    expect(cfg.channels).toHaveLength(0);
    expect(cfg.agents).toHaveLength(0);
  });

  it("surfaces invalid YAML as error and keeps last good fields", () => {
    const cfg = loadEffectiveConfig({ "channels.yaml": "version: 1\nitems: [{\n" }, {}, {}, { trusted: true });
    expect(cfg.errors.length).toBe(1);
    expect(cfg.channels).toHaveLength(0);
  });
});

describe("Core", () => {
  const rolesUser = "version: 1\nitems:\n  - id: lead\n    enabled: true\n    agent: a1\n    turnBudget: 40\n";
  const defaults = {
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps:\n      m:\n        qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }\n",
    "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
  };

  function mkCore(body: string[]) {
    const events: RunEvent[] = [];
    const { fetcher } = fakeFetcher([{ body }]);
    const core = new Core({
      fetcher,
      defaults,
      userConfig: memStore({ "roles.yaml": rolesUser }),
      projectConfig: async () => memStore(),
      emitEvent: (e) => events.push(e),
    });
    return { core, events };
  }

  it("streams a direct chat run and emits lifecycle + deltas", async () => {
    const { core, events } = mkCore(['{"message":{"content":"hi"},"done":false}', '{"done":true,"prompt_eval_count":1,"eval_count":1}']);
    await core.attachProject("p", fakeHost());
    await core.dispatch("hello", { protocol: 1, capabilities: [] });
    const res = (await core.dispatch("chat.send", { projectId: "p", text: "yo" })) as { runId: string };
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === "run.finished" && e.runId === res.runId)).toBe(true);
    });
    const text = events.filter((e) => e.kind === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("hi");
  });

  it("emits cost.summary for a direct run on a priced agent", async () => {
    const events: RunEvent[] = [];
    const { fetcher } = fakeFetcher([{ body: ['{"message":{"content":"hi"},"done":false}', '{"done":true,"prompt_eval_count":1000,"eval_count":1000}'] }]);
    const priced = { ...defaults, "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n    billing: priced\n    price: { inPerMTok: 3, outPerMTok: 15 }\n" };
    const core = new Core({ fetcher, defaults: priced, userConfig: memStore({ "roles.yaml": rolesUser }), projectConfig: async () => memStore(), emitEvent: (e) => events.push(e) });
    await core.attachProject("p", fakeHost());
    await core.dispatch("chat.send", { projectId: "p", text: "yo" });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "run.finished")).toBe(true));
    const sum = events.find((e) => e.kind === "cost.summary") as Extract<RunEvent, { kind: "cost.summary" }> | undefined;
    expect(sum?.accruedUsd).toBeGreaterThan(0);
    expect(events.findIndex((e) => e.kind === "cost.summary")).toBeLessThan(events.findIndex((e) => e.kind === "run.finished"));
  });

  it("emits no cost.summary for a free direct run", async () => {
    const { core, events } = mkCore(['{"message":{"content":"hi"},"done":false}', '{"done":true,"prompt_eval_count":1,"eval_count":1}']);
    await core.attachProject("p", fakeHost());
    await core.dispatch("chat.send", { projectId: "p", text: "yo" });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "run.finished")).toBe(true));
    expect(events.some((e) => e.kind === "cost.summary")).toBe(false);
  });

  it("cancels a running stream", async () => {
    const ctl = new AbortController();
    const events: RunEvent[] = [];
    const fetcher = async (_u: string, init: { signal?: AbortSignal }) => ({
      status: 200,
      headers: {},
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"message":{"content":"x"},"done":false}\n'));
          init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      }),
    });
    const core = new Core({ fetcher, defaults, userConfig: memStore({ "roles.yaml": rolesUser }), projectConfig: async () => memStore(), emitEvent: (e) => events.push(e) });
    await core.attachProject("p", fakeHost());
    const res = (await core.dispatch("chat.send", { projectId: "p", text: "yo" })) as { runId: string };
    await new Promise((r) => setTimeout(r, 30));
    await core.dispatch("chat.cancel", { projectId: "p", runId: res.runId });
    await vi.waitFor(() => {
      const f = events.find((e) => e.kind === "run.finished" && e.runId === res.runId);
      expect(f && (f as { status: string }).status).toBe("cancelled");
    });
    ctl.abort();
  });

  it("rejects version mismatch on hello", async () => {
    const { core } = mkCore([]);
    await core.attachProject("p", fakeHost());
    await expect(core.dispatch("hello", { protocol: 99, capabilities: [] })).rejects.toThrow(/mismatch/);
  });

  describe("lead path", () => {
    const leadRoles = "version: 1\nitems:\n  - id: lead\n    enabled: true\n    turnBudget: 5\n  - id: general-worker\n    enabled: true\n    agent: a1\n";
    const leadDefaults = {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps:\n      m:\n        qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }\n",
      "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
    };

    function mkLead(body: string[], rolesYaml?: string) {
      const events: RunEvent[] = [];
      const { fetcher } = fakeFetcher([{ body }]);
      const core = new Core({
        fetcher,
        defaults: leadDefaults,
        userConfig: memStore({ "roles.yaml": rolesYaml ?? leadRoles }),
        projectConfig: async () => memStore(),
        emitEvent: (e) => events.push(e),
      });
      return { core, events };
    }

    it("routes chat.send to the lead session when lead is enabled", async () => {
      const { core, events } = mkLead(['{"message":{"content":"hi"},"done":false}', '{"done":true,"prompt_eval_count":1,"eval_count":1}']);
      await core.attachProject("p", fakeHost());
      const res = (await core.dispatch("chat.send", { projectId: "p", text: "yo" })) as { runId: string };
      await vi.waitFor(() => {
        expect(events.some((e) => e.kind === "run.finished" && e.runId === res.runId)).toBe(true);
      });
      expect(events.find((e) => e.kind === "run.started")).toMatchObject({ roleId: "lead" });
      const fin = events.find((e) => e.kind === "run.finished");
      expect(fin).toMatchObject({ status: "done", roleId: "lead" });
      expect(events.some((e) => e.kind === "check.result")).toBe(true);
    });

    it("a disabled lead falls back to the next enabled agent-kind role", async () => {
      const roles = "version: 1\nitems:\n  - id: lead\n    enabled: false\n  - id: general-worker\n    enabled: true\n    agent: a1\n";
      const { core, events } = mkLead(['{"message":{"content":"hi"},"done":false}', '{"done":true,"prompt_eval_count":1,"eval_count":1}'], roles);
      await core.attachProject("p", fakeHost());
      const res = (await core.dispatch("chat.send", { projectId: "p", text: "yo" })) as { runId: string };
      await vi.waitFor(() => {
        expect(events.some((e) => e.kind === "run.finished" && e.runId === res.runId)).toBe(true);
      });
      expect(events.find((e) => e.kind === "run.started")).toMatchObject({ roleId: "general-worker" });
    });

    it("rejects chat.send with the actionable empty state when no agent-kind role is enabled", async () => {
      const roles = "version: 1\nitems:\n  - id: lead\n    enabled: false\n  - id: general-worker\n    enabled: false\n    agent: a1\n";
      const { core } = mkLead(['{"done":true}'], roles);
      await core.attachProject("p", fakeHost());
      await expect(core.dispatch("chat.send", { projectId: "p", text: "yo" })).rejects.toThrow(/no enabled agent-kind role/);
    });
  });

  describe("file.diff", () => {
    function mkDiff() {
      const { host, files, diffShows } = kernelHost({ "src/a.ts": "new" });
      const sha = createHash("sha256").update("old").digest("hex");
      files["/tmp/st/checkpoints/s1/base-1.json"] = JSON.stringify({ files: { "src/a.ts": sha } });
      files[`/tmp/st/checkpoints/s1/blobs/${sha}`] = "old";
      const core = new Core({
        fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
        defaults,
        userConfig: memStore(),
        projectConfig: async () => memStore(),
        emitEvent: () => {},
      });
      return { core, host, diffShows };
    }

    it("shows baseline vs current content through host diff.show", async () => {
      const { core, host, diffShows } = mkDiff();
      await core.attachProject("p", host);
      await expect(core.dispatch("file.diff", { projectId: "p", sessionId: "s1", path: "src/a.ts", baseline: "base-1" })).resolves.toEqual({ ok: true });
      expect(diffShows).toEqual([{ path: "src/a.ts", before: "old", after: "new" }]);
    });

    it("rejects traversal paths and bad baseline ids", async () => {
      const { core, host, diffShows } = mkDiff();
      await core.attachProject("p", host);
      await expect(core.dispatch("file.diff", { projectId: "p", sessionId: "s1", path: "../x", baseline: "base-1" })).rejects.toThrow(/invalid diff path/);
      await expect(core.dispatch("file.diff", { projectId: "p", sessionId: "s1", path: "src/a.ts", baseline: "a/b" })).rejects.toThrow(/invalid baseline/);
      expect(diffShows).toHaveLength(0);
    });
  });
});

describe("Core config", () => {
  const defaults = {
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    modelCaps:\n      m:\n        qualified: { agent: { passed: true, at: 1, version: 2, context: 32000 } }\n",
    "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
    "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n",
  };

  function mk() {
    const events: RunEvent[] = [];
    const userLayer: Record<string, string | undefined> = {};
    const user = memStore(userLayer);
    const core = new Core({
      defaults,
      userConfig: user,
      projectConfig: async () => memStore(),
      fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher,
      emitEvent: (e) => events.push(e),
    });
    return { core, userLayer, events };
  }

  it("config.get returns file yaml and parsed summary", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost());
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { files: Record<string, string>; summary: { channels: { id: string }[] } };
    expect(r.summary.channels.map((c) => c.id)).toContain("c1");
    expect(r.files["channels.yaml"]).toContain("c1");
  });

  it("config.set validates, writes and reloads channels", async () => {
    const { core, userLayer } = mk();
    await core.attachProject("p", fakeHost());
    const ok = (await core.dispatch("config.set", {
      projectId: "p",
      file: "channels.yaml",
      yaml: "version: 1\nitems:\n  - id: c2\n    type: ollama\n    baseUrl: http://x\n    maxParallel: 2\n",
    })) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(userLayer["channels.yaml"]).toContain("c2");
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { channels: { id: string }[] } };
    expect(r.summary.channels.map((c) => c.id)).toContain("c2");
  });

  it("config.set rejects bad yaml and unknown files", async () => {
    const { core } = mk();
    await core.attachProject("p", fakeHost());
    await expect(core.dispatch("config.set", { projectId: "p", file: "channels.yaml", yaml: "[unclosed" })).rejects.toThrow(/YAML/);
    await expect(core.dispatch("config.set", { projectId: "p", file: "nope.yaml", yaml: "{}" })).rejects.toThrow(/unknown config file/);
    await expect(core.dispatch("config.set", { projectId: "p", file: "channels.yaml", yaml: "version: 1\nitems: [{id: 5}]" })).rejects.toThrow(/invalid/);
  });

  it("secret.set stores via host and wires it to the channel", async () => {
    const secrets = new Map<string, string>();
    const host = fakeHost();
    host.secrets = {
      get: async (k) => secrets.get(k),
      set: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    };
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m"}]}'] }]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: ollama\n    baseUrl: http://x\n    secretRef: sk\n" });
    const core = new Core({
      defaults: {},
      userConfig: user,
      projectConfig: async () => memStore(),
      fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", host);
    await core.dispatch("secret.set", { projectId: "p", ref: "sk", value: "sekret" });
    expect(secrets.get("sk")).toBe("sekret");
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "oc" })) as { ok: boolean };
    expect(res.ok).toBe(true);
    await core.dispatch("secret.delete", { projectId: "p", ref: "sk" });
    expect(secrets.has("sk")).toBe(false);
  });

  it("channel.test on openai-compatible probes the reasoning field and suggests one when unset", async () => {
    const completion = (reasoning: number) =>
      JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens_details: { reasoning_tokens: reasoning } } });
    const { fetcher } = fakeFetcher([
      { body: ['{"data":[{"id":"m1"}]}'] }, // GET /models
      { body: [completion(0)] }, // tools probe
      { body: [completion(100)] }, // reasoning baseline (reasoning_effort candidate)
      { body: [completion(0)] }, // reasoning-effort-off probe cuts tokens
    ]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: openai-compatible\n    baseUrl: http://x\n" });
    const core = new Core({ defaults: {}, userConfig: user, projectConfig: async () => memStore(), fetcher, emitEvent: () => {} });
    await core.attachProject("p", fakeHost());
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "oc" })) as { ok: boolean; reasoning?: { suggest?: string; control?: boolean } };
    expect(res.ok).toBe(true);
    expect(res.reasoning?.suggest).toBe("reasoning_effort");
    expect(res.reasoning?.control).toBe(undefined);
  });

  it("channel.test verifies a configured reasoning field and skips non-openai channels", async () => {
    const completion = (reasoning: number) =>
      JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens_details: { reasoning_tokens: reasoning } } });
    const { fetcher } = fakeFetcher([
      { body: ['{"data":[{"id":"m1"}]}'] },
      { body: [completion(0)] },
      { body: [completion(100)] },
      { body: [completion(80)] }, // off probe does not cut enough? 80 < 100 → control true
    ]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: openai-compatible\n    baseUrl: http://x\n    reasoning: enable_thinking\n" });
    const core = new Core({ defaults: {}, userConfig: user, projectConfig: async () => memStore(), fetcher, emitEvent: () => {} });
    await core.attachProject("p", fakeHost());
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "oc" })) as { ok: boolean; reasoning?: { suggest?: string; control?: boolean } };
    expect(res.reasoning?.control).toBe(true);
    expect(res.reasoning?.suggest).toBe(undefined);
  });

  it("channel.test still passes when the reasoning probe itself fails", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"data":[{"id":"m1"}]}'] }, { status: 500, body: ["probe boom"] }]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: openai-compatible\n    baseUrl: http://x\n" });
    const core = new Core({ defaults: {}, userConfig: user, projectConfig: async () => memStore(), fetcher, emitEvent: () => {} });
    await core.attachProject("p", fakeHost());
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "oc" })) as { ok: boolean; reasoning?: unknown };
    expect(res.ok).toBe(true);
    expect(res.reasoning).toBe(undefined);
  });

  it("channel.test omits reasoning for ollama channels and survives a probe failure", async () => {
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m1"}]}'] }, { status: 500, body: ["boom"] }]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: ol\n    type: ollama\n    baseUrl: http://x\n" });
    const core = new Core({ defaults: {}, userConfig: user, projectConfig: async () => memStore(), fetcher, emitEvent: () => {} });
    await core.attachProject("p", fakeHost());
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "ol" })) as { ok: boolean; reasoning?: unknown };
    expect(res.ok).toBe(true);
    expect(res.reasoning).toBe(undefined);
  });

  it("secret.set trims the key and rejects empty values", async () => {
    const secrets = new Map<string, string>();
    const host = fakeHost();
    host.secrets = {
      get: async (k) => secrets.get(k),
      set: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    };
    const core = new Core({
      defaults: {},
      userConfig: memStore(),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", host);
    await core.dispatch("secret.set", { projectId: "p", ref: "sk", value: "  sekret\n" });
    expect(secrets.get("sk")).toBe("sekret");
    await expect(core.dispatch("secret.set", { projectId: "p", ref: "sk", value: "   " })).rejects.toThrow(/empty/);
    expect(secrets.get("sk")).toBe("sekret");
  });

  it("secret.set keeps the key live in-session and reports when the host store rejects", async () => {
    const host = fakeHost();
    host.secrets = {
      get: async () => undefined,
      set: async () => {
        throw new Error("keyring unavailable");
      },
      delete: async () => {},
    };
    const { fetcher } = fakeFetcher([{ body: ['{"models":[{"name":"m"}]}'] }]);
    const user = memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: ollama\n    baseUrl: http://x\n    secretRef: sk\n" });
    const core = new Core({
      defaults: {},
      userConfig: user,
      projectConfig: async () => memStore(),
      fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", host);
    await expect(core.dispatch("secret.set", { projectId: "p", ref: "sk", value: "sekret" })).rejects.toThrow(/could not be saved to the IDE secret store/);
    expect(core.secretValues.get("sk")).toBe("sekret");
    const res = (await core.dispatch("channel.test", { projectId: "p", channelId: "oc" })) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it("secret.delete clears live state even when the host store rejects", async () => {
    const host = fakeHost();
    host.secrets = {
      get: async () => "old",
      set: async () => {},
      delete: async () => {
        throw new Error("keyring unavailable");
      },
    };
    const core = new Core({
      defaults: {},
      userConfig: memStore({ "channels.yaml": "version: 1\nitems:\n  - id: oc\n    type: ollama\n    baseUrl: http://x\n    secretRef: sk\n" }),
      projectConfig: async () => memStore(),
      emitEvent: () => {},
    });
    await core.attachProject("p", host);
    expect(core.secretValues.get("sk")).toBe("old");
    await expect(core.dispatch("secret.delete", { projectId: "p", ref: "sk" })).rejects.toThrow(/could not be deleted/);
    expect(core.secretValues.has("sk")).toBe(false);
  });

  it("config.get reports which secretRefs are stored, never their values", async () => {
    const secrets = new Map<string, string>([["has", "topsecret"]]);
    const host = fakeHost();
    host.secrets = {
      get: async (k) => secrets.get(k),
      set: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    };
    const user = memStore({
      "channels.yaml":
        "version: 1\nitems:\n  - id: a\n    type: ollama\n    baseUrl: http://x\n    secretRef: has\n  - id: b\n    type: ollama\n    baseUrl: http://y\n    secretRef: missing\n  - id: c\n    type: ollama\n    baseUrl: http://z\n",
    });
    const core = new Core({ defaults: {}, userConfig: user, projectConfig: async () => memStore(), fetcher: fakeFetcher([]).fetcher, emitEvent: () => {} });
    await core.attachProject("p", host);
    const r = (await core.dispatch("config.get", { projectId: "p" })) as { secrets: Record<string, boolean> };
    expect(r.secrets).toEqual({ has: true, missing: false });
    expect(JSON.stringify(r)).not.toContain("topsecret");
  });

  it("suppresses self-writes on watcher reload and caches capability probes", async () => {
    const { fetcher, calls } = fakeFetcher([
      { body: ['{"capabilities":["tools","vision"],"model_info":{"general.context_length":65536}}'] },
      { body: ['{"capabilities":["tools"],"model_info":{"general.context_length":32768}}'] },
    ]);
    const userLayer: Record<string, string | undefined> = {};
    const core = new Core({
      defaults,
      userConfig: memStore(userLayer),
      projectConfig: async () => memStore(),
      fetcher,
      emitEvent: () => {},
    });
    await core.attachProject("p", fakeHost());
    await core.dispatch("config.set", {
      projectId: "p",
      file: "settings.yaml",
      yaml: "version: 1\nmaxRunHours: 2\n",
    });
    const suppressed = (await core.dispatch("config.reload", { projectId: "p", fromWatcher: true })) as { suppressed: boolean };
    expect(suppressed.suppressed).toBe(true);
    userLayer["settings.yaml"] = "version: 1\nmaxRunHours: 4\n";
    const external = (await core.dispatch("config.reload", { projectId: "p", fromWatcher: true })) as { suppressed: boolean };
    expect(external.suppressed).toBe(false);

    const p1 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m" })) as {
      ok: boolean;
      cached: boolean;
      caps: { tools: string; vision: boolean; contextTokens: number };
    };
    expect(p1).toMatchObject({ ok: true, cached: false, caps: { tools: "native", vision: true, contextTokens: 65536 } });
    const p2 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m" })) as { ok: boolean; cached: boolean };
    expect(p2).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
    const p3 = (await core.dispatch("channel.probe", { projectId: "p", channelId: "c1", model: "m", force: true })) as { ok: boolean; cached: boolean };
    expect(p3).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(2);
    const missing = (await core.dispatch("channel.probe", { projectId: "p", channelId: "nope", model: "m" })) as { ok: boolean };
    expect(missing.ok).toBe(false);
  });
});
