import { describe, expect, it } from "vitest";
import { fakeHost, fakeFetcher } from "@stewart/kernel";
import type { ConfigLayer, ConfigStore } from "@stewart/config";
import { Core } from "../src/core.js";
import { FEATURE_ROLE_TOOLS, RUN_FEATURES } from "../src/features.js";

const memStore = (layer: ConfigLayer = {}): ConfigStore => ({
  read: async () => ({ ...layer }),
  write: async (file, yaml) => void (layer[file] = yaml),
  delete: async (file) => void delete layer[file],
});

const defaults = {
  "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    baseUrl: http://oll\n",
  "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
};

async function rolesOf(userRoles?: string) {
  const layer: ConfigLayer = userRoles ? { "roles.yaml": userRoles } : {};
  const core = new Core({ defaults, userConfig: memStore(layer), projectConfig: async () => memStore(), fetcher: fakeFetcher([{ body: ['{"done":true}'] }]).fetcher, emitEvent: () => {} });
  await core.attachProject("p", fakeHost().host);
  const r = (await core.dispatch("config.get", { projectId: "p" })) as { summary: { roles: { id: string; tools: string[] }[] } };
  return new Map(r.summary.roles.map((x) => [x.id, x.tools]));
}

describe("run features wired into core", () => {
  it("registers the health-check feature and exposes its required role tools", () => {
    expect(RUN_FEATURES.map((f) => f.id)).toEqual(["health-check"]);
    expect(FEATURE_ROLE_TOOLS.orchestrator).toContain("health_report");
    expect(FEATURE_ROLE_TOOLS["code-health-reviewer"]).toContain("submit_health");
  });

  it("unions the feature's tools into a stale user roles.yaml with a non-empty tool list", async () => {
    const roles = await rolesOf("version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: [dispatch, ask_user]\n");
    expect(roles.get("orchestrator")).toEqual(expect.arrayContaining(["dispatch", "ask_user", "ListCodeFiles", "health_report"]));
  });

  it("leaves a role with an empty tool list (all/default) alone", async () => {
    const roles = await rolesOf("version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    tools: []\n");
    expect(roles.get("orchestrator")).toEqual([]);
  });
});
