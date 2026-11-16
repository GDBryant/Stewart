import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APPLY_PATCH_FAIL, END_TEST_OUTPUT, TESTS_TIMEOUT, TEST_EXIT_CODE } from "./grade.js";

export interface ExecResult {
  code: number;
  out: string;
  timedOut: boolean;
}

export type Exec = (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

const MAX_OUT = 64 * 1024 * 1024;
const PLATFORM = "linux/amd64";
const PULL_TIMEOUT_MS = 60 * 60_000;
const SHORT_TIMEOUT_MS = 10 * 60_000;

export const nodeExec: Exec = (argv, opts) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const add = (d: Buffer) => {
      if (out.length < MAX_OUT) out += d.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts?.timeoutMs ?? SHORT_TIMEOUT_MS);
    const finish = (code: number, extra = "") => {
      clearTimeout(timer);
      resolve({ code, out: out + extra, timedOut });
    };
    child.on("error", (e) => finish(-1, `cannot start ${argv[0]}: ${e.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });

async function must(exec: Exec, argv: string[], timeoutMs = SHORT_TIMEOUT_MS): Promise<string> {
  const r = await exec(argv, { timeoutMs });
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (${r.timedOut ? "timeout" : r.code}): ${r.out.trim().slice(-400)}`);
  return r.out;
}

export async function pullImage(exec: Exec, image: string): Promise<void> {
  if ((await exec(["docker", "image", "inspect", image])).code === 0) return;
  await must(exec, ["docker", "pull", "-q", "--platform", PLATFORM, image], PULL_TIMEOUT_MS);
}

export async function removeImage(exec: Exec, image: string): Promise<void> {
  await exec(["docker", "rmi", "-f", image]);
}

export async function extractRepo(exec: Exec, image: string, dest: string): Promise<void> {
  const created = await must(exec, ["docker", "create", "--platform", PLATFORM, image]);
  const id = /^[0-9a-f]{64}$/m.exec(created)?.[0];
  if (!id) throw new Error(`docker create printed no container id: ${created.trim().slice(-200)}`);
  try {
    await must(exec, ["docker", "cp", `${id}:/testbed`, dest]);
  } finally {
    await exec(["docker", "rm", "-f", id]);
  }
}

export function recordExitCode(evalScript: string): string {
  const lines = evalScript.split("\n");
  const i = lines.findIndex((l) => l.includes(END_TEST_OUTPUT));
  if (i < 0) return evalScript;
  return [...lines.slice(0, i), "SWEBENCH_TEST_EXIT_CODE=$?", lines[i], `echo "${TEST_EXIT_CODE}: $SWEBENCH_TEST_EXIT_CODE"`, ...lines.slice(i + 1)].join("\n");
}

export const RUN_SH = `cd /testbed || { echo "${APPLY_PATCH_FAIL}: no /testbed"; exit 0; }
apply() { git apply --verbose "$@" /stewart/patch.diff; }
reset() { git checkout -- . ; git clean -fd; }
if [ -s /stewart/patch.diff ]; then
  apply || { reset; apply --3way; } || { reset; apply --reject; } || git apply --check --reverse /stewart/patch.diff || { echo "${APPLY_PATCH_FAIL}"; exit 0; }
fi
/bin/bash /stewart/eval.sh
`;

export async function writeEvalDir(dir: string, patch: string, evalScript: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "patch.diff"), patch === "" || patch.endsWith("\n") ? patch : `${patch}\n`);
  await writeFile(join(dir, "eval.sh"), recordExitCode(evalScript));
  await writeFile(join(dir, "run.sh"), RUN_SH);
}

export interface EvalRun {
  image: string;
  dir: string;
  name: string;
  timeoutMs: number;
}

export async function runEval(exec: Exec, r: EvalRun): Promise<string> {
  const argv = ["docker", "run", "--rm", "--platform", PLATFORM, "--name", r.name, "-v", `${r.dir}:/stewart:ro`, r.image, "/bin/bash", "/stewart/run.sh"];
  const res = await exec(argv, { timeoutMs: r.timeoutMs });
  if (res.code === 125) throw new Error(`docker run failed: ${res.out.trim().slice(-400)}`);
  if (!res.timedOut) return res.out;
  await exec(["docker", "rm", "-f", r.name]);
  return `${res.out}\n\n${TESTS_TIMEOUT}: ${r.timeoutMs / 1000} seconds exceeded.`;
}
