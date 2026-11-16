import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Instance } from "../../src/swebench/instances.js";
import { main, pool } from "../../src/swebench/main.js";
import type { SweOpts, SweResult } from "../../src/swebench/run.js";
import { result, row } from "./helpers.js";

describe("swebench main", () => {
  let dir = "";
  let dataset = "";
  const quiet = console.log;
  const printed: string[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swe-main-"));
    dataset = join(dir, "d.jsonl");
    await writeFile(dataset, ["a__a-1", "b__b-2", "c__c-3"].map((id) => JSON.stringify(row({ instance_id: id }))).join("\n"));
    printed.length = 0;
    console.log = (s: string) => void printed.push(s);
  });
  afterEach(async () => {
    console.log = quiet;
    await rm(dir, { recursive: true, force: true });
  });

  const fakeRun = (seen: { id: string; opts: SweOpts }[]) => async (i: Instance, opts: SweOpts): Promise<SweResult> => {
    seen.push({ id: i.instance_id, opts });
    return result({ id: i.instance_id, status: i.instance_id === "b__b-2" ? "unresolved" : "resolved" });
  };

  it("requires --dataset and --label and refuses bad flag values", async () => {
    await expect(main(["--label", "x"])).rejects.toThrow("usage:");
    await expect(main(["--dataset", dataset])).rejects.toThrow("usage:");
    await expect(main(["--dataset", dataset, "--label", "x", "--keep", "sometimes"])).rejects.toThrow("usage:");
    await expect(main(["--dataset", dataset, "--label", "x", "--gold", "--no-patch"])).rejects.toThrow("usage:");
    await expect(main(["--dataset", dataset, "--label", "x", "--timeout-min", "0"])).rejects.toThrow("--timeout-min must be a positive number");
    await expect(main(["--dataset", dataset, "--label", "x", "--parallel", "abc"])).rejects.toThrow("--parallel must be a positive number");
  });

  it("gold run: skips qualification, runs the selected ids and writes per-instance results and predictions", async () => {
    const seen: { id: string; opts: SweOpts }[] = [];
    const qualify = async () => {
      throw new Error("must not qualify a gold run");
    };
    await main(["--dataset", dataset, "--label", "g", "--gold", "--only", "c__c-3,b__b-2", "--rmi", "--test-timeout-min", "5"], { run: fakeRun(seen), qualify, resultsDir: dir });
    expect(seen.map((s) => s.id)).toEqual(["c__c-3", "b__b-2"]);
    expect(seen[0].opts).toMatchObject({ patchSource: "gold", rmi: true, testTimeoutMin: 5, timeoutMin: 30, keep: "never" });
    expect(seen[0].opts.logDir.endsWith(join("results", "swebench-logs", "g"))).toBe(true);
    const files = await readdir(dir);
    const json = files.find((f) => f.endsWith("-swebench-g.json"))!;
    const parsed = JSON.parse(await readFile(join(dir, json), "utf8"));
    expect(parsed.summary).toMatchObject({ resolved: 1, unresolved: 1, total: 2 });
    expect(parsed.instances.map((i: { id: string }) => i.id)).toEqual(["c__c-3", "b__b-2"]);
    expect(parsed.dataset).toBe(dataset);
    expect(parsed.qualification).toBeUndefined();
    expect(files.some((f) => f.endsWith("-swebench-g.predictions.jsonl"))).toBe(true);
    expect(printed.join("\n")).toContain("g: resolved 1/2 (50%), unresolved 1, harness errors 0");
  });

  it("lead run: qualifies first, runs on the qualified config, records the rows and cleans up", async () => {
    const seen: { id: string; opts: SweOpts }[] = [];
    let cleaned = 0;
    const rows = [{ agent: "a1", channel: "c", model: "m", agentQual: { passed: true, detail: "ok" } }];
    const qualify = async (src: string) => ({ config: `${src}-qualified`, rows, cleanup: async () => void cleaned++ });
    await main(["--dataset", dataset, "--label", "l", "--only", "a__a-1", "--config", "/cfg", "--keep", "failed"], { run: fakeRun(seen), qualify, resultsDir: dir });
    expect(seen[0].opts).toMatchObject({ config: "/cfg-qualified", patchSource: "lead", keep: "failed" });
    expect(cleaned).toBe(1);
    const json = (await readdir(dir)).find((f) => f.endsWith("-swebench-l.json"))!;
    const parsed = JSON.parse(await readFile(join(dir, json), "utf8"));
    expect(parsed.config).toBe("/cfg");
    expect(parsed.qualification).toEqual(rows);
  });

  it("--no-patch and --skip-qualify both skip qualification", async () => {
    const seen: { id: string; opts: SweOpts }[] = [];
    const qualify = async () => {
      throw new Error("must not qualify");
    };
    await main(["--dataset", dataset, "--label", "n", "--no-patch", "--only", "a__a-1"], { run: fakeRun(seen), qualify, resultsDir: dir });
    await main(["--dataset", dataset, "--label", "s", "--skip-qualify", "--only", "a__a-1"], { run: fakeRun(seen), qualify, resultsDir: dir });
    expect(seen.map((s) => s.opts.patchSource)).toEqual(["none", "lead"]);
  });

  it("cleans up the qualified config when a run throws, and refuses unknown ids before running", async () => {
    let cleaned = 0;
    const qualify = async () => ({ config: "/q", rows: [], cleanup: async () => void cleaned++ });
    const boom = async (): Promise<SweResult> => {
      throw new Error("boom");
    };
    await expect(main(["--dataset", dataset, "--label", "f", "--only", "a__a-1"], { run: boom, qualify, resultsDir: dir })).rejects.toThrow("boom");
    expect(cleaned).toBe(1);
    await expect(main(["--dataset", dataset, "--label", "f", "--only", "zzz"], { run: boom, qualify, resultsDir: dir })).rejects.toThrow("instance ids not in the dataset: zzz");
    expect(cleaned).toBe(1);
  });

  it("pool keeps input order under parallelism and prints one row per instance", async () => {
    const instances = ["a", "b", "c", "d"].map((id) => ({ instance_id: id }) as Instance);
    const out = await pool(instances, 3, async (i) => {
      await new Promise((r) => setTimeout(r, i.instance_id === "a" ? 20 : 1));
      return result({ id: i.instance_id });
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(printed).toHaveLength(4);
  });
});
