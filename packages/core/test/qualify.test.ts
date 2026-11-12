import { describe, expect, it } from "vitest";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";
import type { ConfigLayer, ConfigStore } from "@stewart/config";

function memStore(layer: ConfigLayer = {}): ConfigStore {
  return {
    read: async () => ({ ...layer }),
    write: async (file, yaml) => {
      layer[file] = yaml;
    },
  };
}

const defaults = {
  "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n",
  "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
};

const toolCall = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({ message: { content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: true });
const textMsg = (t: string) => JSON.stringify({ message: { content: t }, done: true });

describe("setup.qualify", () => {
  it("runs both suites and persists qualified records into channels.yaml modelCaps", async () => {
    const { fetcher } = fakeFetcher([
      { body: [textMsg('{"sum":42,"word":"trawets"}')] },
      { body: [toolCall("ReadFile", { path: "notes/todo.txt" })] },
      { body: [toolCall("EditFile", { path: "notes/todo.txt", old_string: "beta\n", new_string: "beta\ngamma\n" })] },
      { body: [toolCall("RunTerminal", { command: "wc -l notes/todo.txt" })] },
      { body: [textMsg("It printed 3")] },
    ]);
    const layer: ConfigLayer = { "channels.yaml": defaults["channels.yaml"] };
    const core = new Core({ fetcher, defaults, userConfig: memStore(layer), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", fakeHost().host);
    const res = (await core.dispatch("setup.qualify", { projectId: "p", channel: "c1", model: "m1" })) as {
      agent?: { passed: boolean };
      function?: { passed: boolean };
    };
    expect(res.agent?.passed).toBe(true);
    expect(res.function?.passed).toBe(true);
    expect(layer["channels.yaml"]).toContain("qualified:");
    expect(layer["channels.yaml"]).toContain("agent:");
    expect(layer["channels.yaml"]).toContain("version: 1");
    const ctx = core.ctx("p");
    expect(ctx.config.channels[0].modelCaps.m1?.qualified?.agent?.passed).toBe(true);
    expect(ctx.config.channels[0].modelCaps.m1?.qualified?.function?.passed).toBe(true);
  });

  it("sanitizes suite details: secrets and provider bodies never reach the response or persisted yaml", async () => {
    const { fetcher } = fakeFetcher([
      { status: 500, body: "Bearer supersecret-token-value secret-body" },
      { status: 500, body: "Bearer supersecret-token-value secret-body" },
    ]);
    const layer: ConfigLayer = {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n    secretRef: k1\n",
    };
    const { host } = fakeHost();
    const withSecrets = { ...host, secrets: { get: async (ref: string) => (ref === "k1" ? "supersecret-token-value" : undefined), set: async () => {}, delete: async () => {} } };
    const core = new Core({ fetcher, defaults, userConfig: memStore(layer), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", withSecrets);
    const res = (await core.dispatch("setup.qualify", { projectId: "p", channel: "c1", model: "m1" })) as {
      agent?: { passed: boolean; detail?: string };
      function?: { passed: boolean; detail?: string };
    };
    expect(res.agent?.passed).toBe(false);
    const out = JSON.stringify(res);
    expect(out).not.toContain("supersecret");
    expect(JSON.stringify(layer)).not.toContain("supersecret");
    expect(layer["channels.yaml"]).toContain("qualified:");
  });

  it("records a failed suite with its detail", async () => {
    const { fetcher } = fakeFetcher([
      { body: [textMsg("no tools here")] },
      { body: [textMsg("garbage")] },
    ]);
    const layer: ConfigLayer = {};
    const core = new Core({ fetcher, defaults, userConfig: memStore(layer), projectConfig: async () => memStore(), emitEvent: () => {} });
    await core.attachProject("p", fakeHost().host);
    const res = (await core.dispatch("setup.qualify", { projectId: "p", channel: "c1", model: "m1" })) as {
      agent?: { passed: boolean; detail?: string };
      function?: { passed: boolean; detail?: string };
    };
    expect(res.agent?.passed).toBe(false);
    expect(res.function?.passed).toBe(false);
    expect(res.function?.detail).toBeTruthy();
  });
});
