import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events.js";
import { loadConfig } from "../src/config/loader.js";
import { Core } from "../src/core.js";
import type { HostPort } from "../src/ports.js";
import { fakeFetcher, streamOf } from "./helpers.js";
import type { RunEvent } from "@stewart/protocol";

const fakeHost = (trusted = true): HostPort => ({
  secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  files: {
    read: async () => ({ content: "" }),
    edit: async () => ({ applied: true as const }),
    readBack: async () => "",
    exists: async () => false,
    writeAtomic: async () => {},
  },
  proc: { run: () => { throw new Error("no proc in test"); } },
  diff: { preview: async () => {} },
  diag: { problems: async () => [] },
  workspace: { roots: async () => ["/p"], stateDir: async () => "/tmp/st", trusted: async () => trusted },
  log: () => {},
});

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
});

describe("loadConfig", () => {
  const rolesYaml = "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n";
  const agentsYaml = "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n";
  const channelsYaml = "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://x\n";

  it("merges user and project roles by id, project fields winning", () => {
    const cfg = loadConfig(
      { "agents.yaml": agentsYaml, "channels.yaml": channelsYaml, "roles.yaml": rolesYaml },
      { "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    turnBudget: 99\n" },
      {},
      true,
    );
    const gw = cfg.roles.find((r) => r.id === "general-worker");
    expect(gw?.turnBudget).toBe(99);
    expect(gw?.agent).toBe("a1");
  });

  it("ignores project roles in an untrusted workspace", () => {
    const cfg = loadConfig({ "roles.yaml": rolesYaml, "agents.yaml": agentsYaml, "channels.yaml": channelsYaml }, { "roles.yaml": "version: 1\nitems:\n  - id: evil\n    enabled: true\n" }, {}, false);
    expect(cfg.roles.some((r) => r.id === "evil")).toBe(false);
    expect(cfg.errors.join(" ")).toContain("untrusted");
  });

  it("project cannot add channels or agents even when trusted", () => {
    const cfg = loadConfig({}, { "channels.yaml": channelsYaml, "agents.yaml": agentsYaml, "roles.yaml": rolesYaml }, {}, true);
    expect(cfg.channels).toHaveLength(0);
    expect(cfg.agents).toHaveLength(0);
  });

  it("surfaces invalid YAML as error and keeps last good fields", () => {
    const cfg = loadConfig({ "channels.yaml": "version: 1\nitems: [{\n" }, {}, {}, true);
    expect(cfg.errors.length).toBe(1);
    expect(cfg.channels).toHaveLength(0);
  });
});

describe("Core", () => {
  const defaults = {
    "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n",
    "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
    "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    agent: a1\n",
  };

  function mkCore(body: string[]) {
    const events: RunEvent[] = [];
    const { fetcher } = fakeFetcher([{ body }]);
    const core = new Core({
      fetcher,
      defaults,
      userConfig: async () => ({}),
      projectConfig: async () => ({}),
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

  it("cancels a running stream", async () => {
    const ctl = new AbortController();
    const events: RunEvent[] = [];
    const fetcher = async () => ({ status: 200, headers: {}, body: streamOf(['{"message":{"content":"x"},"done":false}'], 50) });
    const core = new Core({ fetcher, defaults, userConfig: async () => ({}), projectConfig: async () => ({}), emitEvent: (e) => events.push(e) });
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
});
