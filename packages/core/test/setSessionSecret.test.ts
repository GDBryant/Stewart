import { describe, expect, it, vi } from "vitest";
import { setSessionSecret } from "../src/handlers/setup.js";
import type { CoreCtx, ProjectCtx } from "../src/handlers/types.js";

function mk(setImpl: () => Promise<void>) {
  const secretValues = new Map<string, string>();
  const setSecret = vi.fn();
  const core = { secretValues, channelService: { setSecret } } as unknown as CoreCtx;
  const ctx = { host: { secrets: { set: setImpl } } } as unknown as ProjectCtx;
  return { core, ctx, secretValues, setSecret };
}

describe("setSessionSecret", () => {
  it("keeps the key in memory when persisting succeeds", async () => {
    const m = mk(async () => {});
    await setSessionSecret(m.core, m.ctx, "r", " k ");
    expect(m.secretValues.get("r")).toBe("k");
  });

  it("drops the memory-only key and rethrows a clear error when persisting fails", async () => {
    const m = mk(async () => {
      throw new Error("store down");
    });
    await expect(setSessionSecret(m.core, m.ctx, "r", "k")).rejects.toThrow(/could not be saved.*store down/);
    expect(m.secretValues.has("r")).toBe(false);
    expect(m.setSecret).toHaveBeenLastCalledWith("r", undefined);
  });

  it("rejects an empty key without touching state", async () => {
    const m = mk(async () => {});
    await expect(setSessionSecret(m.core, m.ctx, "r", " ")).rejects.toThrow("empty");
    expect(m.secretValues.size).toBe(0);
  });
});
