import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { IMAGE_LIMITS, loadProjectContext, normalizeImages, parseImageData } from "../src/api.js";

describe("parseImageData", () => {
  it("splits data URIs and defaults bare base64 to png", () => {
    expect(parseImageData("data:image/webp;base64,QUJD")).toEqual({ mediaType: "image/webp", base64: "QUJD" });
    expect(parseImageData("QUJD")).toEqual({ mediaType: "image/png", base64: "QUJD" });
    expect(parseImageData("data:image/png;base64,a\nb")).toEqual({ mediaType: "image/png", base64: "a\nb" });
  });
});

describe("normalizeImages", () => {
  it("normalizes to data URIs and drops over-limit images and extras", () => {
    const small = "a".repeat(100);
    const huge = "A".repeat(Math.ceil((IMAGE_LIMITS.maxBytes + 1) / 0.75) + 4);
    const r = normalizeImages([small, huge, "data:image/gif;base64,R2lm"]);
    expect(r.images).toEqual([`data:image/png;base64,${small}`, "data:image/gif;base64,R2lm"]);
    expect(r.dropped).toBe(1);
    const many = normalizeImages(Array.from({ length: IMAGE_LIMITS.maxPerMessage + 2 }, () => small));
    expect(many.images).toHaveLength(IMAGE_LIMITS.maxPerMessage);
    expect(many.dropped).toBe(2);
  });
});

describe("loadProjectContext", () => {
  it("appends AGENTS.md and MEMORY.md in order, truncated to the limit", async () => {
    const { host } = fakeHost({ "AGENTS.md": "A".repeat(5000), "MEMORY.md": "mem" });
    const out = await loadProjectContext(host);
    expect(out).toContain("# Project instructions (AGENTS.md)");
    expect(out).toContain("# Project memory (MEMORY.md)");
    expect(out.indexOf("AGENTS.md")).toBeLessThan(out.indexOf("MEMORY.md"));
    expect(out.length).toBeLessThan(5000 + 4000);
    expect(out).toContain("A".repeat(4000));
  });

  it("returns empty when files are absent", async () => {
    const { host } = fakeHost();
    expect(await loadProjectContext(host)).toBe("");
  });
});
