import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../.github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
const read = (f) => readFileSync(join(dir, f), "utf8");

export function badUses(text) {
  return [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./") && !/@[\w.-]+$/.test(u));
}

describe("workflow actions", () => {
  it("every uses: carries a version ref", () => {
    for (const f of files) expect(badUses(read(f)), f).toEqual([]);
  });

  it("detects an unpinned action", () => {
    expect(badUses("uses: actions/checkout")).toEqual(["actions/checkout"]);
    expect(badUses("uses: actions/checkout@v7")).toEqual([]);
  });

  it("no action is on a Node 20 major", () => {
    const old = /actions\/(checkout|setup-node|upload-artifact)@v[1-4]\b|actions\/setup-java@v[1-4]\b|pnpm\/action-setup@v[1-4]\b/;
    for (const f of files) expect(read(f), f).not.toMatch(old);
  });

  it("pages artifact path is a directory, not the feed file", () => {
    const m = /upload-pages-artifact@[\w.]+\s+with:\s+path:\s*(\S+)/.exec(read("release.yml"));
    expect(m?.[1]).toBeDefined();
    expect(m[1]).not.toMatch(/\.xml$/);
  });
});
