import { describe, expect, it } from "vitest";
import { createSlashRegistry, runSlash, type SlashCommand } from "../src/api.js";
import { locals, makeDeps } from "./helpers.js";

describe("runSlash", () => {
  it("returns false for non-commands", async () => {
    const { deps } = makeDeps();
    const reg = createSlashRegistry();
    expect(await runSlash(reg, deps, "fix the bug")).toBe(false);
    expect(await runSlash(reg, deps, "//notacommand")).toBe(false);
  });

  it("unknown command answers with a local hint, no prompt sent", async () => {
    const { deps, events, sent } = makeDeps();
    await runSlash(createSlashRegistry(), deps, "/bogus");
    expect(locals(events)[0]).toContain("Unknown command `/bogus`");
    expect(sent).toHaveLength(0);
  });

  it("a throwing command resolves true and emits one /<name> failed chat.local", async () => {
    const { deps, events } = makeDeps();
    const boom: SlashCommand = { name: "boom", argHint: "", description: "x", run: async () => { throw new Error("kaput"); } };
    expect(await runSlash(createSlashRegistry([boom]), deps, "/boom")).toBe(true);
    expect(events.filter((e) => e.kind === "chat.local")).toHaveLength(1);
    expect(locals(events)).toEqual(["/boom failed: kaput"]);
  });

  it("stringifies a non-Error throw value", async () => {
    const { deps, events } = makeDeps();
    const boom: SlashCommand = { name: "boom", argHint: "", description: "x", run: async () => { throw "string boom"; } };
    await runSlash(createSlashRegistry([boom]), deps, "/boom");
    expect(locals(events)).toEqual(["/boom failed: string boom"]);
  });

  it("a non-throwing command emits no failure text", async () => {
    const { deps, events } = makeDeps();
    const ok: SlashCommand = { name: "ok", argHint: "", description: "x", run: async (ctx) => ctx.say("all good") };
    await runSlash(createSlashRegistry([ok]), deps, "/ok");
    expect(locals(events)).toEqual(["all good"]);
  });
});
