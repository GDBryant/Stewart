import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { row } from "./helpers.js";
import { loadInstances, parseInstance, selectInstances, SUBSET_20, type Instance } from "../../src/swebench/instances.js";

describe("swebench instances", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("parses a row, keeps only the fields it uses and accepts JSON-string id lists", () => {
    const i = parseInstance(row({ FAIL_TO_PASS: '["test_a (m.T)", "Named URLs should be reversible"]' }), "f:1");
    expect(i.FAIL_TO_PASS).toEqual(["test_a (m.T)", "Named URLs should be reversible"]);
    expect(i.PASS_TO_PASS).toHaveLength(1);
    expect(i.log_parser).toBe("parse_log_django");
    expect(i).not.toHaveProperty("difficulty");
  });

  it("refuses a row without eval_script and names the dataset to use", () => {
    const r = row();
    delete r.eval_script;
    expect(() => parseInstance(r, "f:3")).toThrow("f:3: missing eval_script; use the SWE-bench/SWE-bench_Verified export");
    expect(() => parseInstance(row({ image: "" }), "f:4")).toThrow("missing image");
  });

  it("refuses id lists that are not string lists", () => {
    expect(() => parseInstance(row({ PASS_TO_PASS: '{"a":1}' }), "f:1")).toThrow("PASS_TO_PASS is not a list of test ids");
    expect(() => parseInstance(row({ FAIL_TO_PASS: [1] }), "f:1")).toThrow("FAIL_TO_PASS is not a list of test ids");
  });

  it("loads JSONL, skipping blank lines, and reports the line of a bad row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swe-inst-"));
    dirs.push(dir);
    const good = join(dir, "good.jsonl");
    await writeFile(good, `${JSON.stringify(row())}\n\n${JSON.stringify(row({ instance_id: "sympy__sympy-1" }))}\n`);
    expect((await loadInstances(good)).map((i) => i.instance_id)).toEqual(["django__django-11099", "sympy__sympy-1"]);
    const bad = join(dir, "bad.jsonl");
    await writeFile(bad, `${JSON.stringify(row())}\n${JSON.stringify(row({ repo: 3 }))}\n`);
    await expect(loadInstances(bad)).rejects.toThrow(`${bad}:2: missing repo`);
  });

  it("selects the fixed subset by default, explicit ids in the order given, or all", () => {
    const all = ["a", "b", "c"].map((id) => parseInstance(row({ instance_id: id }), "x")) as Instance[];
    expect(selectInstances(all, undefined, ["c", "a"]).map((i) => i.instance_id)).toEqual(["c", "a"]);
    expect(selectInstances(all, "b, a").map((i) => i.instance_id)).toEqual(["b", "a"]);
    expect(selectInstances(all, "all").map((i) => i.instance_id)).toEqual(["a", "b", "c"]);
  });

  it("refuses ids that are not in the dataset", () => {
    const all = [parseInstance(row(), "x")];
    expect(() => selectInstances(all, "nope,django__django-11099")).toThrow("instance ids not in the dataset: nope");
    expect(() => selectInstances(all, undefined, ["missing-1"])).toThrow("missing-1");
  });

  it("the fixed subset has 20 distinct ids", () => {
    expect(new Set(SUBSET_20).size).toBe(20);
  });
});
