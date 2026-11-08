import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import {
  ChatHistoryStore,
  IdempotencyLog,
  imgBytesToB64,
  LeaseCycleError,
  LeaseTimeoutError,
  revertRunSnapshots,
  storedMediaType,
} from "../src/api.js";

describe("lease errors", () => {
  it("carry path, victim and holder details", () => {
    const c = new LeaseCycleError("t1", "a.ts", "t0");
    expect(c.name).toBe("LeaseCycleError");
    expect(c.message).toContain("a.ts");
    expect(c.message).toContain("t1");
    expect(c.victim).toBe("t1");
    expect(c.path).toBe("a.ts");
    expect(c.holder).toBe("t0");
    const t = new LeaseTimeoutError("b.ts");
    expect(t.name).toBe("LeaseTimeoutError");
    expect(t.message).toContain("b.ts");
    expect(t.path).toBe("b.ts");
  });
});

describe("revertRunSnapshots edge cases", () => {
  it("skips manifest lines that are corrupt and entries whose snapshot is missing", async () => {
    const { host, files } = fakeHost();
    const dir = ".stewart/scratch/r1/snapshots";
    files[`${dir}/manifest.jsonl`] = [
      "not-json",
      JSON.stringify({ path: "gone.ts", existed: true, snap: "gone.ts" }),
      JSON.stringify({ path: "ok.ts", existed: true, snap: "ok.snap" }),
    ].join("\n");
    files[`${dir}/ok.snap`] = "prior";
    files["ok.ts"] = "after";
    files["gone.ts"] = "after";
    const restored = await revertRunSnapshots(host, ".stewart", "r1");
    expect(restored).toEqual(["ok.ts"]);
    expect(files["ok.ts"]).toBe("prior");
    expect(files["gone.ts"]).toBe("after");
  });
});

describe("IdempotencyLog edge cases", () => {
  it("ignores corrupt log lines on load and clears one task's keys", async () => {
    const { host, files } = fakeHost({ "i.jsonl": "bad\n" + JSON.stringify({ key: "k", content: "v" }) + "\n" + JSON.stringify({ nope: 1 }) });
    const log = new IdempotencyLog(host, "i.jsonl", "r1");
    await log.load();
    expect(log.size).toBe(1);
    expect(log.get("k")).toBe("v");
    await log.record("r1:t1:0", "a");
    await log.record("r1:t2:0", "b");
    log.clearTask("t1");
    expect(log.get("r1:t1:0")).toBeUndefined();
    expect(log.get("r1:t2:0")).toBe("b");
    expect(log.size).toBe(2);
  });

  it("records and looks up through task hooks", async () => {
    const { host } = fakeHost();
    const log = new IdempotencyLog(host, "i.jsonl", "r1");
    const hooks = log.hooks("t1");
    const key = hooks.key({ id: "c", name: "x", arguments: {} }, 0);
    expect(key).toBe("r1:t1:0");
    expect(hooks.lookup(key)).toBeUndefined();
    await hooks.record(key, "done");
    expect(hooks.lookup(key)).toBe("done");
    expect(log.size).toBe(1);
  });
});

describe("storedMediaType / imgBytesToB64", () => {
  it("prefers the stored media type, then the extension, then png", () => {
    expect(storedMediaType({ file: "x.jpeg", mediaType: "image/webp", name: "n" })).toBe("image/webp");
    expect(storedMediaType({ file: "x.webp", mediaType: "", name: "n" })).toBe("image/webp");
    expect(storedMediaType({ file: "x.unknownext", mediaType: "", name: "n" })).toBe("image/png");
  });

  it("round-trips bytes through base64", () => {
    expect(imgBytesToB64(new Uint8Array([104, 105]))).toBe("aGk=");
  });
});

describe("ChatHistoryStore edge cases", () => {
  it("keeps the placeholder name when the stored image file vanished", async () => {
    const { host, files } = fakeHost();
    const store = new ChatHistoryStore(host, "hist");
    await store.save("s1", [{ role: "user", content: "hi", images: ["data:image/png;base64,aGk="] }]);
    const dir = "hist/s1-images";
    for (const k of Object.keys(files)) if (k.startsWith(dir)) delete files[k];
    const msgs = await store.load("s1");
    expect(msgs).toHaveLength(1);
    expect(msgs![0].images).toBeUndefined();
  });

  it("lists nothing when the history dir does not exist", async () => {
    const { host } = fakeHost();
    const store = new ChatHistoryStore(host, "hist");
    expect(await store.list()).toEqual([]);
    expect(await store.load("nope")).toBeNull();
  });
});
