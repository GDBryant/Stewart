import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { isBaselineId, isDiffPath } from "../src/diffArgs.js";
import { showFileDiff, type PlanOpsDeps } from "../src/planOps.js";

describe("isDiffPath", () => {
  it("accepts nested project-relative paths", () => {
    expect(isDiffPath("a.ts")).toBe(true);
    expect(isDiffPath("src/deep/a.ts")).toBe(true);
    expect(isDiffPath(".stewart/notes.md")).toBe(true);
  });
  it("rejects empty, absolute, parent and .git paths", () => {
    for (const p of ["", "/abs/a.ts", "\\abs\\a.ts", "C:/abs/a.ts", "c:\\abs\\a.ts", "..", "../a.ts", "a/../b.ts", ".git/config", ".git"]) {
      expect(isDiffPath(p)).toBe(false);
    }
  });
});

describe("isBaselineId", () => {
  it("accepts git shas and manifest ids", () => {
    expect(isBaselineId("base-1")).toBe(true);
    expect(isBaselineId("aaf3ec5deadbeef")).toBe(true);
    expect(isBaselineId("v1.2_3")).toBe(true);
  });
  it("rejects empty, dot-first and separator characters", () => {
    for (const id of ["", ".hidden", "..", "a/b", "a\\b", "a b", "a;b"]) {
      expect(isBaselineId(id)).toBe(false);
    }
  });
});

describe("showFileDiff validation", () => {
  const deps = (): { d: PlanOpsDeps; procs: { argv: string[] }[] } => {
    const { host, procs } = fakeHost({ "a.ts": "x" });
    return {
      procs,
      d: {
        host,
        bus: { emit: () => {} },
        ids: { next: (p: string) => `${p}-1` },
        interaction: {} as PlanOpsDeps["interaction"],
      },
    };
  };
  it("rejects a bad path before any host call", async () => {
    const { d, procs } = deps();
    await expect(showFileDiff(d, "s1", "../x", "base-1")).rejects.toThrow("invalid diff path: ../x");
    expect(procs).toHaveLength(0);
  });
  it("rejects a bad baseline id before any host call", async () => {
    const { d, procs } = deps();
    await expect(showFileDiff(d, "s1", "a.ts", "a/b")).rejects.toThrow("invalid baseline: a/b");
    expect(procs).toHaveLength(0);
  });
});
