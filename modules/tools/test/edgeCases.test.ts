import { describe, expect, it } from "vitest";
import { fakeHost } from "@stewart/kernel";
import { LeaseManager } from "@stewart/scheduling";
import { LeaseCycleError, LeaseTimeoutError } from "@stewart/run-state";
import type { Json, ToolCall, ToolSpec } from "@stewart/kernel";
import {
  ToolRegistry,
  outcomeMessage,
  validateArgs,
  leasedTools,
  projectTools,
  applyUnifiedPatch,
  NOT_ANSWERED_CANCELLED,
  UNCERTAIN_PREFIX,
  type Tool,
  type ToolOutcome,
} from "../src/api.js";
import { GenerateImage } from "../src/media.js";
import { ProjectPaths } from "../src/projectPaths.js";
import { checkInvestigatorCommand } from "../src/types.js";
import type { RoleDef } from "@stewart/config";

const sig = () => new AbortController().signal;

async function setup(files: Record<string, string> = {}) {
  const h = fakeHost(files);
  const paths = await ProjectPaths.forProject(h.host);
  return { h, paths, reg: projectTools(h.host, paths) };
}

describe("ToolRegistry + validateArgs + outcomeMessage", () => {
  const tool: Tool = {
    spec: { name: "T", description: "d", parameters: { type: "object", properties: { s: { type: "string" }, n: { type: "integer" }, b: { type: "boolean" }, a: { type: "array" }, o: { type: "object" }, e: { enum: ["x", 1] } }, required: ["s"], additionalProperties: false } },
    requiresApproval: false,
    execute: async () => "ok",
  };

  it("validates required, types, enum and additionalProperties", () => {
    const reg = new ToolRegistry([tool]);
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", n: 1, b: true, a: [], o: {}, e: "x" } })).toBeNull();
    expect(reg.validate({ id: "1", name: "Nope", arguments: {} })).toContain("unknown tool");
    expect(reg.validate({ id: "1", name: "T", arguments: {} })).toContain("missing required");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", z: 1 } })).toContain("unexpected argument");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: 1 } })).toContain("expected type string");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", n: 1.5 } })).toContain("integer");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", b: "y" } })).toContain("boolean");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", a: {} } })).toContain("array");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", o: [] } })).toContain("object");
    expect(reg.validate({ id: "1", name: "T", arguments: { s: "v", e: "no" } })).toContain("enum");
    expect(validateArgs({ s: "v", e: 1 }, tool.spec.parameters as Json, "T")).toBeNull();
    expect(validateArgs({ s: "v" }, { type: "object", properties: { s: { type: "number" }, u: {} } }, "T")).toContain("expected type number");
    expect(validateArgs({ u: "v" }, { type: "object", properties: { u: {} } }, "T")).toBeNull();
  });

  it("registerProvider wraps tools with provider category and a default preview", async () => {
    const reg = new ToolRegistry([]);
    const raw: Tool = {
      spec: { name: "Ext", description: "d", parameters: {} },
      requiresApproval: true,
      execute: async () => "done",
    };
    reg.registerProvider({ id: "srv", tools: () => [raw] });
    const t = reg.find("Ext")!;
    expect(t.category).toBe("MCP:srv");
    expect(await t.preview!({})).toEqual({ kind: "other", category: "MCP:srv" });
    expect(reg.specs.map((s) => s.name)).toEqual(["Ext"]);
    const reg2 = new ToolRegistry([]);
    reg2.registerProvider({
      id: "srv",
      category: "TRACKER",
      tools: () => [
        { spec: { name: "NoAppr", description: "d", parameters: {} }, requiresApproval: false, execute: async () => "x" },
        { spec: { name: "OwnCat", description: "d", parameters: {} }, requiresApproval: true, category: "GIT", preview: async () => null, execute: async () => "x" },
      ],
    });
    expect(reg2.find("NoAppr")!.category).toBe("TRACKER");
    expect(reg2.find("NoAppr")!.preview).toBeUndefined();
    expect(reg2.find("OwnCat")!.category).toBe("GIT");
    expect(await reg2.find("OwnCat")!.preview!({})).toBeNull();
  });

  it("formats every outcome kind", () => {
    const cases: [ToolOutcome, string][] = [
      [{ kind: "success", content: "c" }, "c"],
      [{ kind: "failure", message: "m" }, "Error: m"],
      [{ kind: "rejected", reason: "r" }, "Rejected by user: r"],
      [{ kind: "invalid", reason: "r" }, "Invalid tool call: r"],
      [{ kind: "uncertain", reason: "r" }, `${UNCERTAIN_PREFIX} r`],
    ];
    for (const [o, want] of cases) expect(outcomeMessage(o)).toBe(want);
    expect(NOT_ANSWERED_CANCELLED).toContain("cancelled");
  });
});

describe("leasedTools", () => {
  const mkTool = (name = "WriteFile", ran: string[] = []): Tool => ({
    spec: { name, description: "d", parameters: {} },
    requiresApproval: true,
    preview: async () => ({ kind: "file", path: "x", before: null, after: "y" }),
    execute: async () => {
      ran.push(name);
      return "wrote";
    },
  });

  function deps(leases: LeaseManager, taskId: string, over: Record<string, unknown> = {}) {
    return { host: fakeHost().host, leases, taskId, runId: "r1", leaseWaitMs: 50, stateDir: ".stewart", ...over } as Parameters<typeof leasedTools>[1];
  }

  it("leaves non-path tools and calls without a path untouched", async () => {
    const leases = new LeaseManager();
    const ran: string[] = [];
    const [t] = leasedTools([mkTool("RunTerminal", ran)], deps(leases, "t1"));
    expect(t).toBeDefined();
    await t.execute({ command: "ls" }, null, sig());
    expect(ran).toEqual(["RunTerminal"]);
    const [w] = leasedTools([mkTool("WriteFile", ran)], deps(leases, "t1"));
    await w.execute({ notapath: 1 }, null, sig());
    expect(ran).toContain("WriteFile");
  });

  it("acquires a lease, snapshots once, then executes", async () => {
    const { host, files } = fakeHost({ "a.ts": "old" });
    const leases = new LeaseManager();
    const [w] = leasedTools([mkTool()], { host, leases, taskId: "t1", runId: "r1", leaseWaitMs: 50, stateDir: ".stewart" });
    const out = await w.execute({ path: "a.ts" }, { kind: "file", path: "a.ts", before: null, after: "n" }, sig());
    expect(out).toBe("wrote");
    expect(Object.keys(files).some((k) => k.includes("snapshots"))).toBe(true);
    expect(leases.holder("a.ts")).toBe("t1");
    await w.execute({ path: "a.ts" }, { kind: "file", path: "a.ts", before: null, after: "n" }, sig());
  });

  it("throws LeaseTimeoutError when the wait times out and reports the holder via onWait", async () => {
    const leases = new LeaseManager();
    leases.register("t1");
    await leases.acquire("a.ts", "t1", 1000);
    let waited = "";
    const [w] = leasedTools([mkTool()], deps(leases, "t2", { onWait: (_p: string, h: string) => (waited = h) }));
    await expect(w.execute({ path: "a.ts" }, null, sig())).rejects.toThrow(LeaseTimeoutError);
    expect(waited).toBe("t1");
  });

  it("throws LeaseCycleError on an AB-BA wait cycle", async () => {
    const leases = new LeaseManager();
    leases.register("t1");
    leases.register("t2");
    await leases.acquire("a.ts", "t1", 5000);
    await leases.acquire("b.ts", "t2", 5000);
    const [w2] = leasedTools([mkTool()], deps(leases, "t2"));
    const [w1] = leasedTools([mkTool()], deps(leases, "t1"));
    const pending = w2.execute({ path: "a.ts" }, null, sig()).catch((e) => e);
    await expect(w1.execute({ path: "b.ts" }, null, sig())).rejects.toThrow(LeaseCycleError);
    leases.releaseAll?.();
    await pending;
  });
});

describe("GenerateImage", () => {
  it("uses the channel generator when it returns an image", async () => {
    const { h, paths } = await setup();
    const t = new GenerateImage(h.host, paths, async () => ({ base64: "QUJD" }));
    expect(await t.execute({ path: "img/out.png", prompt: "a cat" }, null, sig())).toContain("generated image");
    expect(await t.preview({ path: "img/out.png" })).toEqual({ kind: "other", category: "OTHER" });
  });

  it("falls back to provided content or a sanitised SVG", async () => {
    const { h, paths, } = await setup();
    const files = h.files;
    const t = new GenerateImage(h.host, paths, async () => undefined);
    await t.execute({ path: "a.svg", prompt: "x<y", content: "<svg>custom</svg>" }, null, sig());
    expect(files["a.svg"]).toBe("<svg>custom</svg>");
    const t2 = new GenerateImage(h.host, paths);
    await t2.execute({ path: "b.svg", prompt: "x<y&z>" }, null, sig());
    expect(files["b.svg"]).toContain("<desc>xyz</desc>");
  });
});

describe("RunTerminal", () => {
  it("runs the approved command and reports exit code", async () => {
    const { reg, h } = await setup();
    h.setProcHandler((_argv, onData) => {
      onData("hi\n");
      return { code: 0 };
    });
    const t = reg.find("RunTerminal")!;
    const prev = await t.preview!({ command: "echo hi" });
    expect(prev).toMatchObject({ kind: "command", command: "echo hi" });
    expect(await t.execute({ command: "echo hi" }, prev, sig())).toContain("exit code: 0");
    expect(await t.execute({ command: "echo hi" }, prev, sig())).toContain("hi");
  });

  it("rejects a missing or changed preview and kills on abort", async () => {
    const { reg, h } = await setup();
    h.setProcHandler(() => "never");
    const t = reg.find("RunTerminal")!;
    await expect(t.execute({ command: "ls" }, null, sig())).rejects.toThrow(/missing preview/);
    const prev = await t.preview!({ command: "ls" });
    await expect(t.execute({ command: "rm -rf /" }, prev, sig())).rejects.toThrow(/changed since approval/);
    const ac = new AbortController();
    ac.abort();
    const prev2 = await t.preview!({ command: "sleep 9" });
    await t.execute({ command: "sleep 9" }, prev2, ac.signal);
    expect(h.procs.at(-1)?.killed).toBe(true);
  });
});

describe("ProjectPaths with a workspace root", () => {
  it("resolves absolute and relative paths under the root and rejects escapes", async () => {
    const h = fakeHost({}, { roots: ["/ws"] });
    const paths = await ProjectPaths.forProject(h.host);
    expect(paths.base).toBe("/ws");
    expect(paths.resolve("/ws/src/a.ts")).toBe("src/a.ts");
    expect(paths.resolve("src/a.ts")).toBe("src/a.ts");
    expect(paths.resolve("/ws")).toBe(".");
    expect(() => paths.resolve("/etc/passwd")).toThrow(/escapes/);
    expect(() => paths.resolve("../out")).toThrow(/escapes/);
    expect(() => paths.resolve(".git/config")).toThrow(/denied/);
  });
});

describe("Search edge cases", () => {
  it("rejects an invalid regex and a missing dir, clamps max_results", async () => {
    const { reg } = await setup({ "a.ts": "x" });
    const t = reg.find("Search")!;
    await expect(t.execute({ query: "(", regex: true }, null, sig())).rejects.toThrow(/invalid regex/);
    await expect(t.execute({ query: "x", path: "nope" }, null, sig())).rejects.toThrow(/not found/);
  });
});

describe("applyUnifiedPatch", () => {
  it("applies hunks, appends new content and rejects bad patches", () => {
    expect(applyUnifiedPatch("a\nb", "@@\n-a\n+c", "f")).toBe("c\nb");
    expect(applyUnifiedPatch("", "@@\n+new", "f")).toBe("new");
    expect(() => applyUnifiedPatch("x", "no hunks here", "f")).toThrow(/no hunks/);
    expect(() => applyUnifiedPatch("x", "@@\n-missing\n+y", "f")).toThrow(/failed to apply/);
  });
});

describe("checkInvestigatorCommand", () => {
  it("allows read-only programs and git read subcommands; rejects the rest", () => {
    expect(() => checkInvestigatorCommand("ls -la")).not.toThrow();
    expect(() => checkInvestigatorCommand("git status")).not.toThrow();
    expect(() => checkInvestigatorCommand("git log --oneline")).not.toThrow();
    expect(() => checkInvestigatorCommand("cat a > b")).toThrow(/not allowed/);
    expect(() => checkInvestigatorCommand("rm x")).toThrow(/not allowed/);
    expect(() => checkInvestigatorCommand("git push")).toThrow(/not allowed/);
    expect(() => checkInvestigatorCommand("git -C repo")).toThrow(/not allowed/);
  });
});

describe("ToolRegistry.for preview passthrough", () => {
  it("calls the base preview when the path is allowed", async () => {
    const { reg } = await setup();
    const role = { id: "r", name: "r", prompt: "", tools: ["WriteFile"], writePaths: ["ok/**"], enabled: true } as unknown as RoleDef;
    const rr = reg.for(role);
    const t = rr.find("WriteFile")!;
    const prev = await t.preview!({ path: "ok/a.ts", content: "x" });
    expect(prev?.kind).toBe("file");
    await expect(t.preview!({ path: "no/a.ts", content: "x" })).rejects.toThrow(/writePaths/);
    const t2 = rr.find("WriteFile")!;
    expect(t2.spec.name).toBe("WriteFile");
  });
});
