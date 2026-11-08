import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { loadConfig } from "@stewart/roles-skills";
import { recommendAssignments, type RecommendChannel } from "../src/recommend.js";

const cfg = () =>
  loadConfig(
    {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n  - id: c2\n    type: ollama\n    enabled: true\n",
      "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
      "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: tester\n    enabled: true\n",
    },
    {},
    {},
    true,
  );

function mc(models: string[], answer?: string | Error): RecommendChannel {
  return {
    listModels: async () => {
      if (answer instanceof Error && answer.message === "list fails") throw answer;
      return models;
    },
    chat: async function* (req: ChatRequest) {
      if (answer instanceof Error) throw answer;
      yield { kind: "text", text: answer ?? "{}" } as ChatEvent;
      yield { kind: "done" } as ChatEvent;
    },
  };
}

const managed = (m: Record<string, RecommendChannel | undefined>) => ({ get: (id: string) => m[id] });

describe("recommendAssignments", () => {
  it("rules mode returns scorer assignments without a model call", async () => {
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1", "m2"]) }), { mode: "rules" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments.map((a) => a.role).sort()).toEqual(["general-worker", "tester"]);
      expect(r.channels.map((c) => c.id)).toContain("c1");
    }
  });

  it("ai mode validates the researcher answer and returns it", async () => {
    const answer = JSON.stringify({ assignments: [{ role: "general-worker", channel: "c1", model: "m2", reason: "good" }] });
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1", "m2"], answer) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments[0]).toMatchObject({ role: "general-worker", model: "m2", reason: "good" });
      expect(r.researcher).toEqual({ channel: "c1", model: "m1" });
    }
  });

  it("drops invalid role/channel/model assignments with reasons", async () => {
    const answer = JSON.stringify({
      assignments: [
        { role: "general-worker", channel: "c1", model: "m2" },
        { role: "ghost", channel: "c1", model: "m1" },
        { role: "tester", channel: "gone", model: "m1" },
        { role: "tester", channel: "c1", model: "nope" },
      ],
    });
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1", "m2"], answer) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments).toHaveLength(1);
      expect(r.dropped?.join(" ")).toContain("unknown role");
      expect(r.dropped?.join(" ")).toContain("unknown channel");
      expect(r.dropped?.join(" ")).toContain("unknown model");
    }
  });

  it("fails when no models are discovered anywhere", async () => {
    const r = await recommendAssignments(cfg(), managed({ c1: mc([]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no models");
  });

  it("fails when the answer has no JSON and when every assignment is invalid", async () => {
    const r1 = await recommendAssignments(cfg(), managed({ c1: mc(["m1"], "no json at all") }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("could not parse");
    const bad = JSON.stringify({ assignments: [{ role: "ghost", channel: "c1", model: "m1" }] });
    const r2 = await recommendAssignments(cfg(), managed({ c1: mc(["m1"], bad) }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("empty or invalid");
  });

  it("reports a researcher chat failure and a channel listModels error", async () => {
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1"], new Error("chat blew up")) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("researcher failed");
    const r2 = await recommendAssignments(cfg(), managed({ c1: mc([], new Error("list fails")), c2: undefined }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error).toContain("no models");
      expect(r2.channels?.find((c) => c.id === "c1")?.error).toBe("list fails");
      expect(r2.channels?.find((c) => c.id === "c2")?.error).toBe("not configured");
    }
  });

  it("honours an explicit evaluator and applies priceFor info", async () => {
    const seen: string[] = [];
    const probe: RecommendChannel = {
      listModels: async () => ["m9"],
      chat: async function* (req) {
        seen.push(req.model);
        yield { kind: "text", text: JSON.stringify({ assignments: [{ role: "general-worker", channel: "c2", model: "m9" }] }) } as ChatEvent;
        yield { kind: "done" } as ChatEvent;
      },
    };
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1"], "{}"), c2: probe }), {
      evaluator: { channel: "c2", model: "m9" },
      priceFor: async () => ({ inPerMTok: 1, outPerMTok: 2 }),
      context: { priorities: { speed: 2, cost: 1, quality: 3 }, typicalWork: "edits", workspace: { sizeClass: "small", files: 10, loc: 100 }, hardware: { os: "linux", ramGb: 16, gpus: [{ name: "g", vramGb: 8 }] } },
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["m9"]);
    if (r.ok) expect(r.researcher).toEqual({ channel: "c2", model: "m9" });
  });
});
