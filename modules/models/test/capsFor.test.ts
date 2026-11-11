import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS, capsFor, userCaps } from "../src/api.js";

describe("userCaps", () => {
  it("returns the user's fields for the model and nothing else", () => {
    expect(userCaps({ modelCaps: { m: { vision: true, numCtx: 8192 } } }, "m")).toEqual({ vision: true, numCtx: 8192 });
  });
  it("is empty for an unknown model, a missing map or no source (absent = unknown, never a default)", () => {
    expect(userCaps({ modelCaps: { m: { vision: true } } }, "other")).toEqual({});
    expect(userCaps({}, "m")).toEqual({});
    expect(userCaps(undefined, "m")).toEqual({});
  });
});

describe("capsFor", () => {
  it("puts the user's fields over DEFAULT_CAPS", () => {
    const c = capsFor({ modelCaps: { m: { tools: "native", imageGen: true, contextTokens: 100 } } }, "m");
    expect(c).toEqual({ ...DEFAULT_CAPS, tools: "native", imageGen: true, contextTokens: 100 });
  });
  it("returns DEFAULT_CAPS for an unknown model, a missing map or no source, as a fresh object", () => {
    for (const src of [{ modelCaps: { m: { vision: true } } }, {}, undefined]) {
      const c = capsFor(src, "x");
      expect(c).toEqual(DEFAULT_CAPS);
      expect(c).not.toBe(DEFAULT_CAPS);
    }
  });
  it("an explicitly undefined field does not override the default", () => {
    expect(capsFor({ modelCaps: { m: { vision: undefined, tools: "none" } } }, "m")).toEqual({ ...DEFAULT_CAPS, tools: "none" });
  });
  it("does not mutate DEFAULT_CAPS", () => {
    capsFor({ modelCaps: { m: { vision: true } } }, "m");
    expect(DEFAULT_CAPS.vision).toBe(false);
  });
});
