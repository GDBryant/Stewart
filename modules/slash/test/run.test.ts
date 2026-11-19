import { describe, expect, it } from "vitest";
import { runSlash } from "../src/api.js";
import { locals, makeDeps, REGISTRY } from "./helpers.js";

describe("runSlash", () => {
  it("returns false for non-commands", async () => {
    const { deps } = makeDeps();
    expect(await runSlash(REGISTRY, deps, "fix the bug")).toBe(false);
    expect(await runSlash(REGISTRY, deps, "//notacommand")).toBe(false);
  });

  it("unknown command answers with a local hint, no prompt sent", async () => {
    const { deps, events, sent } = makeDeps();
    expect(await runSlash(REGISTRY, deps, "/bogus")).toBe(true);
    expect(locals(events)[0]).toContain("Unknown command `/bogus`");
    expect(sent).toHaveLength(0);
  });
});
