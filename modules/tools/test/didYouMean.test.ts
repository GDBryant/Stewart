import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { projectTools } from "../src/api.js";
import { ProjectPaths } from "../src/projectPaths.js";

async function setup(files: Record<string, string>) {
  const h = fakeHost(files);
  const paths = await ProjectPaths.forProject(h.host);
  return { paths, reg: projectTools(h.host, paths) };
}

describe("file-not-found did-you-mean", () => {
  const files = { "app/ctl/Meeting_attendance.php": "x", "app/ctl/Other.php": "y" };

  it("EditFile suggests the single close sibling for a glued prefix", async () => {
    const { reg } = await setup(files);
    const t = reg.find("EditFile")!;
    await expect(t.preview!({ path: "app/ctl/PHP_EOLMeeting_attendance.php", old_string: "a", new_string: "b" })).rejects.toThrow(
      "file not found: app/ctl/PHP_EOLMeeting_attendance.php (did you mean app/ctl/Meeting_attendance.php?)",
    );
  });

  it("ApplyPatch gets the same hint", async () => {
    const { reg } = await setup(files);
    await expect(reg.find("ApplyPatch")!.preview!({ path: "app/ctl/XMeeting_attendance.php", patch: "p" })).rejects.toThrow("did you mean");
  });

  it("no hint when nothing is close or the match is ambiguous", async () => {
    const { reg, paths } = await setup({ "d/abcd.txt": "1", "d/bcd.txt": "2" });
    await expect(reg.find("EditFile")!.preview!({ path: "d/Nope.txt", old_string: "a", new_string: "b" })).rejects.toThrow(/^file not found: d\/Nope\.txt$/);
    expect(await paths.suggest("d/zabcd.txt")).toBeNull();
  });

  it("does not suggest from other directories or the same name", async () => {
    const { paths } = await setup({ "a/Meeting.php": "1", "b/xMeeting.php": "2" });
    expect(await paths.suggest("b/yMeeting.php")).toBeNull();
    expect(await paths.suggest("a/Meeting.php")).toBeNull();
  });
});

describe("argsError", () => {
  it("resolve and validate reject a call whose arguments failed to parse", async () => {
    const { reg } = await setup({});
    const call = { id: "1", name: "EditFile", arguments: {}, argsError: "arguments were truncated" };
    expect(reg.resolve(call)).toEqual({ error: "arguments were truncated" });
    expect(reg.validate(call)).toBe("arguments were truncated");
  });
  it("a normal call is unaffected", async () => {
    const { reg } = await setup({ "a.txt": "x" });
    expect("error" in reg.resolve({ id: "1", name: "ReadFile", arguments: { path: "a.txt" } })).toBe(false);
  });
});
