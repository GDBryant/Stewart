import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { IdempotencyLog, recordPreImage, revertRunSnapshots, snapshotName } from "../src/api.js";

describe("pre-image snapshots", () => {
  it("restores a modified file and deletes a created one on revert", async () => {
    const { host, files } = fakeHost({ "a.ts": "old" });
    await recordPreImage(host, ".stewart", "r1", "a.ts");
    await recordPreImage(host, ".stewart", "r1", "new.ts");
    files["a.ts"] = "changed";
    files["new.ts"] = "created";
    const restored = await revertRunSnapshots(host, ".stewart", "r1");
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.sort()).toEqual(["a.ts", "new.ts"]);
    expect(files["a.ts"]).toBe("old");
    expect(files["new.ts"]).toBeUndefined();
  });
  it("records only the first pre-image per path; revert of an unknown run is a no-op", async () => {
    const { host, files } = fakeHost({ "a.ts": "v1" });
    await recordPreImage(host, ".stewart", "r1", "a.ts");
    files["a.ts"] = "v2";
    await recordPreImage(host, ".stewart", "r1", "a.ts");
    await revertRunSnapshots(host, ".stewart", "r1");
    expect(files["a.ts"]).toBe("v1");
    expect(await revertRunSnapshots(host, ".stewart", "none")).toEqual({ ok: true, value: [] });
    expect(snapshotName("src/a/b.ts")).toBe("src__a__b.ts");
  });
});

describe("IdempotencyLog", () => {
  it("replays recorded outcomes after reload and keys hooks by run/task/index", async () => {
    const { host } = fakeHost();
    const log = new IdempotencyLog(host, "idem.jsonl", "r1");
    const hooks = log.hooks("t1", 2);
    const key = hooks.key({ id: "c", name: "x", arguments: {} }, 1);
    expect(key).toBe("r1:t1:3");
    expect(hooks.lookup(key)).toBeUndefined();
    await hooks.record(key, "done");
    const again = new IdempotencyLog(host, "idem.jsonl", "r1");
    await again.load();
    expect(again.get(key)).toBe("done");
  });
});
