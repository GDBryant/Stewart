import { describe, expect, it } from "vitest";
import { runSlash } from "../src/api.js";
import { locals, makeDeps, REGISTRY } from "./helpers.js";

describe("/help", () => {
  it("emits a chat.local listing every command", async () => {
    const { deps, events } = makeDeps();
    expect(await runSlash(REGISTRY, deps, "/help")).toBe(true);
    const [text] = locals(events);
    expect(text).toContain("Commands");
    expect(text).toContain("/help");
    expect(text).toContain("/init");
  });
});
