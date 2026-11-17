import { describe, expect, it } from "vitest";
import { DiffContent } from "../src/diffContent.js";

describe("DiffContent", () => {
  it("round-trips stored content by the returned uri", () => {
    const d = new DiffContent();
    const before = d.put("before", "src/a.ts", "old");
    const after = d.put("after", "src/a.ts", "new");
    expect(before).toMatch(/^stewart-diff:\/\//);
    expect(before).not.toBe(after);
    expect(d.get(before)).toBe("old");
    expect(d.get(after)).toBe("new");
  });
  it("returns undefined for unknown and non-store uris", () => {
    const d = new DiffContent();
    d.put("before", "a.ts", "x");
    expect(d.get("stewart-diff://diff/999/before-a.ts")).toBeUndefined();
    expect(d.get("file:///a.ts")).toBeUndefined();
    expect(d.get("")).toBeUndefined();
  });
  it("keeps only the latest 50 entries", () => {
    const d = new DiffContent();
    const first = d.put("before", "a.ts", "0");
    let last = "";
    for (let i = 1; i <= 50; i++) last = d.put("after", "a.ts", String(i));
    expect(d.get(first)).toBeUndefined();
    expect(d.get(last)).toBe("50");
  });
});
