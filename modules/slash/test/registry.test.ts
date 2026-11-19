import { describe, expect, it } from "vitest";
import { createRegistry, createSlashRegistry, runSlash, type SlashCommand } from "../src/api.js";
import { locals, makeDeps } from "./helpers.js";

const cmd = (name: string, aliases?: string[]): SlashCommand => ({
  name,
  ...(aliases ? { aliases } : {}),
  argHint: "",
  description: `${name} desc`,
  run: async (ctx) => ctx.say(`${name} ran`),
});

describe("createRegistry", () => {
  it("finds commands by name and alias, case-insensitively, and lists in registration order", () => {
    const reg = createSlashRegistry([cmd("extra", ["xtra"])]);
    expect(reg.find("help")?.name).toBe("help");
    expect(reg.find("HeLp")?.name).toBe("help");
    expect(reg.find("xtra")?.name).toBe("extra");
    expect(reg.find("XTRA")?.name).toBe("extra");
    expect(reg.find("missing")).toBeUndefined();
    expect(reg.list().map((c) => c.name)).toEqual(["help", "init", "clear", "extra"]);
  });

  it("throws on a duplicate name", () => {
    expect(() => createRegistry([cmd("foo"), cmd("FOO")])).toThrow("duplicate slash command name: foo");
  });

  it("throws when an alias collides with another command's name", () => {
    expect(() => createRegistry([cmd("foo"), cmd("bar", ["foo"])])).toThrow("duplicate slash command name: foo");
  });

  it("throws when an alias collides with another alias", () => {
    expect(() => createRegistry([cmd("foo", ["same"]), cmd("bar", ["SAME"])])).toThrow("duplicate slash command name: same");
  });

  it("allows an alias equal to its own command's name", () => {
    expect(() => createRegistry([cmd("foo", ["foo"])])).not.toThrow();
  });
});

describe("createSlashRegistry", () => {
  it("extra commands appear in /help output", async () => {
    const { deps, events } = makeDeps();
    const reg = createSlashRegistry([cmd("deploy", ["dep"])]);
    await runSlash(reg, deps, "/help");
    expect(locals(events)[0]).toContain("/deploy");
  });

  it("rejects an extra command that collides with a built-in", () => {
    expect(() => createSlashRegistry([cmd("Help")])).toThrow("duplicate slash command name: help");
    expect(() => createSlashRegistry([cmd("wipe", ["clear"])])).toThrow("duplicate slash command name: clear");
  });
});
