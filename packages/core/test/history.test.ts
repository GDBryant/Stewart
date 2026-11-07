import { describe, expect, it } from "vitest";
import { ChatHistoryStore } from "../src/history.js";
import type { ChatMessage } from "@stewart/kernel";
import { fakeHost } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function mkStore(files: Record<string, string> = {}, retentionDays = 30) {
  const h = fakeHost(files);
  return { store: new ChatHistoryStore(h.host, "/st/history", retentionDays), files };
}

describe("ChatHistoryStore", () => {
  it("saves and loads a session, dropping system messages", async () => {
    const { store } = mkStore();
    const msgs: ChatMessage[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", toolCalls: [{ id: "c1", name: "ReadFile", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", content: "file body" },
    ];
    await store.save("s1", msgs, 1000);
    const loaded = await store.load("s1");
    expect(loaded?.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(loaded?.[1].toolCalls?.[0].name).toBe("ReadFile");
    expect(loaded?.[2].toolCallId).toBe("c1");
  });

  it("derives the title from the first user message", async () => {
    const { store, files } = mkStore();
    await store.save("s1", [{ role: "user", content: "x".repeat(100) }], 1);
    const saved = JSON.parse(files["/st/history/s1.json"]);
    expect(saved.title).toHaveLength(60);
    expect(saved.sessionId).toBe("s1");
  });

  it("lists sessions sorted by savedAt and deletes one with its images", async () => {
    const { store, files } = mkStore();
    await store.save("old", [{ role: "user", content: "old" }], 1);
    await store.save("new", [{ role: "user", content: "new", images: [PNG] }], 2);
    const list = await store.list();
    expect(list.map((s) => s.sessionId)).toEqual(["new", "old"]);
    expect(list[0].messageCount).toBe(1);
    await store.delete("new");
    expect(Object.keys(files).filter((k) => k.includes("new"))).toHaveLength(0);
    expect((await store.list()).map((s) => s.sessionId)).toEqual(["old"]);
  });

  it("deduplicates identical images by hash and round-trips them on load", async () => {
    const { store, files } = mkStore();
    await store.save("s1", [{ role: "user", content: "see", images: [PNG, PNG] }], 1);
    const imageFiles = Object.keys(files).filter((k) => k.includes("-images/"));
    expect(imageFiles).toHaveLength(1);
    const loaded = await store.load("s1");
    expect(loaded?.[0].images).toEqual([PNG, PNG]);
  });

  it("sweeps orphaned images on save and keeps referenced ones", async () => {
    const { store, files } = mkStore();
    await store.save("s1", [{ role: "user", content: "a", images: [PNG] }], 1);
    files["/st/history/s1-images/deadbeef.png"] = "stale";
    await store.save("s1", [{ role: "user", content: "a", images: [PNG] }], 2);
    expect(files["/st/history/s1-images/deadbeef.png"]).toBeUndefined();
    expect(Object.keys(files).filter((k) => k.includes("-images/"))).toHaveLength(1);
  });

  it("returns null for a missing session", async () => {
    const { store } = mkStore();
    expect(await store.load("nope")).toBeNull();
  });

  it("quarantines a corrupt session file as .corrupt and removes it", async () => {
    const { store, files } = mkStore({ "/st/history/bad.json": "{not json" });
    expect(await store.load("bad")).toBeNull();
    expect(files["/st/history/bad.json"]).toBeUndefined();
    expect(files["/st/history/bad.json.corrupt"]).toBe("{not json");
  });

  it("quarantines corrupt files discovered during list", async () => {
    const { store, files } = mkStore({ "/st/history/ok.json": JSON.stringify({ version: 1, sessionId: "ok", title: "t", savedAt: 1, messages: [] }), "/st/history/bad.json": "xxx" });
    const list = await store.list();
    expect(list.map((s) => s.sessionId)).toEqual(["ok"]);
    expect(files["/st/history/bad.json"]).toBeUndefined();
    expect(files["/st/history/bad.json.corrupt"]).toBe("xxx");
  });

  it("skips image entries with unsafe filenames and keeps missing files as absent", async () => {
    const chat = {
      version: 1,
      sessionId: "s1",
      title: "t",
      savedAt: 1,
      messages: [
        { role: "user", content: "x", images: [{ file: "../evil.png", mediaType: "image/png", name: "i" }, { file: "f".repeat(64) + ".png", mediaType: "image/png", name: "i2" }] },
      ],
    };
    const { store } = mkStore({ "/st/history/s1.json": JSON.stringify(chat) });
    const loaded = await store.load("s1");
    expect(loaded?.[0].images).toBeUndefined();
  });

  it("prunes sessions older than retention; 0 keeps everything", async () => {
    const { store } = mkStore({}, 7);
    const now = Date.now();
    await store.save("old", [{ role: "user", content: "x" }], now - 10 * 86_400_000);
    await store.save("fresh", [{ role: "user", content: "y" }], now);
    expect(await store.prune(now)).toEqual(["old"]);
    expect((await store.list()).map((s) => s.sessionId)).toEqual(["fresh"]);

    const { store: forever } = mkStore({}, 0);
    await forever.save("old", [{ role: "user", content: "x" }], 1);
    expect(await forever.prune()).toEqual([]);
  });
});
