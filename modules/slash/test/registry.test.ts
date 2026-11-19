import { describe, expect, it } from "vitest";
import { builtinCommands, createRegistry } from "../src/api.js";

describe("createRegistry", () => {
  it("finds commands by name and lists their info", () => {
    const reg = createRegistry(builtinCommands());
    expect(reg.find("help")?.name).toBe("help");
    expect(reg.find("missing")).toBeUndefined();
    const list = reg.list();
    expect(list.map((c) => c.name)).toEqual(["help", "init", "clear"]);
    expect(list[0]).toMatchObject({ name: "help", argHint: "", description: "List commands" });
  });
});
