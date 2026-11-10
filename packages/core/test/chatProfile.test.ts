import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { Core } from "../src/core.js";
import { fakeFetcher, fakeHost } from "@stewart/kernel";

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

  it("feeds prior session turns to the orchestrator and keeps sessions isolated", async () => {
    const seen: unknown[] = [];
    const requests: ChatRequest[] = [];
    const core = new Core({
      defaults: {
        "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: fake\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m\n",
        "roles.yaml": "version: 1\nitems:\n  - id: orchestrator\n    enabled: true\n    agent: a1\n    tools: []\n",
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
      chat: async function* (_cfg: unknown, _secret: unknown, req: ChatRequest): AsyncIterable<ChatEvent> {
        requests.push(req);
        yield { kind: "text", text: `reply ${requests.length}` };
        yield { kind: "done" };
      },
    }));
    const { host } = fakeHost();
    await core.attachProject("p", host);
    const finished = () => seen.filter((e) => (e as { kind?: string }).kind === "run.finished").length;

    await core.dispatch("chat.send", { projectId: "p", text: "show git diff", sessionId: "s1" });
    await vi.waitFor(() => expect(finished()).toBe(1));
    await core.dispatch("chat.send", { projectId: "p", text: "run it in this project root", sessionId: "s1" });
    await vi.waitFor(() => expect(finished()).toBe(2));
    await core.dispatch("chat.send", { projectId: "p", text: "fresh question", sessionId: "s2" });
    await vi.waitFor(() => expect(finished()).toBe(3));

    const flat = (req: ChatRequest) => req.messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${m.content}`);
    expect(flat(requests[0]!)).toEqual(["user:show git diff"]);
    expect(flat(requests[1]!)).toEqual(["user:show git diff", "assistant:reply 1", "user:run it in this project root"]);
    expect(flat(requests[2]!)).toEqual(["user:fresh question"]);
  });
});
