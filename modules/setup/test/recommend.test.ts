import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest } from "@stewart/channels";
import { loadEffectiveConfig } from "@stewart/roles-skills";
import { parseJsonObject, recommendAssignments, type RecommendChannel } from "../src/recommend.js";

const cfg = () =>
  loadEffectiveConfig(
    {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n  - id: c2\n    type: ollama\n    enabled: true\n",
      "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
      "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: tester\n    enabled: true\n",
    },
    {},
    {},
    { trusted: true },
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

describe("recommendAssignments eligible filtering", () => {
  it("restricts candidates to the eligible set and reports an error when none pass", async () => {
    const r = await recommendAssignments(cfg(), managed({ c1: mc(["m1", "m2"]) }), {
      mode: "rules",
      eligible: [{ channel: "c1", model: "m2" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channels[0].models).toEqual(["m2"]);
      expect(r.assignments.every((a) => a.model === "m2")).toBe(true);
    }
    const empty = await recommendAssignments(cfg(), managed({ c1: mc(["m1"]) }), { mode: "rules", eligible: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("smoke test");
  });

  it("drops an evaluator outside the eligible set unless evaluatorAny is set", async () => {
    const seen: string[] = [];
    const probe: RecommendChannel = {
      listModels: async () => ["m1", "m2"],
      chat: async function* (req) {
        seen.push(req.model);
        yield { kind: "text", text: JSON.stringify({ assignments: [{ role: "general-worker", channel: "c1", model: "m2" }] }) } as ChatEvent;
        yield { kind: "done" } as ChatEvent;
      },
    };
    const r = await recommendAssignments(cfg(), managed({ c1: probe }), {
      evaluator: { channel: "c1", model: "m1" },
      eligible: [{ channel: "c1", model: "m2" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.researcher).toEqual({ channel: "c1", model: "m2" });
    const r2 = await recommendAssignments(cfg(), managed({ c1: probe }), {
      evaluator: { channel: "c1", model: "m1" },
      evaluatorAny: true,
      eligible: [{ channel: "c1", model: "m2" }],
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.researcher).toEqual({ channel: "c1", model: "m1" });
  });
});

describe("recommendAssignments candidate pricing", () => {
  const cfgPriced = () =>
    loadEffectiveConfig(
      {
        "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n    price: { inPerMTok: 0.5, outPerMTok: 1.5 }\n",
        "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: tester\n    enabled: true\n",
      },
      {},
      {},
      { trusted: true },
    );

  it("calls priceFor only for candidates without an agent price, in eligible order", async () => {
    const seen: string[] = [];
    const r = await recommendAssignments(cfgPriced(), managed({ c1: mc(["m1", "m2", "m3"]) }), {
      mode: "rules",
      eligible: [
        { channel: "c1", model: "m3" },
        { channel: "c1", model: "m2" },
        { channel: "c1", model: "m1" },
      ],
      priceFor: async (channel, model) => {
        seen.push(`${channel}:${model}`);
        return { inPerMTok: 1, outPerMTok: 2 };
      },
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["c1:m3", "c1:m2"]);
  });
});

describe("recommendAssignments channel discovery", () => {
  const cfgExtra = () =>
    loadEffectiveConfig(
      {
        "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n    extraModels: [x1, x2]\n  - id: c2\n    type: ollama\n    enabled: true\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
        "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: tester\n    enabled: true\n",
      },
      {},
      {},
      { trusted: true },
    );

  it("keeps extraModels when listModels succeeds and when it throws", async () => {
    const ok = await recommendAssignments(cfgExtra(), managed({ c1: mc(["m1"]), c2: mc(["n1"]) }), { mode: "rules" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.channels.find((c) => c.id === "c1")?.models).toEqual(["m1", "x1", "x2"]);

    const failed = await recommendAssignments(cfgExtra(), managed({ c1: mc([], new Error("list fails")), c2: mc(["n1"]) }), { mode: "rules" });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      const c1 = failed.channels.find((c) => c.id === "c1");
      expect(c1?.error).toBe("list fails");
      expect(c1?.models).toEqual(["x1", "x2"]);
    }
  });
});

describe("recommendAssignments prompt and validation", () => {
  it("sends context, caps and price in the researcher prompt", async () => {
    const cfgP = loadEffectiveConfig(
      {
        "channels.yaml":
          "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n    modelCaps:\n      m1:\n        tools: native\n        vision: true\n        contextTokens: 32000\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
        "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: tester\n    enabled: true\n",
      },
      {},
      {},
      { trusted: true },
    );
    let promptText = "";
    const probe: RecommendChannel = {
      listModels: async () => ["m1", "m2"],
      chat: async function* (req: ChatRequest) {
        promptText = req.messages.map((m) => m.content).join("\n");
        yield { kind: "text", text: JSON.stringify({ assignments: [{ role: "general-worker", channel: "c1", model: "m2" }] }) } as ChatEvent;
        yield { kind: "done" } as ChatEvent;
      },
    };
    const r = await recommendAssignments(cfgP, managed({ c1: probe }), {
      context: {
        priorities: { speed: 1, cost: 3, quality: 2 },
        typicalWork: "refactors",
        workspace: { sizeClass: "small", files: 10, loc: 100 },
        hardware: { os: "linux", ramGb: 16, gpus: [{ name: "g", vramGb: 8 }] },
      },
      priceFor: async () => ({ inPerMTok: 1, outPerMTok: 2 }),
    });
    expect(r.ok).toBe(true);
    expect(promptText).toContain("- priorities (1-3): speed 1, cost 3, quality 2");
    expect(promptText).toContain("- typical work: refactors");
    expect(promptText).toContain("- workspace: small (10 files, ~100 loc)");
    expect(promptText).toContain("- hardware: linux, 16GB RAM, GPU g 8GB");
    expect(promptText).toContain("m1 (tools=native, vision=true, contextTokens=32000");
    expect(promptText).toMatch(/\$[\d.]+\/MTok\(/);
  });

  it("drops an assignment that fails hard requirements with the original reason", async () => {
    const cfgV = loadEffectiveConfig(
      {
        "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n",
        "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
        "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n  - id: image-reader\n    enabled: true\n",
      },
      {},
      {},
      { trusted: true },
    );
    const answer = JSON.stringify({
      assignments: [
        { role: "image-reader", channel: "c1", model: "m1" },
        { role: "general-worker", channel: "c1", model: "m1" },
      ],
    });
    const r = await recommendAssignments(cfgV, managed({ c1: mc(["m1"], answer) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments.map((a) => a.role)).toEqual(["general-worker"]);
      expect(r.dropped).toContain("image-reader: c1:m1 fails hard requirements");
    }
  });
});

describe("parseJsonObject", () => {
  it("extracts a JSON object embedded in surrounding prose", () => {
    expect(parseJsonObject('Sure: {"assignments":[]} done')).toEqual({ assignments: [] });
  });

  it("returns undefined when there is no brace pair", () => {
    expect(parseJsonObject("no json here")).toBeUndefined();
    expect(parseJsonObject("} backwards {")).toBeUndefined();
  });

  it("returns undefined for malformed JSON between the braces", () => {
    expect(parseJsonObject('{"assignments": [}')).toBeUndefined();
  });
});
