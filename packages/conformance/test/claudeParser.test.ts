import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeStreamParser } from "@stewart/core";

const DIR = join(__dirname, "..", "fixtures", "claude");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf8").split("\n").filter((l) => l.trim());

describe("claude stream-json golden transcripts", () => {
  it("auth-stream: clean stream, result usage + cost", () => {
    const p = new ClaudeStreamParser();
    const events = fixture("auth-stream.json").flatMap((l) => p.feed(l));
    expect(p.failedEmitted).toBe(false);
    expect(events.filter((e) => e.t === "text").map((e) => (e as { text: string }).text).join("")).toContain("ok");
    expect(p.turnUsage()).toEqual({ in: 3506, out: 4, costUsd: 0.0102346 });
    expect(p.finishReason).toBe("stop");
  });

  it("isolation-stream: clean tools/MCP, no violation", () => {
    const p = new ClaudeStreamParser();
    for (const l of fixture("isolation-stream.json")) p.feed(l);
    expect(p.failedEmitted).toBe(false);
    expect(p.resultSeen).toBe(true);
    expect(p.finishReason).toBe("stop");
  });

  it("tooluse-stream: refused tool_use ends the turn with tool_calls", () => {
    const p = new ClaudeStreamParser();
    for (const l of fixture("tooluse-stream.json")) p.feed(l);
    expect(p.nativeCalls).toEqual([{ id: "toolu_1", name: "submit_plan", argumentsJson: '{"goal":"g","milestones":[{"id":1,"title":"t"}]}' }]);
    expect(p.toolTurnEnded).toBe(true);
    expect(p.finishReason).toBe("tool_calls");
  });

  it("refused-tool-stream: advisor allowed, refused bash cut at tool turn", () => {
    const p = new ClaudeStreamParser();
    for (const l of fixture("refused-tool-stream.json")) p.feed(l);
    expect(p.failedEmitted).toBe(false);
    expect(p.nativeCalls.map((c) => c.name)).toEqual(["bash"]);
    expect(p.toolTurnEnded).toBe(true);
    expect(p.finishReason).toBe("tool_calls");
  });

  it("badmodel-stream: result is_error → model_unavailable", () => {
    const p = new ClaudeStreamParser();
    const events = fixture("badmodel-stream.json").flatMap((l) => p.feed(l));
    const failed = events.find((e) => e.t === "failed");
    expect(failed).toMatchObject({ t: "failed", code: "model_unavailable" });
  });
});
