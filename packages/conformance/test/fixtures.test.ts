import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_DIR = join(__dirname, "..", "fixtures", "claude");

export function parseNdjson(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const j = JSON.parse(l) as Record<string, unknown>;
      if (typeof j.type !== "string") throw new Error(`stream line missing type: ${l.slice(0, 60)}`);
      return j;
    });
}

describe("claude stream fixtures", () => {
  const streams = readdirSync(CLAUDE_DIR).filter((f) => f.endsWith("-stream.json"));

  it("has the v1 fixture set", () => {
    expect(streams.sort()).toEqual(["auth-stream.json", "badmodel-stream.json", "isolation-stream.json", "refused-tool-stream.json", "tooluse-stream.json"]);
  });

  for (const f of streams) {
    it(`${f} parses as stream-json NDJSON`, () => {
      const events = parseNdjson(readFileSync(join(CLAUDE_DIR, f), "utf8"));
      expect(events.length).toBeGreaterThan(0);
    });
  }

  it("rejects a stream line without a type field", () => {
    expect(() => parseNdjson('{"foo":1}')).toThrow(/missing type/);
  });

  it("rejects malformed NDJSON", () => {
    expect(() => parseNdjson("{not json")).toThrow();
  });
});
