import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRepo, nodeExec, pullImage, recordExitCode, removeImage, runEval, RUN_SH, writeEvalDir, type Exec, type ExecResult } from "../../src/swebench/docker.js";

const ok = (out = ""): ExecResult => ({ code: 0, out, timedOut: false });
const ID = "a".repeat(64);

function fakeExec(reply: (argv: string[]) => ExecResult): { exec: Exec; calls: string[][]; timeouts: (number | undefined)[] } {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    calls,
    timeouts,
    exec: async (argv, opts) => {
      calls.push(argv);
      timeouts.push(opts?.timeoutMs);
      return reply(argv);
    },
  };
}

describe("swebench docker", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("nodeExec collects stdout and stderr and the exit code", async () => {
    const r = await nodeExec([process.execPath, "-e", "console.log('out');console.error('err');process.exit(3)"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
    expect(r.timedOut).toBe(false);
  });

  it("nodeExec kills on timeout and reports a binary that cannot start", async () => {
    const slow = await nodeExec([process.execPath, "-e", "setTimeout(()=>{},60000)"], { timeoutMs: 100 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBe(-1);
    const missing = await nodeExec(["stewart-no-such-binary-xyz"]);
    expect(missing.code).toBe(-1);
    expect(missing.out).toContain("cannot start stewart-no-such-binary-xyz");
  });

  it("pullImage skips the pull when the image is present", async () => {
    const f = fakeExec(() => ok());
    await pullImage(f.exec, "img:latest");
    expect(f.calls).toEqual([["docker", "image", "inspect", "img:latest"]]);
  });

  it("pullImage pulls a missing image for linux/amd64 and fails with docker's message", async () => {
    const f = fakeExec((a) => (a[1] === "image" ? { code: 1, out: "No such image", timedOut: false } : ok()));
    await pullImage(f.exec, "img:latest");
    expect(f.calls[1]).toEqual(["docker", "pull", "-q", "--platform", "linux/amd64", "img:latest"]);
    const bad = fakeExec(() => ({ code: 1, out: "manifest unknown", timedOut: false }));
    await expect(pullImage(bad.exec, "img:latest")).rejects.toThrow("docker pull -q failed (1): manifest unknown");
    const slow = fakeExec((a) => ({ code: a[1] === "image" ? 1 : -1, out: "", timedOut: a[1] !== "image" }));
    await expect(pullImage(slow.exec, "img:latest")).rejects.toThrow("(timeout)");
  });

  it("extractRepo copies /testbed out of a created container and always removes it", async () => {
    const f = fakeExec((a) => (a[1] === "create" ? ok(`WARNING: platform\n${ID}\n`) : ok()));
    await extractRepo(f.exec, "img", "/dest/repo");
    expect(f.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["docker create", "docker cp", "docker rm"]);
    expect(f.calls[1]).toEqual(["docker", "cp", `${ID}:/testbed`, "/dest/repo"]);
    const failing = fakeExec((a) => (a[1] === "create" ? ok(ID) : a[1] === "cp" ? { code: 1, out: "no space left", timedOut: false } : ok()));
    await expect(extractRepo(failing.exec, "img", "/dest/repo")).rejects.toThrow("no space left");
    expect(failing.calls.at(-1)).toEqual(["docker", "rm", "-f", ID]);
  });

  it("extractRepo fails when docker create prints no container id", async () => {
    const f = fakeExec(() => ok("something else"));
    await expect(extractRepo(f.exec, "img", "/d")).rejects.toThrow("docker create printed no container id");
  });

  it("recordExitCode captures the test command status before the end marker", () => {
    const script = "#!/bin/bash\n: '>>>>> Start Test Output'\npytest -rA t.py\n: '>>>>> End Test Output'\ngit checkout abc t.py\n";
    expect(recordExitCode(script)).toBe(
      "#!/bin/bash\n: '>>>>> Start Test Output'\npytest -rA t.py\nSWEBENCH_TEST_EXIT_CODE=$?\n: '>>>>> End Test Output'\necho \">>>>> Test Exit Code: $SWEBENCH_TEST_EXIT_CODE\"\ngit checkout abc t.py\n",
    );
    expect(recordExitCode("echo no markers\n")).toBe("echo no markers\n");
  });

  it("writeEvalDir writes the patch, the eval script and the driver; an empty patch stays empty", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "swe-eval-")), "x");
    dirs.push(dir);
    await writeEvalDir(dir, "diff --git a/f b/f", ": '>>>>> End Test Output'");
    expect(await readFile(join(dir, "patch.diff"), "utf8")).toBe("diff --git a/f b/f\n");
    expect(await readFile(join(dir, "eval.sh"), "utf8")).toContain("SWEBENCH_TEST_EXIT_CODE=$?");
    expect(await readFile(join(dir, "run.sh"), "utf8")).toBe(RUN_SH);
    await writeEvalDir(dir, "", "x");
    expect(await readFile(join(dir, "patch.diff"), "utf8")).toBe("");
  });

  it("the driver skips git apply for an empty patch and marks a patch that cannot apply", () => {
    expect(RUN_SH).toContain("if [ -s /stewart/patch.diff ]; then");
    expect(RUN_SH).toContain('echo ">>>>> Patch Apply Failed"; exit 0;');
    expect(RUN_SH.trimEnd().endsWith("/bin/bash /stewart/eval.sh")).toBe(true);
  });

  it("runEval mounts the eval dir read-only and returns the output", async () => {
    const f = fakeExec(() => ({ code: 1, out: "log text", timedOut: false }));
    const out = await runEval(f.exec, { image: "img", dir: "/tmp/e", name: "n1", timeoutMs: 5000 });
    expect(out).toBe("log text");
    expect(f.calls[0]).toEqual(["docker", "run", "--rm", "--platform", "linux/amd64", "--name", "n1", "-v", "/tmp/e:/stewart:ro", "img", "/bin/bash", "/stewart/run.sh"]);
    expect(f.timeouts[0]).toBe(5000);
  });

  it("runEval removes the container on timeout and appends the timeout marker", async () => {
    const f = fakeExec((a) => (a[1] === "run" ? { code: -1, out: "partial", timedOut: true } : ok()));
    const out = await runEval(f.exec, { image: "img", dir: "/tmp/e", name: "n2", timeoutMs: 2000 });
    expect(out).toBe("partial\n\n>>>>> Tests Timed Out: 2 seconds exceeded.");
    expect(f.calls[1]).toEqual(["docker", "rm", "-f", "n2"]);
  });

  it("runEval throws when docker itself cannot run the container", async () => {
    const f = fakeExec(() => ({ code: 125, out: "docker: Cannot connect to the Docker daemon", timedOut: false }));
    await expect(runEval(f.exec, { image: "img", dir: "/tmp/e", name: "n3", timeoutMs: 1 })).rejects.toThrow("docker run failed: docker: Cannot connect");
  });

  it("removeImage force-removes the image", async () => {
    const f = fakeExec(() => ok());
    await removeImage(f.exec, "img");
    expect(f.calls).toEqual([["docker", "rmi", "-f", "img"]]);
  });
});
