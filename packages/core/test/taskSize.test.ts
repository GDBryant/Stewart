import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/taskSize.js";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "./helpers.js";

describe("classifyTask", () => {
  it("flags obvious small tasks as quick", () => {
    expect(classifyTask("write a bash script that tars logs and rsyncs them to the backup server")).toBe("quick");
    expect(classifyTask("explain this regex to me")).toBe("quick");
  });

  it("flags large cross-cutting work as deep", () => {
    expect(
      classifyTask("refactor the auth layer across all packages and migrate every session store", {
        workspaceSize: "large",
        orchestrated: true,
      }),
    ).toBe("deep");
  });

  it("leaves ambiguous prompts at normal", () => {
    expect(classifyTask("add a save button to the dialog")).toBe("normal");
    expect(classifyTask("write a bash script that refactors the whole build pipeline", { orchestrated: true })).toBe("normal");
  });

  it("weighs mentions, attachments and long prompts toward deep", () => {
    expect(classifyTask("compare @a.ts @b.ts @c.ts", { hasAttachments: true, orchestrated: true })).toBe("deep");
    expect(classifyTask("x".repeat(1300))).toBe("deep");
  });
});

describe("chat.send profile", () => {
  it("sends the resolved profile on run.started; /quick and /deep prefixes override the classifier", async () => {
    const seen: unknown[] = [];
    const core = new Core({
      defaults: {
        "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: fake\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
        "roles.yaml": "version: 1\nitems: []\n",
      },
      userConfig: { read: async () => ({}), write: async () => {} },
      projectConfig: async () => ({ read: async () => ({}), write: async () => {} }),
      fetcher: fakeFetcher([]).fetcher,
      emitEvent: (e) => seen.push(e),
    });
    core.channels.register("fake", () => ({
      type: "fake",
      listModels: async () => ["m"],
      probeCaps: async () => ({}),
      chat: async function* (): AsyncIterable<import("../src/channels/types.js").ChatEvent> {},
    }));
    const { host } = fakeHost({ "x.ts": "y" });
    await core.attachProject("p", host);
    const started = () => seen.filter((e) => (e as { kind?: string }).kind === "run.started").map((e) => (e as { profile?: string }).profile);
    await core.dispatch("chat.send", { projectId: "p", text: "/quick do the thing" });
    await core.dispatch("chat.send", { projectId: "p", text: "explain this regex", profile: "deep" });
    await core.dispatch("chat.send", { projectId: "p", text: "explain this regex" });
    expect(started()).toEqual(["quick", "deep", "quick"]);
  });
});
