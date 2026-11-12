import { describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "@stewart/roles-skills";
import { buildRecommendPrompt } from "../src/recommendPrompt.js";
import type { Candidate } from "../src/assign.js";

const cfg = () =>
  loadEffectiveConfig(
    {
      "channels.yaml": "version: 1\nitems:\n  - id: c1\n    type: ollama\n    enabled: true\n",
      "agents.yaml": "version: 1\nitems:\n  - id: a1\n    channel: c1\n    model: m1\n",
      "roles.yaml": "version: 1\nitems:\n  - id: general-worker\n    enabled: true\n    tools: [WriteFile]\n    prompt: |\n      Writes   code\n      carefully\n  - id: tester\n    enabled: true\n",
    },
    {},
    {},
    { trusted: true },
  );

const rules = { assignments: [{ role: "general-worker", channel: "c1", model: "m1" }], unfilled: [] } as never;
const candidate: Candidate = { channel: "c1", channelType: "ollama", model: "m1", caps: { tools: true }, costBlended: 1.5, costTier: "low" };

describe("buildRecommendPrompt", () => {
  it("lists roles with normalised prompt text, channel models, cost and the rules baseline", () => {
    const p = buildRecommendPrompt({ config: cfg(), channels: [{ id: "c1", type: "ollama", models: ["m1"] }], candidates: [candidate], rules });
    expect(p).toContain("- general-worker: Writes code carefully");
    expect(p).toContain("- c1 (ollama): m1 ($1.50/MTok(low))");
    expect(p).toContain("- general-worker: c1:m1");
    expect(p).not.toContain("Context:");
  });

  it("annotates channels whose model listing failed and falls back when no baseline exists", () => {
    const p = buildRecommendPrompt({
      config: cfg(),
      channels: [{ id: "c1", type: "ollama", models: [], error: "boom" }],
      candidates: [],
      rules: { assignments: [], unfilled: [] } as never,
    });
    expect(p).toContain("- c1 (ollama) [listModels failed: boom]: ");
    expect(p).toContain("(none)");
  });

  it("includes the context block only when context facts are supplied", () => {
    const base = { config: cfg(), channels: [], candidates: [], rules };
    expect(buildRecommendPrompt({ ...base, context: { typicalWork: "refactors" } as never })).toContain("- typical work: refactors");
    expect(buildRecommendPrompt({ ...base, context: {} as never })).not.toContain("Context:");
  });
});
