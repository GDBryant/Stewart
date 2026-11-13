import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync as exists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, secretEnvName } from "../src/nodeHost.js";
import { dirStore } from "../src/configStore.js";
import { prepareConfig, createWorkspace, removeWorkspace } from "../src/workspace.js";
import { summarize, formatTable, writeResults, type ResultsFile } from "../src/results.js";
import { loadDotEnv, selectTasks, pool, main } from "../src/main.js";
import type { TaskResult } from "../src/runner.js";
import type { EvalTask } from "../src/tasks.js";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "evals-test-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("nodeHost", () => {
  const hostOf = async (env: Record<string, string | undefined> = {}) => {
    const root = await tmp();
    const stateDir = join(root, "state");
    return { host: nodeHost({ root, stateDir, env }), root, stateDir };
  };

  it("reads and edits files with content and anchors", async () => {
    const { host, root } = await hostOf();
    await writeFile(join(root, "a.txt"), "hello world");
    expect((await host.files.read("a.txt")).content).toBe("hello world");
    await host.files.edit({ path: "a.txt", content: "replaced" });
    expect(await host.files.readBack("a.txt")).toBe("replaced");
    await host.files.edit({ path: "a.txt", edits: [{ oldText: "placed", newText: "written" }] });
    expect(await host.files.readBack("a.txt")).toBe("rewritten");
    await expect(host.files.edit({ path: "a.txt", edits: [{ oldText: "nope", newText: "x" }] })).rejects.toThrow("anchor not found");
  });

  it("reports exists, stat, and lists skipping dot dirs and node_modules with dir prefix", async () => {
    const { host, root } = await hostOf();
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules/x"), { recursive: true });
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, ".git", "hidden"), "h");
    await writeFile(join(root, "node_modules/x", "m.js"), "m");
    await writeFile(join(root, "sub", "s.txt"), "s");
    await writeFile(join(root, "top.txt"), "t");
    expect(await host.files.exists("top.txt")).toBe(true);
    expect(await host.files.exists("absent.txt")).toBe(false);
    expect((await host.files.stat("top.txt")).size).toBe(1);
    const all = (await host.files.list("")).sort();
    expect(all).toEqual(["sub/s.txt", "top.txt"]);
    expect(await host.files.list("sub")).toEqual(["sub/s.txt"]);
  });

  it("round-trips binary and handles append/read/delete plus absolute paths", async () => {
    const { host, root } = await hostOf();
    const payload = Buffer.from([0, 1, 2, 255]).toString("base64");
    await host.files.writeBinary("bin/b.dat", payload);
    const back = await host.files.readBinary("bin/b.dat");
    expect(back.base64).toBe(payload);
    expect(back.size).toBe(4);
    expect(await host.files.readLines("log/l.txt")).toEqual([]);
    await host.files.appendLine("log/l.txt", "one");
    await host.files.appendLine("log/l.txt", "two");
    expect(await host.files.readLines("log/l.txt")).toEqual(["one", "two"]);
    const absFile = join(await tmp(), "abs.txt");
    await host.files.writeAtomic(absFile, "abs");
    expect(await host.files.readBack(absFile)).toBe("abs");
    expect(exists(join(root, "abs.txt"))).toBe(false);
    await host.files.delete("top-missing.txt");
    await host.files.writeAtomic("del.txt", "x");
    await host.files.delete("del.txt");
    expect(await host.files.exists("del.txt")).toBe(false);
  });

  it("runs processes with output and exit code, and kills trees", async () => {
    const { host, root } = await hostOf();
    let out = "";
    const p = host.proc.run(["/bin/sh", "-c", "echo hi; echo err >&2; exit 3"], { cwd: root, onData: (d) => (out += d) });
    const { code } = await p.done;
    expect(code).toBe(3);
    expect(out).toContain("hi");
    expect(out).toContain("err");
    let out2 = "";
    const p2 = host.proc.run(["/bin/sh", "-c", "sleep 30"], { cwd: root, onData: (d) => (out2 += d) });
    await p2.killTree();
    expect((await p2.done).code).not.toBe(0);
  });

  it("looks up secrets from STEWART_SECRET_ env and supports set/delete", async () => {
    const { host } = await hostOf({ STEWART_SECRET_MY_KEY: "from-env" });
    expect(await host.secrets.get("my-key")).toBe("from-env");
    await host.secrets.set("my-key", "from-store");
    expect(await host.secrets.get("my-key")).toBe("from-store");
    await host.secrets.delete("my-key");
    expect(await host.secrets.get("my-key")).toBe("from-env");
    expect(await host.secrets.get("nothing")).toBeUndefined();
  });

  it("maps refs to env names", () => {
    expect(secretEnvName("openai-key")).toBe("STEWART_SECRET_OPENAI_KEY");
    expect(secretEnvName("a/b.c")).toBe("STEWART_SECRET_A_B_C");
  });
});

describe("dirStore", () => {
  it("reads config files and skills, and handles absent dirs", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "agents.yaml"), "version: 1");
    await mkdir(join(dir, "skills"));
    await writeFile(join(dir, "skills", "s1.md"), "body");
    await writeFile(join(dir, "skills", "skip.txt"), "no");
    const layer = await dirStore(dir).read();
    expect(layer["agents.yaml"]).toBe("version: 1");
    expect(layer["skills/s1.md"]).toBe("body");
    expect(layer["skills/skip.txt"]).toBeUndefined();
    expect(await dirStore(join(dir, "missing")).read()).toEqual({});
  });

  it("writes with dirs and deletes", async () => {
    const dir = await tmp();
    const store = dirStore(dir);
    await store.write("roles.yaml", "version: 2");
    expect(await readFile(join(dir, "roles.yaml"), "utf8")).toBe("version: 2");
    await store.delete("roles.yaml");
    expect(exists(join(dir, "roles.yaml"))).toBe(false);
    await store.delete("roles.yaml");
  });
});

describe("prepareConfig", () => {
  it("copies the config dir when lead is enabled", async () => {
    const src = await tmp();
    const dest = join(await tmp(), "cfg");
    await writeFile(join(src, "agents.yaml"), "version: 1\nitems: []");
    await prepareConfig(src, dest, false);
    expect(await readFile(join(dest, "agents.yaml"), "utf8")).toContain("version: 1");
    expect(exists(join(dest, "roles.yaml"))).toBe(false);
  });

  it("disables an existing lead and adds a missing one", async () => {
    const src = await tmp();
    const dest = join(await tmp(), "cfg");
    await writeFile(join(src, "roles.yaml"), "version: 1\nitems:\n  - id: lead\n    enabled: true\n    prompt: hi\n");
    await prepareConfig(src, dest, true);
    expect(await readFile(join(dest, "roles.yaml"), "utf8")).toContain("enabled: false");
    const dest2 = join(await tmp(), "cfg2");
    await prepareConfig(join(src, "nope"), dest2, true);
    const roles = await readFile(join(dest2, "roles.yaml"), "utf8");
    expect(roles).toContain("id: lead");
    expect(roles).toContain("enabled: false");
  });
});

describe("createWorkspace/removeWorkspace", () => {
  it("builds a real repo+state+config workspace and removes it", async () => {
    const cfgSrc = await tmp();
    await writeFile(join(cfgSrc, "agents.yaml"), "version: 1");
    const ws = await createWorkspace("t1", cfgSrc, true);
    dirs.push(ws.dir);
    expect(exists(join(ws.repo, ".git"))).toBe(true);
    expect(exists(ws.state)).toBe(true);
    expect(await readFile(join(ws.config, "roles.yaml"), "utf8")).toContain("enabled: false");
    expect(await readFile(join(ws.config, "agents.yaml"), "utf8")).toContain("version: 1");
    await removeWorkspace(ws);
    expect(exists(ws.dir)).toBe(false);
  });
});

describe("results", () => {
  const tr = (id: string, pass: boolean, kind: "question" | "edit" = "question", statusAgrees = true, cost = 0.01): TaskResult => ({
    id, kind, pass, evidence: pass ? "ok" : "bad", statusAgrees,
    turns: [{ runId: "r", status: pass ? "done" : "failed", reply: "x", costUsd: cost, durationMs: 100, escalations: pass ? [] : ["a->b"] }],
    durationMs: 100, costUsd: cost,
  });

  it("summarizes pass counts by kind with cost", () => {
    const s = summarize([tr("a", true, "question", true, 0.011), tr("b", false, "edit", false, 0.002), tr("c", true, "question")]);
    expect(s.passed).toBe(2);
    expect(s.total).toBe(3);
    expect(s.rate).toBeCloseTo(66.7);
    expect(s.statusAgrees).toBe(2);
    expect(s.escalated).toBe(1);
    expect(s.byKind.question).toEqual({ passed: 2, total: 2 });
    expect(s.byKind.edit).toEqual({ passed: 0, total: 1 });
    expect(s.costUsd).toBeCloseTo(0.023);
    expect(summarize([]).rate).toBe(0);
  });

  it("formats a table and writes a results file", async () => {
    const dir = await tmp();
    const r: ResultsFile = {
      label: "lbl", startedAt: "2026-11-12T10:00:00.000Z", commit: "abc123", config: "/x",
      summary: summarize([tr("t1", true), tr("t2", false, "edit", false)]),
      tasks: [tr("t1", true), tr("t2", false, "edit", false)],
    };
    const table = formatTable(r);
    expect(table).toContain("PASS");
    expect(table).toContain("FAIL");
    expect(table).toContain("lbl: 1/2");
    const file = await writeResults(dir, r);
    expect(file).toContain("2026-11-12-lbl.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.label).toBe("lbl");
    expect(parsed.tasks).toHaveLength(2);
  });
});

describe("main helpers", () => {
  it("loadDotEnv sets unset vars, strips quotes, and never overrides", async () => {
    const dir = await tmp();
    const envFile = join(dir, ".env");
    await writeFile(envFile, 'A="quoted"\nB=plain\n# comment\nBAD LINE\nC=\n');
    const env: Record<string, string | undefined> = { B: "kept" };
    loadDotEnv(envFile, env);
    expect(env.A).toBe("quoted");
    expect(env.B).toBe("kept");
    expect(env.C).toBe("");
    loadDotEnv(join(dir, "absent"), env);
  });

  it("selectTasks returns all, subsets, and rejects unknown ids", () => {
    const tasks = [
      { id: "a", kind: "question", turns: ["t"], check: async () => ({ pass: true, evidence: "" }) },
      { id: "b", kind: "edit", turns: ["t"], check: async () => ({ pass: true, evidence: "" }) },
    ] as EvalTask[];
    expect(selectTasks(undefined, tasks)).toHaveLength(2);
    expect(selectTasks("b", tasks).map((t) => t.id)).toEqual(["b"]);
    expect(selectTasks(" a, b ", tasks)).toHaveLength(2);
    expect(() => selectTasks("zzz", tasks)).toThrow("unknown task ids: zzz");
  });

  it("pool runs tasks with the injected runner and preserves order", async () => {
    const tasks = [
      { id: "a", kind: "question", turns: ["t"], check: async () => ({ pass: true, evidence: "" }) },
      { id: "b", kind: "question", turns: ["t"], check: async () => ({ pass: false, evidence: "no" }) },
    ] as EvalTask[];
    const seen: string[] = [];
    const out = await pool(tasks, 2, { config: "/x", disableLead: false, keep: "never" }, async (t) => {
      seen.push(t.id);
      return { id: t.id, kind: t.kind, pass: t.id === "a", evidence: "e", statusAgrees: true, turns: [], durationMs: 1, costUsd: 0 };
    });
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(out[0].pass).toBe(true);
  });

  it("main requires a label and writes results through the injected runner", async () => {
    await expect(main(["--only", "x"], async () => { throw new Error("n"); })).rejects.toThrow("usage:");
    const fake = async (t: EvalTask): Promise<TaskResult> => ({
      id: t.id, kind: t.kind, pass: true, evidence: "ok", statusAgrees: true, turns: [], durationMs: 1, costUsd: 0,
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      await main(["--label", "covtest", "--only", "q-list-docs", "--parallel", "0", "--keep", "never", "--skip-qualify"], fake);
    } finally {
      console.log = quiet;
    }
    const resDir = join(new URL("../", import.meta.url).pathname, "results");
    const { readdir } = await import("node:fs/promises");
    const mine = (await readdir(resDir)).filter((f) => f.endsWith("-covtest.json"));
    expect(mine).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(resDir, mine[0]), "utf8"));
    expect(parsed.label).toBe("covtest");
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.qualification).toBeUndefined();
    await rm(join(resDir, mine[0]), { force: true });
  });

  it("main qualifies first, runs tasks on the qualified config, records the rows and cleans up", async () => {
    const configs: string[] = [];
    let cleaned = 0;
    const fake = async (t: EvalTask, opts: { config: string }): Promise<TaskResult> => {
      configs.push(opts.config);
      return { id: t.id, kind: t.kind, pass: true, evidence: "ok", statusAgrees: true, turns: [], durationMs: 1, costUsd: 0 };
    };
    const rows = [{ agent: "a1", channel: "c", model: "m", agentQual: { passed: false, detail: "nope" } }];
    const qualify = async (src: string) => ({ config: `${src}-qualified`, rows, cleanup: async () => void cleaned++ });
    const quiet = console.log;
    console.log = () => {};
    try {
      await main(["--label", "covqual", "--only", "q-list-docs", "--config", "/cfg", "--keep", "never"], fake, qualify);
    } finally {
      console.log = quiet;
    }
    expect(configs).toEqual(["/cfg-qualified"]);
    expect(cleaned).toBe(1);
    const resDir = join(new URL("../", import.meta.url).pathname, "results");
    const { readdir } = await import("node:fs/promises");
    const mine = (await readdir(resDir)).filter((f) => f.endsWith("-covqual.json"));
    const parsed = JSON.parse(await readFile(join(resDir, mine[0]), "utf8"));
    expect(parsed.config).toBe("/cfg");
    expect(parsed.qualification).toEqual(rows);
    await rm(join(resDir, mine[0]), { force: true });
  });

  it("main cleans up the qualified config when the task pool throws", async () => {
    let cleaned = 0;
    const qualify = async () => ({ config: "/q", rows: [], cleanup: async () => void cleaned++ });
    const quiet = console.log;
    console.log = () => {};
    try {
      await expect(main(["--label", "covfail", "--only", "q-list-docs", "--config", "/cfg"], async () => { throw new Error("boom"); }, qualify)).rejects.toThrow("boom");
    } finally {
      console.log = quiet;
    }
    expect(cleaned).toBe(1);
  });
});
