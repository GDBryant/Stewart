import { describe, expect, it } from "vitest";
import { stripImages, type ChatMessage } from "../src/api.js";

describe("stripImages", () => {
  it("replaces user images with placeholders and leaves other messages alone", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "look", images: ["data:image/png;base64,AA", "data:image/png;base64,BB"] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "no images" },
    ];
    const out = stripImages(msgs);
    expect(out[0]).toMatchObject({ content: "look\n[image: image-1]\n[image: image-2]" });
    expect((out[0] as { images?: string[] }).images).toBeUndefined();
    expect(out[1]).toBe(msgs[1]);
    expect(out[2]).toBe(msgs[2]);
  });
});
