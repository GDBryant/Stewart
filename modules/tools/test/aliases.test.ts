import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import type { ToolCall } from "@stewart/kernel";
import type { RoleDef } from "@stewart/config";
import { ToolRegistry, projectTools } from "../src/api.js";
import { str } from "../src/toolBase.js";
import type { Tool } from "../src/types.js";
import { ProjectPaths } from "../src/projectPaths.js";

async function registry() {
  const h = fakeHost();
  const paths = await ProjectPaths.forProject(h.host);
  return projectTools(h.host, paths);
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "1", name, arguments: args as ToolCall["arguments"] });

const role = (tools: string[]): RoleDef => ({ id: "r", enabled: true, skills: [], tools, writePaths: [], turnBudget: 25 });

describe("ToolRegistry.resolve aliases", () => {
  it("Bash → RunTerminal, dropping unknown args with a note", async () => {
    const r = (await registry()).resolve(call("Bash", { command: "ls", timeout: 5, description: "x" }));
    expect(r).toEqual({
      call: { id: "1", name: "RunTerminal", arguments: { command: "ls" } },
      note: "'Bash' is not a tool here; ran RunTerminal instead; ignored unknown argument(s): timeout, description",
    });
  });

  it("Read → ReadFile with offset+limit → start_line+end_line", async () => {
    const r = (await registry()).resolve(call("Read", { file_path: "a.ts", offset: 10, limit: 5 }));
    expect(r).toEqual({
      call: { id: "1", name: "ReadFile", arguments: { path: "a.ts", start_line: 10, end_line: 14 } },
      note: "'Read' is not a tool here; ran ReadFile instead",
    });
  });

  it("Read limit without offset starts at line 1", async () => {
    const r = (await registry()).resolve(call("Read", { file_path: "a", limit: 5 }));
    expect("call" in r && r.call.arguments).toEqual({ path: "a", end_line: 5 });
  });

  it("Grep → Search forces regex and maps head_limit", async () => {
    const r = (await registry()).resolve(call("Grep", { pattern: "x", path: "src", "-n": true, head_limit: 3 }));
    expect("call" in r && r.call.arguments).toEqual({ query: "x", regex: true, path: "src", max_results: 3 });
    expect("call" in r && r.note).toContain("ignored unknown argument(s): -n");
  });

  it("Glob → FindFiles maps pattern to glob", async () => {
    const r = (await registry()).resolve(call("Glob", { pattern: "**/*.ts" }));
    expect("call" in r && r.call).toEqual({ id: "1", name: "FindFiles", arguments: { glob: "**/*.ts" } });
  });

  it("a rename never overwrites a key already present under the target name", async () => {
    const reg = await registry();
    for (const args of [{ file_path: "a", path: "b" }, { path: "b", file_path: "a" }]) {
      const r = reg.resolve(call("Write", { ...args, content: "c" }));
      expect("call" in r && r.call.arguments.path).toBe("b");
      expect("call" in r && "file_path" in r.call.arguments).toBe(false);
    }
  });

  it("Write/Edit → WriteFile/EditFile rename file_path", async () => {
    const reg = await registry();
    const w = reg.resolve(call("Write", { file_path: "a", content: "c" }));
    expect("call" in w && w.call).toEqual({ id: "1", name: "WriteFile", arguments: { path: "a", content: "c" } });
    const e = reg.resolve(call("Edit", { file_path: "a", old_string: "x", new_string: "y" }));
    expect("call" in e && e.call).toEqual({ id: "1", name: "EditFile", arguments: { path: "a", old_string: "x", new_string: "y" } });
  });

  it("alias target not in role is the unknown-tool path", async () => {
    const reg = (await registry()).for(role(["ReadFile"]));
    const r = reg.resolve(call("Bash", { command: "ls" }));
    expect(r).toEqual({ error: "unknown tool 'Bash'; available: ReadFile" });
  });

  it("alias arg mismatch reports the tried target", async () => {
    const r = (await registry()).resolve(call("Bash", {}));
    expect("error" in r && r.error).toMatch(/^unknown tool 'Bash' \(tried RunTerminal: missing required argument 'command' for RunTerminal\); available: /);
  });

  it("unknown name lists available tools", async () => {
    const reg = await registry();
    const r = reg.resolve(call("Nope", {}));
    const names = reg.tools.map((t) => t.spec.name).join(", ");
    expect(r).toEqual({ error: `unknown tool 'Nope'; available: ${names}` });
  });
});

describe("ToolRegistry.resolve native calls", () => {
  it("drops unknown optional args on closed schemas", async () => {
    const r = (await registry()).resolve(call("RunTerminal", { command: "ls", timeout: 5 }));
    expect(r).toEqual({
      call: { id: "1", name: "RunTerminal", arguments: { command: "ls" } },
      note: "ignored unknown argument(s): timeout",
    });
  });

  it("a valid native call has no note", async () => {
    const r = (await registry()).resolve(call("RunTerminal", { command: "ls" }));
    expect(r).toEqual({ call: { id: "1", name: "RunTerminal", arguments: { command: "ls" } } });
  });

  it("a native invalid call keeps the plain validation text", async () => {
    const r = (await registry()).resolve(call("RunTerminal", {}));
    expect(r).toEqual({ error: "missing required argument 'command' for RunTerminal" });
  });

  it("open schemas keep unknown args", async () => {
    const open: Tool = {
      spec: { name: "Open", description: "d", parameters: { type: "object", properties: { a: str }, required: ["a"] } },
      requiresApproval: false,
      execute: async () => "ok",
    };
    const r = new ToolRegistry([open]).resolve(call("Open", { a: "v", extra: 1 }));
    expect(r).toEqual({ call: { id: "1", name: "Open", arguments: { a: "v", extra: 1 } } });
  });

  it("does not mutate the input arguments", async () => {
    const args = { command: "ls", timeout: 5 };
    const r = (await registry()).resolve(call("RunTerminal", args));
    expect("call" in r).toBe(true);
    expect(args).toEqual({ command: "ls", timeout: 5 });
  });
});

describe("ToolRegistry.validate", () => {
  it("lists available tools on unknown names and does not alias", async () => {
    const reg = await registry();
    const names = reg.tools.map((t) => t.spec.name).join(", ");
    expect(reg.validate(call("Nope", {}))).toBe(`unknown tool 'Nope'; available: ${names}`);
    expect(reg.validate(call("Bash", { command: "ls" }))).toBe(`unknown tool 'Bash'; available: ${names}`);
  });
});
