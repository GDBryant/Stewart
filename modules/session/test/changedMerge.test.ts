import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { ProjectPaths } from "@stewart/tools";
import { mergeWrites } from "../src/changedMerge.js";

const paths = () => ProjectPaths.forProject(fakeHost().host);

describe("mergeWrites", () => {
  it("adds a successful tool write the tracker cannot see", async () => {
    const p = await paths();
    expect(mergeWrites([], [{ path: "code/a.ts", ok: true }], p)).toEqual(["code/a.ts"]);
    expect(mergeWrites(["b.ts"], [{ path: "code/a.ts", ok: true }], p)).toEqual(["b.ts", "code/a.ts"]);
  });

  it("keeps undefined when tracking is unavailable", async () => {
    const p = await paths();
    expect(mergeWrites(undefined, [{ path: "a.ts", ok: true }], p)).toBeUndefined();
  });

  it("skips a path whose last write record failed and duplicates", async () => {
    const p = await paths();
    const writes = [
      { path: "a.ts", ok: true },
      { path: "a.ts", ok: false, message: "nope" },
      { path: "b.ts", ok: false, message: "nope" },
      { path: "b.ts", ok: true },
    ];
    expect(mergeWrites([], writes, p)).toEqual(["b.ts"]);
    expect(mergeWrites(["b.ts"], writes, p)).toEqual(["b.ts"]);
  });

  it("skips paths that escape the workspace", async () => {
    const p = await paths();
    expect(mergeWrites([], [{ path: "../outside.ts", ok: true }], p)).toEqual([]);
    expect(mergeWrites([], [{ path: "/abs/outside.ts", ok: true }], p)).toEqual([]);
  });
});
