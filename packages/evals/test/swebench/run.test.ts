import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@stewart/protocol";
import { sh } from "../../src/kit.js";
import { EventLog, type RunOpts } from "../../src/runner.js";
import type { Exec, ExecResult } from "../../src/swebench/docker.js";
import { parseInstance } from "../../src/swebench/instances.js";
import { baseline, diffSince, prompt, runInstance, type SweOpts } from "../../src/swebench/run.js";
import type { Workspace } from "../../src/workspace.js";
import { row } from "./helpers.js";

const GOLD_LOG = readFileSync(new URL("./fixtures/django-11099-gold.txt", import.meta.url), "utf8");
const FAIL_LOG = readFileSync(new URL("./fixtures/django-11119-nopatch.txt", import.meta.url), "utf8");
const ID = "b".repeat(64);
const ok = (out = ""): ExecResult => ({ code: 0, out, timedOut: false });
const GIT = "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false";

const inst = parseInstance(row(), "t");
const failing = parseInstance(
  row({ instance_id: "django__django-11119", FAIL_TO_PASS: ["test_autoescape_off (template_tests.test_engine.RenderToStringTest)"], PASS_TO_PASS: ["test_origin (template_tests.test_engine.LoaderTests)"] }),
  "t",
);

interface Fake {
  exec: Exec;
  calls: string[][];
  patches: string[];
}

function fakeDocker(log: string, over: (argv: string[]) => ExecResult | undefined = () => undefined): Fake {
  const calls: string[][] = [];
  const patches: string[] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    const forced = over(argv);
    if (forced) return forced;
    if (argv[1] === "create") return ok(`${ID}\n`);
    if (argv[1] === "cp") {
      await mkdir(argv[3], { recursive: true });
      await writeFile(join(argv[3], "validators.py"), "regex = r'^[\\w.@+-]+$'\n");
      await writeFile(join(argv[3], "setup.py"), "version = 1\n");
      await sh(`git init -q -b main && ${GIT} add -A && ${GIT} commit -q -m SWE-bench && echo dirty >> setup.py`, { cwd: argv[3] });
    }
    if (argv[1] === "run") {
      patches.push(await readFile(join(argv[argv.indexOf("-v") + 1].split(":")[0], "patch.diff"), "utf8"));
      return ok(log);
    }
    return ok();
  };
  return { exec, calls, patches };
}

const fakeStart = (edit: (repo: string) => Promise<void>, status = "done", error?: string) =>
  async (ws: Workspace, _opts: RunOpts) => {
    const log = new EventLog();
    const dispatch = async (m: string) => {
      if (m === "chat.send") {
        await edit(ws.repo);
        setTimeout(() => log.push({ kind: "run.finished", runId: "run-x", status, error } as RunEvent), 5);
        return { runId: "run-x" };
      }
      if (m === "history.load") return { messages: [{ role: "assistant", content: "fixed" }] };
      return {};
    };
    log.dispatch = dispatch;
    return { log, dispatch };
  };

const fixIt = async (repo: string): Promise<void> => {
  await writeFile(join(repo, "validators.py"), "regex = r'^[\\w.@+-]+\\Z'\n");
  await mkdir(join(repo, ".stewart"), { recursive: true });
  await writeFile(join(repo, ".stewart", "plan.md"), "plan\n");
  await writeFile(join(repo, "notes.txt"), "new file\n");
};

describe("swebench runInstance", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const opts = async (over: Partial<SweOpts> = {}): Promise<SweOpts> => {
    const dir = await mkdtemp(join(tmpdir(), "swe-run-"));
    dirs.push(dir);
    return { config: join(dir, "cfg"), disableLead: false, keep: "never", patchSource: "lead", timeoutMin: 1, testTimeoutMin: 1, rmi: false, logDir: join(dir, "logs"), ...over };
  };

  it("gold: scores the dataset patch without extracting a repo or running the lead", async () => {
    const d = fakeDocker(GOLD_LOG);
    const o = await opts({ patchSource: "gold" });
    const r = await runInstance(inst, o, { exec: d.exec, startCore: () => Promise.reject(new Error("lead must not run")) });
    expect(r.status).toBe("resolved");
    expect(d.patches).toEqual([inst.patch]);
    expect(d.calls.map((c) => c[1])).toEqual(["image", "run"]);
    expect(r.patch).toBe(inst.patch);
    expect(r.turn).toBeUndefined();
    expect(await readFile(join(o.logDir, "django__django-11099.log"), "utf8")).toBe(GOLD_LOG);
    expect(r.log).toBe(join(o.logDir, "django__django-11099.log"));
  });

  it("none: runs the tests with an empty patch file", async () => {
    const d = fakeDocker(FAIL_LOG);
    const r = await runInstance(failing, await opts({ patchSource: "none" }), { exec: d.exec });
    expect(d.patches).toEqual([""]);
    expect(r.status).toBe("unresolved");
    expect(r.failed).toEqual(failing.FAIL_TO_PASS);
    expect(r.patch).toBe("");
  });

  it("lead: scores the diff of what the run changed, without harness dirs or the image's own dirty files", async () => {
    const d = fakeDocker(GOLD_LOG);
    const seen: string[] = [];
    const start = fakeStart(async (repo) => {
      seen.push((await sh("git status --porcelain", { cwd: repo })).out);
      await fixIt(repo);
    });
    const r = await runInstance(inst, await opts({ rmi: true }), { exec: d.exec, startCore: start });
    expect(seen).toEqual([""]);
    expect(r.status).toBe("resolved");
    expect(r.turn?.status).toBe("done");
    expect(r.patch).toContain("+regex = r'^[\\w.@+-]+\\Z'");
    expect(r.patch).toContain("b/notes.txt");
    expect(r.patch).not.toContain(".stewart");
    expect(r.patch).not.toContain("setup.py");
    expect(d.patches).toEqual([r.patch]);
    expect(r.workspace).toBeUndefined();
    expect(d.calls.at(-1)).toEqual(["docker", "rmi", "-f", inst.image]);
    const cp = d.calls.find((c) => c[1] === "cp")!;
    expect(existsSync(cp[3])).toBe(false);
  });

  it("lead: sends the problem statement and says the tests cannot be run locally", async () => {
    expect(prompt(inst)).toContain("UsernameValidator allows trailing newline in usernames");
    expect(prompt(inst)).toContain("do not try to run its test suite");
  });

  it("lead: a run that changes nothing is unresolved without running the tests", async () => {
    const d = fakeDocker(GOLD_LOG);
    const r = await runInstance(inst, await opts(), { exec: d.exec, startCore: fakeStart(async () => {}, "failed") });
    expect(r).toMatchObject({ status: "unresolved", reason: "empty patch: the run changed no file", patch: "" });
    expect(r.turn?.status).toBe("failed");
    expect(d.calls.some((c) => c[1] === "run")).toBe(false);
    const noAgent = await runInstance(inst, await opts(), { exec: d.exec, startCore: fakeStart(async () => {}, "failed", "no qualified agent for role lead") });
    expect(noAgent.reason).toBe("empty patch: the run changed no file (run no qualified agent for role lead)");
  });

  it("lead: keeps the workspace of an unresolved instance when keep=failed, removes a resolved one", async () => {
    const d = fakeDocker(FAIL_LOG);
    const r = await runInstance(failing, await opts({ keep: "failed" }), { exec: d.exec, startCore: fakeStart(fixIt) });
    expect(r.status).toBe("unresolved");
    expect(r.workspace && existsSync(join(r.workspace, "repo", "validators.py"))).toBe(true);
    dirs.push(r.workspace!);
    const good = await runInstance(inst, await opts({ keep: "failed" }), { exec: fakeDocker(GOLD_LOG).exec, startCore: fakeStart(fixIt) });
    expect(good.workspace).toBeUndefined();
    const always = await runInstance(inst, await opts({ keep: "always" }), { exec: fakeDocker(GOLD_LOG).exec, startCore: fakeStart(fixIt) });
    expect(always.workspace).toBeTruthy();
    dirs.push(always.workspace!);
  });

  it("reports a pull failure as a harness error", async () => {
    const d = fakeDocker(GOLD_LOG, (a) => (a[1] === "image" || a[1] === "pull" ? { code: 1, out: "manifest unknown", timedOut: false } : undefined));
    const r = await runInstance(inst, await opts({ patchSource: "gold" }), { exec: d.exec });
    expect(r.status).toBe("error");
    expect(r.reason).toContain("manifest unknown");
    expect(r.f2p).toEqual({ passed: 0, total: 0 });
  });

  it("reports an extract failure as a harness error and leaves no workspace", async () => {
    const d = fakeDocker(GOLD_LOG, (a) => (a[1] === "cp" ? { code: 1, out: "no space left on device", timedOut: false } : undefined));
    const r = await runInstance(inst, await opts({ keep: "always" }), { exec: d.exec, startCore: fakeStart(fixIt) });
    expect(r.status).toBe("error");
    expect(r.reason).toContain("no space left on device");
    expect(r.workspace).toBeUndefined();
    expect(r.turn).toBeUndefined();
  });

  it("reports a docker run failure as a harness error and a non-Error throw as text", async () => {
    const d = fakeDocker(GOLD_LOG, (a) => (a[1] === "run" ? { code: 125, out: "daemon not running", timedOut: false } : undefined));
    const r = await runInstance(inst, await opts({ patchSource: "gold" }), { exec: d.exec });
    expect(r).toMatchObject({ status: "error", reason: "docker run failed: daemon not running" });
    const thrower: Exec = () => Promise.reject("plain string");
    expect((await runInstance(inst, await opts({ patchSource: "gold" }), { exec: thrower })).reason).toBe("plain string");
  });
});

describe("swebench baseline/diffSince", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("diffs against the baseline even when the run committed, and the patch applies to a copy of the baseline tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swe-diff-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "a.py"), "x = 1\n");
    await sh(`git init -q -b main && ${GIT} add -A && ${GIT} commit -q -m base && echo 'y = 2' > untracked.py`, { cwd: repo });
    const base = await baseline(repo);
    await sh(`cp -r repo copy`, { cwd: dir });
    await writeFile(join(repo, "a.py"), "x = 3\n");
    await sh(`${GIT} add -A && ${GIT} commit -q -m "model commit"`, { cwd: repo });
    await writeFile(join(repo, "untracked.py"), "y = 4\n");
    const patch = await diffSince(repo, base, join(dir, "model.patch"));
    expect(patch).toContain("+x = 3");
    expect(patch).toContain("+y = 4");
    const applied = await sh(`git apply --verbose ../model.patch && cat a.py untracked.py`, { cwd: join(dir, "copy") });
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("x = 3\ny = 4");
  });

  it("fails with git's message on a directory that is not a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swe-nogit-"));
    dirs.push(dir);
    await expect(baseline(dir)).rejects.toThrow(/git add -A failed/);
  });
});
